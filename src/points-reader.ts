// One EPT node: one file, decoded three ways.
//
// EPT's node addressing is the simplest of the three formats — the key IS the
// filename — and its payload is the least uniform. `binary` is the schema
// packed interleaved, `laszip` is a whole LAS file, `zstandard` is a compressed
// `binary` block. All three end at the same interleaved-record decoder.

import { VoxelkloudError } from "@voxelkloud/core";
import type {
  DecodedPointData,
  NodeDecompress,
  OpenPointsOptions,
  PointCloudNode,
  PointNodeRef,
  PointReader,
  ReadPointsOptions,
} from "@voxelkloud/core";
import { createLasDecodePlan, decodeLasRecords } from "@voxelkloud/format-las";
import type { LasDecodePlan } from "@voxelkloud/format-las";
import { decodeLazFile } from "@voxelkloud/wasm-codecs";
import type { EptNodePayload, EptSource } from "./types.js";

type EptNode = PointCloudNode & {
  readonly payload?: EptNodePayload | undefined;
  readonly key?: string;
};

/** Extension of a node file, per data type. */
const EXTENSION = {
  binary: "bin",
  laszip: "laz",
  zstandard: "zst",
} as const;

export interface EptPointReader extends PointReader {
  readonly plan: LasDecodePlan;
}

/** Open a reader over one EPT dataset. */
export function openEptPoints(
  source: EptSource,
  options: OpenPointsOptions = {},
): EptPointReader {
  const plan = createLasDecodePlan(source.layout, {
    ...options,
    scale: [source.scale[0], source.scale[1], source.scale[2]],
    offset: [source.offset[0], source.offset[1], source.offset[2]],
    cloudOrigin: [
      source.bounds.min[0],
      source.bounds.min[1],
      source.bounds.min[2],
    ],
  });
  const dataType = source.manifest.dataType;
  const extension = EXTENSION[dataType];
  const decompress: NodeDecompress | undefined = options.decompress;
  let disposed = false;

  const urlFor = (node: PointNodeRef): string => {
    const key = (node as unknown as EptNode).payload?.key ?? node.name;
    return `${source.baseUrl}ept-data/${key}.${extension}`;
  };

  const fetchNode = async (
    url: string,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> => {
    let res: Response;
    try {
      res = await source.transport.fetch(url, {
        ...source.transport.requestInit,
        signal,
      });
    } catch (cause) {
      if (
        cause instanceof Error &&
        (cause.name === "AbortError" || cause.name === "TimeoutError")
      ) {
        throw cause;
      }
      throw new VoxelkloudError(
        "network-error",
        `Network error fetching ${url}.`,
        { url, cause },
      );
    }
    if (!res.ok) {
      throw new VoxelkloudError(
        "http-error",
        `GET ${url} failed: HTTP ${res.status} ${res.statusText}.`,
        { url, status: res.status },
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  };

  return {
    plan,

    hasPayload(node: PointCloudNode) {
      // Every EPT node with points has a file named after its key, and a
      // placeholder for an unfetched hierarchy page has neither.
      return (
        (node as EptNode).payload !== undefined && node.numPoints > 0
      );
    },

    packingFor(name) {
      return plan.fields.find((f) => f.attribute.name === name)?.pack;
    },

    async read(
      node: PointNodeRef,
      read: ReadPointsOptions = {},
    ): Promise<DecodedPointData> {
      if (disposed) {
        throw new VoxelkloudError(
          "unsupported-point-data",
          `This EPT reader has been disposed.`,
        );
      }
      const url = urlFor(node);
      const bytes = await fetchNode(url, read.signal);
      const expected = node.numPoints * plan.stride;

      let records: Uint8Array;
      if (dataType === "binary") {
        records = bytes;
      } else if (dataType === "laszip") {
        const decoded = decodeLazFile(bytes);
        try {
          if (decoded.pointSize !== plan.stride) {
            throw new VoxelkloudError(
              "unsupported-point-data",
              `${url} holds ${decoded.pointSize}-byte records but the dataset ` +
                `was opened against ${plan.stride}-byte ones. Every node of an ` +
                `EPT dataset must share one point format.`,
              { url },
            );
          }
          records = decoded.points;
        } finally {
          decoded.free();
        }
      } else {
        if (decompress === undefined) {
          throw new VoxelkloudError(
            "unsupported-encoding",
            `${url} is zstandard-compressed and no decompressor was supplied. ` +
              `No browser exposes zstd to JavaScript, so pass one through ` +
              `\`decompress\` when opening the reader — the same hook a BROTLI ` +
              `Potree cloud uses.`,
            { url },
          );
        }
        records = await decompress(bytes, expected);
      }

      if (records.byteLength < expected) {
        throw new VoxelkloudError(
          "unsupported-point-data",
          `${url} decoded to ${records.byteLength} bytes; the hierarchy says ` +
            `this node has ${node.numPoints} points of ${plan.stride} bytes ` +
            `(${expected}).`,
          { url, path: node.name },
        );
      }

      return decodeLasRecords(
        plan,
        node,
        records,
        read.computeBounds === undefined
          ? {}
          : { computeBounds: read.computeBounds },
      );
    },

    dispose() {
      disposed = true;
    },
  };
}
