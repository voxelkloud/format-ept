// Identify and open an EPT dataset.
//
// One `ept.json` describes the whole thing — for `binary` and `zstandard` that
// is the entire load. For `laszip` there is a second request, and it is not
// avoidable: the manifest's schema and the LAS records Entwine actually writes
// disagree about types (its `ScanAngleRank` is a 4-byte float in the schema and
// a signed byte in the record), so the root node's own header is read and
// believed instead.

import { VoxelkloudError } from "@voxelkloud/core";
import type { LoadSourceOptions, PointCloudTransport } from "@voxelkloud/core";
import { lasLayout } from "@voxelkloud/format-las";
import { initLazCodec, readLasHeader } from "@voxelkloud/wasm-codecs";
import { eptCrs, eptLayout } from "./attributes.js";
import { parseEptManifest } from "./manifest.js";
import type { EptManifest } from "./manifest.js";
import type { EptSource, EptSourceWarningCode, EptWarning } from "./types.js";

/** The `LASF_Spec` Extra Bytes VLR, which Entwine writes for custom dimensions. */
const EXTRA_BYTES_USER_ID = "LASF_Spec";
const EXTRA_BYTES_RECORD_ID = 4;

/** Enough of a node file to hold a LAS header and its VLR directory. */
const NODE_HEAD_BYTES = 8192;

const defaultFetch = (input: string, init?: RequestInit): Promise<Response> =>
  globalThis.fetch(input, init);

/** Both accepted inputs: the directory, or `ept.json` itself. */
export function resolveEptUrls(input: string): {
  base: string;
  manifest: string;
} {
  const url = new URL(input);
  const path = url.pathname;
  if (path.endsWith("/ept.json")) {
    const base = new URL(".", url).href;
    return { base, manifest: url.href };
  }
  const base = path.endsWith("/") ? url.href : `${url.href}/`;
  return { base, manifest: new URL("ept.json", base).href };
}

async function fetchText(
  transport: PointCloudTransport,
  url: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  let res: Response;
  try {
    res = await transport.fetch(url, { ...transport.requestInit, signal });
  } catch (cause) {
    if (
      cause instanceof Error &&
      (cause.name === "AbortError" || cause.name === "TimeoutError")
    ) {
      throw cause;
    }
    throw new VoxelkloudError("network-error", `Network error fetching ${url}.`, {
      url,
      cause,
    });
  }
  if (!res.ok) {
    throw new VoxelkloudError(
      "http-error",
      `GET ${url} failed: HTTP ${res.status} ${res.statusText}.`,
      { url, status: res.status },
    );
  }
  return res.text();
}

/**
 * Read the root node's LAS header, for a `laszip` dataset.
 *
 * A ranged read where the host allows it, the whole file where it does not —
 * EPT is served as static files and Range support is not part of its contract,
 * so a 200 with the whole node is a normal answer here rather than the
 * misconfiguration it would be for COPC.
 */
