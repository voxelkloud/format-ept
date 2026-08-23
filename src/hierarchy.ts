// EPT hierarchy pages: one JSON object per page, `"D-X-Y-Z": count`.
//
// A count of -1 means the subtree at that key continues in
// `ept-hierarchy/D-X-Y-Z.json`. That is the same page model COPC spells with a
// -1 point count and Potree spells with a proxy chunk, so the tree itself is
// core's and this file is a parser.

import { VoxelkloudError, createPagedOctree } from "@voxelkloud/core";
import type { OctreePage, PagedOctree, PointCloudTransport } from "@voxelkloud/core";
import type { EptNodePayload, EptPageRef, EptSource } from "./types.js";

/** `"3-1-0-2"` — the spelling EPT uses in both keys and filenames. */
const KEY = /^(\d+)-(\d+)-(\d+)-(\d+)$/;

/**
 * Parse one hierarchy page.
 *
 * @throws {VoxelkloudError} `"hierarchy-error"` when the page is not an object
 *   of key/count pairs. A malformed page is a broken deployment, and guessing
 *   past it yields a tree with a silently missing subtree.
 */
export function parseHierarchyPage(
  json: unknown,
  at: string,
): OctreePage<EptNodePayload, EptPageRef> {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new VoxelkloudError(
      "hierarchy-error",
      `EPT hierarchy page ${at} is not a JSON object of "D-X-Y-Z": count pairs.`,
      { path: at },
    );
  }
  const nodes: OctreePage<EptNodePayload, EptPageRef>["nodes"][number][] = [];
  const links: OctreePage<EptNodePayload, EptPageRef>["links"][number][] = [];

  for (const [key, value] of Object.entries(json as Record<string, unknown>)) {
    const m = KEY.exec(key);
    if (m === null) {
      throw new VoxelkloudError(
        "hierarchy-error",
        `EPT hierarchy page ${at} has a key ${JSON.stringify(key)}, which is ` +
          `not a "D-X-Y-Z" node address.`,
        { path: `${at}#${key}` },
      );
    }
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw new VoxelkloudError(
        "hierarchy-error",
        `EPT hierarchy page ${at} maps ${JSON.stringify(key)} to ` +
          `${JSON.stringify(value)}; a point count or -1 was expected.`,
        { path: `${at}#${key}` },
      );
    }
    const level = Number(m[1]);
    const x = Number(m[2]);
    const y = Number(m[3]);
    const z = Number(m[4]);

    if (value === -1) {
      links.push({ level, x, y, z, ref: { key } });
      continue;
    }
    if (value < 0) {
      throw new VoxelkloudError(
        "hierarchy-error",
        `EPT hierarchy page ${at} maps ${JSON.stringify(key)} to ${value}. ` +
          `Only -1 has a meaning below zero.`,
        { path: `${at}#${key}` },
      );
    }
    nodes.push({ level, x, y, z, pointCount: value, payload: { key } });
  }

  return { nodes, links };
}

async function fetchJson(
  transport: PointCloudTransport,
  url: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
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
  const text = await res.text();
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (cause) {
    throw new VoxelkloudError("invalid-json", `${url} is not valid JSON.`, {
      url,
      cause,
    });
  }
}

export interface OpenEptTreeOptions {
  readonly signal?: AbortSignal | undefined;
  readonly maxDepth?: number | undefined;
  readonly maxNodes?: number | undefined;
  readonly maxConcurrentPageRequests?: number | undefined;
}

/**
 * Open the LOD tree over an EPT dataset, root page already loaded.
 *
 * The point pitch is the cube edge over `span`, halved per level: `span` is how
 * many voxels a node divides its own box into, so one voxel's edge IS the
 * spacing at that level.
 */
export async function openEptTree(
  source: EptSource,
  options: OpenEptTreeOptions = {},
): Promise<PagedOctree<EptNodePayload>> {
  const edge = Math.max(
    source.bounds.max[0] - source.bounds.min[0],
    source.bounds.max[1] - source.bounds.min[1],
    source.bounds.max[2] - source.bounds.min[2],
  );
  const rootSpacing = edge / source.manifest.span;

  const tree = createPagedOctree<EptNodePayload, EptPageRef>({
    bounds: source.bounds,
    rootPage: { key: "0-0-0-0" },
    loadPage: async (ref, signal) => {
      const url = `${source.baseUrl}ept-hierarchy/${ref.key}.json`;
      return parseHierarchyPage(await fetchJson(source.transport, url, signal), url);
    },
    geometricErrorAt: (level) => rootSpacing / 2 ** level,
    pointSpacingAt: (level) => rootSpacing / 2 ** level,
    ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
    ...(options.maxNodes !== undefined ? { maxNodes: options.maxNodes } : {}),
    ...(options.maxConcurrentPageRequests !== undefined
      ? { maxConcurrentPageRequests: options.maxConcurrentPageRequests }
      : {}),
  });

  await tree.expand(
    tree.root,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  return tree;
}
