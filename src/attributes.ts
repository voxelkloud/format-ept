// The EPT schema as an interleaved record.
//
// A `binary` node is the schema's dimensions packed in declaration order, one
// after another, `stride` bytes per point — the same shape as a LAS record, so
// it reuses the same decoder. What EPT supplies is the layout; the LAS-ness is
// only in where `format-las` happens to live.
//
// The NAMES are translated. EPT writes `"Intensity"` where a Potree manifest
// writes `"intensity"` and a LAS record's dimension is called the same, and a
// colour mode that keys off one spelling must not stop working because the
// cloud was published as EPT. The mapping is stated below and nowhere else.

import { POINT_ATTRIBUTE_TYPE_SIZE, VoxelkloudError } from "@voxelkloud/core";
import type {
  BoundingBox,
  CrsDeclaration,
  PointAttribute,
  PointAttributeTypeName,
  PointCloudWarning,
} from "@voxelkloud/core";
import type { LasAttribute, LasLayout } from "@voxelkloud/format-las";
import { crsFromEpsg, crsFromWkt } from "@voxelkloud/core";
import { eptStride } from "./manifest.js";
import type { EptManifest, EptSchemaEntry } from "./manifest.js";

export type EptWarningCode =
  | "unmapped-dimension"
  | "colour-not-contiguous"
  | "degenerate-range"
  | "duplicate-attribute-name"
  | "unsupported-dimension";

export type EptWarning = PointCloudWarning<EptWarningCode>;

/**
 * EPT dimension names to the names every other driver in this project uses.
 *
 * PDAL's names are CamelCase; PotreeConverter's — and therefore this project's,
 * since that is what shipped first — are lowercase with spaces. Anything not
 * listed keeps its EPT spelling verbatim, which is right for a custom
 * dimension like `OriginId`.
 */
const NEUTRAL_NAME: Readonly<Record<string, string>> = {
  Intensity: "intensity",
  ReturnNumber: "return number",
  NumberOfReturns: "number of returns",
  ScanDirectionFlag: "scan direction flag",
  EdgeOfFlightLine: "edge of flight line",
  Classification: "classification",
  ClassFlags: "classification flags",
  ClassificationFlags: "classification flags",
  ScannerChannel: "scanner channel",
  ScanAngleRank: "scan angle rank",
  ScanAngle: "scan angle",
  UserData: "user data",
  PointSourceId: "point source id",
  PointSourceID: "point source id",
  GpsTime: "gps-time",
  GPSTime: "gps-time",
  Infrared: "nir",
  NIR: "nir",
};

export function neutralName(eptName: string): string {
  return NEUTRAL_NAME[eptName] ?? eptName;
}

function typeNameFor(entry: EptSchemaEntry): PointAttributeTypeName | undefined {
  if (entry.type === "float") return entry.size === 4 ? "float" : entry.size === 8 ? "double" : undefined;
  const signed = entry.type === "signed";
  switch (entry.size) {
    case 1:
      return signed ? "int8" : "uint8";
    case 2:
      return signed ? "int16" : "uint16";
    case 4:
      return signed ? "int32" : "uint32";
    case 8:
      return signed ? "int64" : "uint64";
    default:
      return undefined;
  }
}

export interface EptLayoutResult {
  readonly layout: LasLayout;
  /** File quantization, taken from X/Y/Z's own scale and offset. */
  readonly scale: readonly [number, number, number];
  readonly offset: readonly [number, number, number];
  readonly warnings: readonly EptWarning[];
}

/**
 * Build the record layout for a `binary` or `zstandard` EPT node.
 *
 * @throws {VoxelkloudError} `"unsupported-point-data"` when X, Y and Z are not
 *   three contiguous signed 4-byte dimensions. Every Entwine build writes them
 *   that way, and the alternative — a float position with no quantisation — is
 *   a different decode path that no real deployment has asked for. Refusing
 *   loudly beats reading the wrong four bytes.
 */