async function readRootNodeHeader(
  transport: PointCloudTransport,
  baseUrl: string,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const url = `${baseUrl}ept-data/0-0-0-0.laz`;
  const headers = new Headers(transport.requestInit?.headers);
  headers.set("Range", `bytes=0-${NODE_HEAD_BYTES - 1}`);
  let res: Response;
  try {
    res = await transport.fetch(url, { ...transport.requestInit, headers, signal });
  } catch (cause) {
    if (
      cause instanceof Error &&
      (cause.name === "AbortError" || cause.name === "TimeoutError")
    ) {
      throw cause;
    }
    throw new VoxelkloudError("network-error", `Network error fetching ${url}.`, {
      url,
      cause,
    });
  }
  if (!res.ok) {
    throw new VoxelkloudError(
      "http-error",
      `GET ${url} failed: HTTP ${res.status} ${res.statusText}. The root node ` +
        `of a laszip EPT dataset must exist — its header is what says how the ` +
        `records are laid out.`,
      { url, status: res.status },
    );
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Load an EPT dataset's manifest and build its source.
 *
 * @throws {VoxelkloudError} `"invalid-metadata"` for a manifest that cannot
 *   address a node, plus whatever the transport throws.
 */
export async function loadEptSource(
  input: string | URL,
  options: LoadSourceOptions = {},
): Promise<EptSource> {
  const { base, manifest: manifestUrl } = resolveEptUrls(
    input instanceof URL ? input.href : input,
  );
  const transport: PointCloudTransport = {
    fetch: options.fetch ?? defaultFetch,
    requestInit: options.requestInit,
  };

  // The engine already fetched this while identifying the format; fetching it
  // again would cost every load a duplicate round trip.
  let json: unknown;
  if (options.probe?.url === manifestUrl && options.probe.json !== undefined) {
    json = options.probe.json;
  } else {
    const text = await fetchText(transport, manifestUrl, options.signal);
    try {
      json = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (cause) {
      throw new VoxelkloudError(
        "invalid-json",
        `${manifestUrl} is not valid JSON.`,
        { url: manifestUrl, cause },
      );
    }
  }

  const manifest: EptManifest = parseEptManifest(json, manifestUrl);

  const warnings: EptWarning[] = [];
  const emitted = new Set<EptSourceWarningCode>();
  const warn = (
    code: EptSourceWarningCode,
    path: string,
    message: string,
  ): void => {
    if (emitted.has(code)) return;
    emitted.add(code);
    warnings.push({ code, path, message });
  };

  // The schema layout is built either way: for `laszip` it is the fallback if
  // the node header cannot be read, and it is where X/Y/Z's scale and offset
  // come from in every case.
  const fromSchema = eptLayout(manifest.schema, manifest.boundsConforming);
  for (const w of fromSchema.warnings) warn(w.code, w.path, w.message);

  let layout = fromSchema.layout;
  let scale = fromSchema.scale;
  let offset = fromSchema.offset;

  if (manifest.dataType === "laszip") {
    await initLazCodec();
    const head = await readRootNodeHeader(transport, base, options.signal);
    const header = readLasHeader(head);
    try {
      if (!header.vlrsComplete) {
        warn(
          "laszip-header-unreadable",
          "ept-data/0-0-0-0.laz",
          `The root node's VLR directory did not fit in the first ` +
            `${NODE_HEAD_BYTES} bytes, so any Extra Bytes dimensions it ` +
            `declares are missing from the attribute list.`,
        );
      }
      const extraVlr = header.findVlr(EXTRA_BYTES_USER_ID, EXTRA_BYTES_RECORD_ID);
      const extraBytes = extraVlr?.data;
      extraVlr?.free();

      const fromLas = lasLayout({
        format: header.pointFormat,
        pointSize: header.pointSize,
        ...(extraBytes !== undefined ? { extraBytes } : {}),
        bounds: manifest.boundsConforming,
      });
      for (const w of fromLas.warnings) warn(w.code, w.path, w.message);
      layout = fromLas;
      // The node's own header is authoritative about quantisation too. Entwine
      // writes the schema's values here, and a file where they differ would
      // otherwise decode every coordinate to the wrong place.
      scale = [header.scale[0]!, header.scale[1]!, header.scale[2]!];
      offset = [header.offset[0]!, header.offset[1]!, header.offset[2]!];
    } finally {
      header.free();
    }
  }

  const attributes = layout.attributes.map((a) => a.attribute);
  const attributesByName = new Map(
    layout.attributes.map((a) => [a.attribute.name, a.attribute] as const),
  );

  return Object.freeze<EptSource>({
    baseUrl: base,
    ...(eptCrs(manifest) !== undefined ? { crs: eptCrs(manifest)! } : {}),
    manifest,
    layout,
    scale,
    offset,
    attributes,
    attributesByName,
    bounds: manifest.bounds,
    tightBoundingBox: manifest.boundsConforming,
    pointCount: manifest.points,
    warnings,
    transport,
  });
}
