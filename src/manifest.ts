// `ept.json`, validated.
//
// Entwine Point Tile is a directory, not a file: a manifest, a hierarchy of
// JSON pages, and one payload file per node. That makes it the cheapest format
// in this project to serve — static files, no Range support required — and it
// is what the USGS 3DEP archive publishes, which is the reason it is here.

import { VoxelkloudError } from "@voxelkloud/core";
import type { BoundingBox } from "@voxelkloud/core";

/** How a node's points are stored. */
export type EptDataType = "binary" | "laszip" | "zstandard";

/** One dimension, as `ept.json` declares it. */
export interface EptSchemaEntry {
  readonly name: string;
  readonly type: "signed" | "unsigned" | "float";
  readonly size: number;
  /** Present on the quantised dimensions — X, Y and Z. */
  readonly scale: number | undefined;
  readonly offset: number | undefined;
}

export interface EptManifest {
  /** The CUBE the octree subdivides. Node keys are addresses into it. */
  readonly bounds: BoundingBox;
  /** The genuinely tight extent of the data. */
  readonly boundsConforming: BoundingBox;
  readonly dataType: EptDataType;
  readonly hierarchyType: string;
  readonly points: number;
  readonly schema: readonly EptSchemaEntry[];
  /** Voxels per axis in one node. Point spacing is the cube edge over this. */
  readonly span: number;
  readonly version: string;
  readonly srs: unknown;
}

function box(value: unknown, field: string): BoundingBox {
  if (!Array.isArray(value) || value.length !== 6 || value.some((v) => typeof v !== "number")) {
    throw new VoxelkloudError(
      "invalid-metadata",
      `ept.json field ${JSON.stringify(field)} must be six numbers ` +
        `[minx, miny, minz, maxx, maxy, maxz]; got ${JSON.stringify(value)}.`,
      { path: field },
    );
  }
  const n = value as number[];
  return {
    min: [n[0]!, n[1]!, n[2]!],
    max: [n[3]!, n[4]!, n[5]!],
  };
}

/**
 * Validate a parsed `ept.json`.
 *
 * @throws {VoxelkloudError} `"invalid-metadata"` for anything structural. The
 *   bar is deliberately "could this address a node": a manifest that cannot is
 *   a broken deployment, and a viewer that guesses past it renders nothing and
 *   says nothing.
 */
export function parseEptManifest(json: unknown, url: string): EptManifest {
  if (json === null || typeof json !== "object") {
    throw new VoxelkloudError(
      "invalid-metadata",
      `${url} did not parse as a JSON object.`,
      { url },
    );
  }
  const o = json as Record<string, unknown>;

  const dataType = o["dataType"];
  if (dataType !== "binary" && dataType !== "laszip" && dataType !== "zstandard") {
    throw new VoxelkloudError(
      "invalid-metadata",
      `${url} declares dataType ${JSON.stringify(dataType)}; EPT defines ` +
        `"binary", "laszip" and "zstandard".`,
      { url, path: "dataType" },
    );
  }

  const hierarchyType = typeof o["hierarchyType"] === "string" ? o["hierarchyType"] : "json";
  if (hierarchyType !== "json") {
    throw new VoxelkloudError(
      "invalid-metadata",
      `${url} declares hierarchyType ${JSON.stringify(hierarchyType)}. Only ` +
        `"json" is implemented; a gzipped hierarchy would need the pages ` +
        `inflating before they parse.`,
      { url, path: "hierarchyType" },
    );
  }

  const rawSchema = o["schema"];
  if (!Array.isArray(rawSchema) || rawSchema.length === 0) {
    throw new VoxelkloudError(
      "invalid-metadata",
      `${url} has no schema, so nothing describes what a point contains.`,
      { url, path: "schema" },
    );
  }
  const schema: EptSchemaEntry[] = rawSchema.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    const name = e["name"];
    const type = e["type"];
    const size = e["size"];
    if (typeof name !== "string" || name === "") {
      throw new VoxelkloudError(
        "invalid-metadata",
        `${url} schema[${i}] has no name.`,
        { url, path: `schema[${i}].name` },
      );
    }
    if (type !== "signed" && type !== "unsigned" && type !== "float") {
      throw new VoxelkloudError(
        "invalid-metadata",
        `${url} schema[${i}] (${name}) declares type ${JSON.stringify(type)}; ` +
          `EPT defines "signed", "unsigned" and "float".`,
        { url, path: `schema[${i}].type` },
      );
    }
    if (typeof size !== "number" || ![1, 2, 4, 8].includes(size)) {
      throw new VoxelkloudError(
        "invalid-metadata",
        `${url} schema[${i}] (${name}) declares size ${JSON.stringify(size)}; ` +
          `EPT allows 1, 2, 4 and 8.`,
        { url, path: `schema[${i}].size` },
      );
    }
    return {
      name,
      type,
      size,
      scale: typeof e["scale"] === "number" ? e["scale"] : undefined,
      offset: typeof e["offset"] === "number" ? e["offset"] : undefined,
    };
  });

  const span = o["span"];
  if (typeof span !== "number" || !(span > 0)) {
    throw new VoxelkloudError(
      "invalid-metadata",
      `${url} declares span ${JSON.stringify(span)}. It is the voxel ` +
        `resolution of a node and the whole level-of-detail quantum is ` +
        `derived from it.`,
      { url, path: "span" },
    );
  }

  const points = o["points"];
  return {
    bounds: box(o["bounds"], "bounds"),
    // Not every writer emits it; the indexing cube is a safe, if loose, stand-in.
    boundsConforming:
      o["boundsConforming"] === undefined
        ? box(o["bounds"], "bounds")
        : box(o["boundsConforming"], "boundsConforming"),
    dataType,
    hierarchyType,
    points: typeof points === "number" ? points : 0,
    schema,
    span,
    version: typeof o["version"] === "string" ? o["version"] : "0.0.0",
    srs: o["srs"],
  };
}

/** Bytes of one point in the `binary` (and decompressed `zstandard`) packing. */
export function eptStride(schema: readonly EptSchemaEntry[]): number {
  return schema.reduce((sum, e) => sum + e.size, 0);
}