export function eptLayout(
  schema: readonly EptSchemaEntry[],
  bounds: BoundingBox,
): EptLayoutResult {
  const warnings: EptWarning[] = [];
  const emitted = new Set<EptWarningCode>();
  const warn = (code: EptWarningCode, path: string, message: string): void => {
    if (emitted.has(code)) return;
    emitted.add(code);
    warnings.push({ code, path, message });
  };

  const offsets = new Map<string, number>();
  let at = 0;
  for (const entry of schema) {
    offsets.set(entry.name, at);
    at += entry.size;
  }
  const stride = eptStride(schema);

  const x = schema.find((e) => e.name === "X");
  const y = schema.find((e) => e.name === "Y");
  const z = schema.find((e) => e.name === "Z");
  const xyzContiguous =
    x !== undefined &&
    y !== undefined &&
    z !== undefined &&
    offsets.get("Y") === offsets.get("X")! + 4 &&
    offsets.get("Z") === offsets.get("X")! + 8 &&
    [x, y, z].every((e) => e.type === "signed" && e.size === 4);
  if (!xyzContiguous) {
    throw new VoxelkloudError(
      "unsupported-point-data",
      `This EPT schema does not store X, Y and Z as three contiguous signed ` +
        `4-byte dimensions. Found: ` +
        `${schema.map((e) => `${e.name} ${e.type}${e.size * 8}`).join(", ")}.`,
      { path: "schema" },
    );
  }

  const attributes: LasAttribute[] = [];
  const attributesByName = new Map<string, LasAttribute>();
  const push = (attribute: PointAttribute, byteOffset: number): void => {
    const entry: LasAttribute = {
      attribute,
      access: { kind: "scalar", at: byteOffset },
    };
    attributes.push(entry);
    if (attributesByName.has(attribute.name)) {
      warn(
        "duplicate-attribute-name",
        attribute.name,
        `Two dimensions map to the name ${JSON.stringify(attribute.name)}. ` +
          `Lookups resolve to the first; both keep their own offsets.`,
      );
    } else {
      attributesByName.set(attribute.name, entry);
    }
  };

  const normalizationFor = (
    name: string,
    numElements: number,
    elementSize: number,
    min: readonly number[],
    max: readonly number[],
  ): { offset: number; scale: number } | undefined => {
    if (!(numElements === 1 && elementSize > 4)) return undefined;
    const lo = min[0] ?? 0;
    const hi = max[0] ?? 0;
    if (lo === hi) {
      warn(
        "degenerate-range",
        name,
        `Attribute ${JSON.stringify(name)} has min === max (${lo}), so it ` +
          `cannot be normalised into float32. Using a denominator of 1; every ` +
          `value will decode to 0.`,
      );
    }
    return { offset: lo, scale: 1 / (hi - lo || 1) };
  };

  // Position first, whatever the schema order, because a renderer looks it up
  // by role and the three dimensions are one attribute here.
  push(
    {
      name: "position",
      role: "position",
      description: "",
      type: "int32",
      numElements: 3,
      elementSize: 4,
      byteSize: 12,
      byteOffset: offsets.get("X")!,
      // Absolute CRS, post scale and offset — the same convention every other
      // driver's position attribute uses.
      min: bounds.min,
      max: bounds.max,
      scale: [1, 1, 1],
      offset: [0, 0, 0],
      histogram: undefined,
      normalization: undefined,
    },
    offsets.get("X")!,
  );

  // Colour, when the three channels are contiguous and the same width.
  const red = schema.find((e) => e.name === "Red");
  const green = schema.find((e) => e.name === "Green");
  const blue = schema.find((e) => e.name === "Blue");
  let colourHandled = false;
  if (red !== undefined && green !== undefined && blue !== undefined) {
    const contiguous =
      offsets.get("Green") === offsets.get("Red")! + red.size &&
      offsets.get("Blue") === offsets.get("Red")! + red.size * 2 &&
      green.size === red.size &&
      blue.size === red.size;
    const type = typeNameFor(red);
    if (!contiguous || (type !== "uint8" && type !== "uint16")) {
      warn(
        "colour-not-contiguous",
        "schema",
        `Red, Green and Blue are not three contiguous unsigned 8- or 16-bit ` +
          `dimensions, so they are exposed individually rather than as an ` +
          `\`rgb\` attribute and this cloud will not colour by RGB.`,
      );
    } else {
      const max = type === "uint8" ? 255 : 65535;
      push(
        {
          name: "rgb",
          role: "color",
          description: "",
          type,
          numElements: 3,
          elementSize: red.size,
          byteSize: red.size * 3,
          byteOffset: offsets.get("Red")!,
          min: [0, 0, 0],
          max: [max, max, max],
          scale: [1, 1, 1],
          offset: [0, 0, 0],
          histogram: undefined,
          normalization: undefined,
        },
        offsets.get("Red")!,
      );
      colourHandled = true;
    }
  }

  for (const entry of schema) {
    if (entry.name === "X" || entry.name === "Y" || entry.name === "Z") continue;
    if (colourHandled && ["Red", "Green", "Blue"].includes(entry.name)) continue;

    const type = typeNameFor(entry);
    if (type === undefined) {
      warn(
        "unsupported-dimension",
        entry.name,
        `Dimension ${JSON.stringify(entry.name)} is declared as ` +
          `${entry.type} of ${entry.size} bytes, which is not a type this ` +
          `reader can produce. It is skipped; the stride still counts it.`,
      );
      continue;
    }
    const elementSize = POINT_ATTRIBUTE_TYPE_SIZE[type];
    const name = neutralName(entry.name);
    // EPT declares no per-dimension domain, so these are the type's own range —
    // the same placeholder a LAS record gets, and equally honest about it.
    const wide = type === "double" || type === "float";
    const min = wide ? [0] : [0];
    const max = wide ? [0] : [2 ** (elementSize * 8) - 1];

    push(
      {
        name,
        role: undefined,
        description: "",
        type,
        numElements: 1,
        elementSize,
        byteSize: entry.size,
        byteOffset: offsets.get(entry.name)!,
        min,
        max,
        scale: entry.scale === undefined ? [1] : [entry.scale],
        offset: entry.offset === undefined ? [0] : [entry.offset],
        histogram: undefined,
        normalization: normalizationFor(name, 1, elementSize, min, max),
      },
      offsets.get(entry.name)!,
    );
  }

  return {
    layout: { attributes, attributesByName, stride, warnings: [] },
    scale: [x.scale ?? 1, y.scale ?? 1, z.scale ?? 1],
    offset: [x.offset ?? 0, y.offset ?? 0, z.offset ?? 0],
    warnings,
  };
}

/**
 * The CRS an `ept.json` declares.
 *
 * Entwine writes `srs` as an object with up to four fields: an `authority` and
 * a `horizontal` code, a `vertical` code, and a `wkt`. All of them are
 * optional, and `{}` — which every build in this repo's demo data carries — is
 * a dataset with no projection at all, which is normal for photogrammetry.
 *
 * The code pair is preferred over the WKT when both are present: it is what the
 * writer decided the system IS, while the WKT is its expansion, and resolving
 * the code needs no parsing.
 */
export function eptCrs(manifest: EptManifest): CrsDeclaration | undefined {
  const srs = manifest.srs;
  if (srs === null || typeof srs !== "object") return undefined;
  const o = srs as Record<string, unknown>;

  const authority = typeof o["authority"] === "string" ? o["authority"] : undefined;
  const horizontal =
    typeof o["horizontal"] === "string" || typeof o["horizontal"] === "number"
      ? Number(o["horizontal"])
      : undefined;
  const vertical =
    typeof o["vertical"] === "string" || typeof o["vertical"] === "number"
      ? Number(o["vertical"])
      : undefined;

  if (
    horizontal !== undefined &&
    Number.isSafeInteger(horizontal) &&
    (authority === undefined || authority.toUpperCase() === "EPSG")
  ) {
    return crsFromEpsg(horizontal, {
      ...(vertical !== undefined && Number.isSafeInteger(vertical)
        ? { verticalEpsg: vertical }
        : {}),
    });
  }
  if (typeof o["wkt"] === "string" && o["wkt"].trim() !== "") {
    return crsFromWkt(o["wkt"]);
  }
  return undefined;
}
