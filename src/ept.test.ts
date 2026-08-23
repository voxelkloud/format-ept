// Against real Entwine output, or not at all.
//
// `demo/potree/pointclouds/` holds the SAME cloud built four ways — binary,
// laszip in LAS 1.2, laszip in LAS 1.4, and zstandard — which is a better
// oracle than any of them alone: two encodings of one dataset must decode to
// the same points, and only one of them can be wrong at a time. The files are
// gitignored, so every test skips when they are absent and says so.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "@voxelkloud/core";
import { eptFormat } from "./format.js";
import { loadEptSource } from "./load.js";
import { openEptTree } from "./hierarchy.js";
import { openEptPoints } from "./points-reader.js";
import { parseHierarchyPage } from "./hierarchy.js";
import { parseEptManifest } from "./manifest.js";
import type { EptSource } from "./types.js";

const CLOUDS = new URL("../../../demo/potree/pointclouds/", import.meta.url);
const VARIANTS = {
  binary: "lion_takanawa_ept_bin",
  laszip: "lion_takanawa_ept_laz",
  laszip14: "lion_takanawa_ept_laz_14",
  zstandard: "lion_takanawa_ept_zst",
} as const;

const dirOf = (name: string): string =>
  fileURLToPath(new URL(`${name}/`, CLOUDS));

const HAS = Object.fromEntries(
  Object.entries(VARIANTS).map(([k, v]) => [k, existsSync(dirOf(v))]),
) as Record<keyof typeof VARIANTS, boolean>;

if (!HAS.binary || !HAS.laszip) {
  console.warn(
    "@voxelkloud/format-ept: the lion_takanawa EPT builds under " +
      "demo/potree/pointclouds are missing, so the driver tests are skipped. " +
      "Fetch them with demo/data/fetch-large.sh.",
  );
}

/** Serves one local directory as if it were a static host. */
function serve(dir: string): { fetch: FetchLike; requests: string[] } {
  const requests: string[] = [];
  const fetchLike: FetchLike = async (input, init) => {
    const path = new URL(input).pathname.replace(/^\//u, "");
    requests.push(path);
    const file = `${dir}${path}`;
    if (!existsSync(file)) return new Response(null, { status: 404 });
    const bytes = new Uint8Array(readFileSync(file));
    const range = new Headers(init?.headers).get("Range");
    const m = range === null ? null : /^bytes=(\d+)-(\d+)$/.exec(range);
    if (m === null) return new Response(bytes, { status: 200 });
    const from = Number(m[1]);
    const to = Math.min(Number(m[2]), bytes.byteLength - 1);
    return new Response(bytes.subarray(from, to + 1), { status: 206 });
  };
  return { fetch: fetchLike, requests };
}

async function open(
  variant: keyof typeof VARIANTS,
): Promise<{ source: EptSource; requests: string[] }> {
  const server = serve(dirOf(VARIANTS[variant]));
  const source = await loadEptSource("https://example.test/", {
    fetch: server.fetch,
  });
  return { source, requests: server.requests };
}

describe.skipIf(!HAS.binary)("loadEptSource, binary", () => {
  it("reads the manifest with one request", async () => {
    const { source, requests } = await open("binary");
    expect(requests).toEqual(["ept.json"]);
    expect(source.manifest.dataType).toBe("binary");
    expect(source.manifest.span).toBe(256);
    expect(source.pointCount).toBe(341_989);
    expect(source.baseUrl).toBe("https://example.test/");
  });

  it("separates the indexing cube from the data extent", async () => {
    const { source } = await open("binary");
    // Entwine's `bounds` is the cube it subdivided and `boundsConforming` is
    // where the points are. This dataset's differ on every axis, so a driver
    // that conflated them would frame empty space.
    expect(source.bounds.min).toEqual([-7, -1, -6]);
    expect(source.bounds.max).toEqual([3, 9, 4]);
    expect(source.tightBoundingBox.min).toEqual([-5, 1, -4]);
    expect(source.tightBoundingBox.max).toEqual([1, 7, 3]);
  });

  it("translates the schema into the shared attribute names", async () => {
    const { source } = await open("binary");
    const names = source.attributes.map((a) => a.name);
    // Entwine writes CamelCase; every other driver here writes these. A colour
    // mode must not stop working because the cloud was published as EPT.
    expect(names).toContain("position");
    expect(names).toContain("rgb");
    expect(names).toContain("intensity");
    expect(names).toContain("classification");
    expect(names).toContain("return number");
    expect(names).toContain("point source id");
    // Not a name anything else knows, so it stays verbatim.
    expect(names).toContain("OriginId");
    expect(names).not.toContain("Intensity");
    expect(names).not.toContain("Red");

    expect(source.attributesByName.get("position")!.role).toBe("position");
    expect(source.attributesByName.get("rgb")!.role).toBe("color");
    expect(source.attributesByName.get("rgb")!.numElements).toBe(3);
    // Quantisation comes off X/Y/Z's own scale and offset.
    expect(source.scale).toEqual([0.001, 0.001, 0.001]);
    expect(source.offset).toEqual([-2, 4, -1]);
  });

  it("keeps the schema's declared type for ScanAngleRank", async () => {
    const { source } = await open("binary");
    // The binary block really does store it as a 4-byte float, whatever the
    // LAS record of the same cloud does.
    expect(source.attributesByName.get("scan angle rank")!.type).toBe("float");
    expect(source.layout.stride).toBe(36);
  });
});

describe.skipIf(!HAS.laszip)("loadEptSource, laszip", () => {
  it("believes the node's LAS header over the manifest's schema", async () => {
    const { source, requests } = await open("laszip");
    // Two requests, and the second is not avoidable: Entwine's schema calls
    // ScanAngleRank a 4-byte float and the LAS record it writes stores a
    // signed byte. What is on disk wins.
    expect(requests).toEqual(["ept.json", "ept-data/0-0-0-0.laz"]);
    expect(source.attributesByName.get("scan angle rank")!.type).toBe("int8");
    expect(source.layout.stride).toBe(30);
    expect(source.scale).toEqual([0.001, 0.001, 0.001]);
    expect(source.offset).toEqual([-2, 4, -1]);
    // The Extra Bytes VLR still surfaces the custom dimension.
    expect(source.attributes.map((a) => a.name)).toContain("OriginId");
  });
});

describe.skipIf(!HAS.binary)("openEptTree", () => {
  it("loads the root page and materialises the hierarchy", async () => {
    const { source } = await open("binary");
    const tree = await openEptTree(source);
    // This dataset's whole hierarchy is one page: 16 keys across three levels.
    expect(tree.nodeCount).toBeGreaterThanOrEqual(16);
    expect(tree.maxLevel).toBe(2);
    expect(tree.root.numPoints).toBe(35_091);

    let counted = 0;
    for (let i = 0; i < tree.nodeCount; i++) counted += tree.node(i)!.numPoints;
    // Every point belongs to exactly one node's own layer.
    expect(counted).toBe(source.pointCount);
    tree.dispose();
  });

  it("derives spacing from span, not from a declared value", async () => {
    const { source } = await open("binary");
    const tree = await openEptTree(source);
    // The cube is 10 units on its longest axis and a node is 256 voxels across.
    expect(tree.pointSpacingAt(0)).toBeCloseTo(10 / 256, 12);
    expect(tree.geometricErrorAt(2)).toBeCloseTo(10 / 256 / 4, 12);
    tree.dispose();
  });

  it("keeps every node inside its parent", async () => {
    const { source } = await open("binary");
    const tree = await openEptTree(source);
    for (let i = 1; i < tree.nodeCount; i++) {
      const node = tree.node(i)!;
      const parent = node.parent!;
      expect(node.minX).toBeGreaterThanOrEqual(parent.minX);
      expect(node.maxY).toBeLessThanOrEqual(parent.maxY);
      expect(node.level).toBe(parent.level + 1);
    }
    tree.dispose();
  });
});

describe.skipIf(!HAS.binary)("openEptPoints, binary", () => {
  it("decodes the root node into the neutral shape", async () => {
    const { source } = await open("binary");
    const tree = await openEptTree(source);
    const reader = openEptPoints(source, { computeBounds: true });
    const root = tree.root;

    expect(reader.hasPayload(root)).toBe(true);
    const data = await reader.read(root);

    expect(data.numPoints).toBe(35_091);
    expect(data.positions).toHaveLength(3 * 35_091);
    expect(data.frame.originPolicy).toBe("cloud");
    expect(data.colors).toBeDefined();
    expect(data.colors!.array).toHaveLength(4 * 35_091);
    expect(data.colors!.array[3]).toBe(255);

    // Decoded points must land in the node's box and inside the declared tight
    // extent — the two independent things the manifest asserts.
    const { origin } = data.frame;
    expect(data.bounds!.min[0]).toBeGreaterThanOrEqual(
      source.tightBoundingBox.min[0] - 0.001,
    );
    expect(data.bounds!.max[2]).toBeLessThanOrEqual(
      source.tightBoundingBox.max[2] + 0.001,
    );
    for (let i = 0; i < 2000; i++) {
      const x = origin[0] + data.positions[3 * i]!;
      expect(x).toBeGreaterThanOrEqual(root.minX - 0.01);
      expect(x).toBeLessThanOrEqual(root.maxX + 0.01);
    }
    reader.dispose();
    tree.dispose();
  });

  it("refuses a node with no file of its own", async () => {
    const { source } = await open("binary");
    const tree = await openEptTree(source);
    const reader = openEptPoints(source);
    const placeholder = { ...tree.root, payload: undefined, numPoints: 0 };
    expect(reader.hasPayload(placeholder as never)).toBe(false);
    reader.dispose();
    tree.dispose();
  });
});

describe.skipIf(!HAS.binary || !HAS.laszip)(
  "binary and laszip decode the same cloud",
  () => {
    it("produces the same points, field for field", async () => {
      // The strongest check available: two encodings Entwine wrote from one
      // source, decoded by two different paths in this driver, compared point
      // for point. A bug in either path shows up here and nowhere else.
      //
      // As SETS, not in order. The two builds ran separately and Entwine does
      // not promise a within-node ordering; what it does promise is that the
      // node holds the same points. Positions are compared as the stored
      // integers, so the comparison is exact rather than merely close.
      const bin = await open("binary");
      const laz = await open("laszip");
      expect(laz.source.scale).toEqual(bin.source.scale);
      expect(laz.source.offset).toEqual(bin.source.offset);

      const canon = async (source: EptSource): Promise<string[]> => {
        const tree = await openEptTree(source);
        const reader = openEptPoints(source, {
          positionFormat: "int32",
          attributes: ["intensity", "classification", "rgb"],
        });
        const d = await reader.read(tree.root);
        const intensity = d.attributesByName.get("intensity")!.array;
        const classification =
          d.attributesByName.get("classification")!.array;
        const rgb = d.colors!.array;
        const out = new Array<string>(d.numPoints);
        for (let i = 0; i < d.numPoints; i++) {
          out[i] =
            `${d.positions[3 * i]},${d.positions[3 * i + 1]},` +
            `${d.positions[3 * i + 2]},${intensity[i]},${classification[i]},` +
            `${rgb[4 * i]},${rgb[4 * i + 1]},${rgb[4 * i + 2]}`;
        }
        reader.dispose();
        tree.dispose();
        return out.sort();
      };

      const a = await canon(bin.source);
      const b = await canon(laz.source);
      expect(b).toHaveLength(a.length);
      expect(a).toHaveLength(35_091);
      // One assertion over the whole node rather than 35,091 of them: a
      // mismatch prints the first differing record, which is what is wanted.
      expect(b).toEqual(a);
    });
  },
);

describe.skipIf(!HAS.laszip14)("laszip in LAS 1.4", () => {
  it("reads a point format 6+ record", async () => {
    const { source } = await open("laszip14");
    // The 1.4 build stores the same dimensions in the point-format-6 layout,
    // where the bit runs are 4 bits wide instead of 3 and the scan angle is a
    // 16-bit value rather than a signed byte.
    expect(source.attributesByName.get("scan angle")).toBeDefined();
    expect(source.attributesByName.get("scan angle rank")).toBeUndefined();
    expect(source.attributesByName.get("classification flags")).toBeDefined();

    const tree = await openEptTree(source);
    const reader = openEptPoints(source);
    const data = await reader.read(tree.root);
    expect(data.numPoints).toBe(tree.root.numPoints);
    expect(data.colors).toBeDefined();
    reader.dispose();
    tree.dispose();
  });
});

describe.skipIf(!HAS.zstandard)("zstandard", () => {
  it("names the hook it needs instead of failing obscurely", async () => {
    const { source } = await open("zstandard");
    expect(source.manifest.dataType).toBe("zstandard");
    const tree = await openEptTree(source);
    const reader = openEptPoints(source);
    await expect(reader.read(tree.root)).rejects.toThrow(/decompress/);
    reader.dispose();
    tree.dispose();
  });

  it("decodes through a supplied decompressor", async () => {
    const { zstdDecompressSync } = await import("node:zlib").then((z) => ({
      zstdDecompressSync: (
        z as unknown as {
          zstdDecompressSync?: (b: Uint8Array) => Buffer;
        }
      ).zstdDecompressSync,
    }));
    if (zstdDecompressSync === undefined) return; // Node < 22.15

    const { source } = await open("zstandard");
    const tree = await openEptTree(source);
    const reader = openEptPoints(source, {
      decompress: (input) => new Uint8Array(zstdDecompressSync(input)),
    });
    const data = await reader.read(tree.root);
    expect(data.numPoints).toBe(tree.root.numPoints);
    expect(data.colors).toBeDefined();
    reader.dispose();
    tree.dispose();
  });
});

describe("parseHierarchyPage", () => {
  it("reads counts and continuations", () => {
    const page = parseHierarchyPage(
      { "0-0-0-0": 100, "1-0-1-0": 40, "2-1-1-1": -1 },
      "root",
    );
    expect(page.nodes).toHaveLength(2);
    expect(page.nodes[0]).toEqual({
      level: 0,
      x: 0,
      y: 0,
      z: 0,
      pointCount: 100,
      payload: { key: "0-0-0-0" },
    });
    expect(page.links).toEqual([
      { level: 2, x: 1, y: 1, z: 1, ref: { key: "2-1-1-1" } },
    ]);
  });

  it("refuses a key that is not an address", () => {
    expect(() => parseHierarchyPage({ "r0402": 10 }, "root")).toThrow(
      /node address/,
    );
  });

  it("refuses a count that is not one", () => {
    expect(() => parseHierarchyPage({ "0-0-0-0": "many" }, "root")).toThrow(
      /point count/,
    );
    expect(() => parseHierarchyPage({ "0-0-0-0": -2 }, "root")).toThrow(
      /below zero/,
    );
  });
});

describe("parseEptManifest", () => {
  const base = {
    bounds: [0, 0, 0, 1, 1, 1],
    dataType: "binary",
    hierarchyType: "json",
    points: 10,
    schema: [{ name: "X", type: "signed", size: 4 }],
    span: 128,
  };

  it("falls back to bounds when boundsConforming is absent", () => {
    const m = parseEptManifest(base, "u");
    expect(m.boundsConforming).toEqual(m.bounds);
  });

  it("refuses an unknown dataType", () => {
    expect(() =>
      parseEptManifest({ ...base, dataType: "parquet" }, "u"),
    ).toThrow(/dataType/);
  });

  it("refuses a gzipped hierarchy rather than pretending", () => {
    expect(() =>
      parseEptManifest({ ...base, hierarchyType: "gzip" }, "u"),
    ).toThrow(/hierarchyType/);
  });

  it("refuses a manifest with no span", () => {
    const { span: _span, ...rest } = base;
    expect(() => parseEptManifest(rest, "u")).toThrow(/span/);
  });
});

describe("eptFormat", () => {
  it("orders itself on URL shape without fetching", () => {
    expect(eptFormat.sniffUrl("https://x.test/cloud/ept.json")).toBe(2);
    expect(eptFormat.sniffUrl("https://x.test/cloud/")).toBe(1);
    expect(eptFormat.sniffUrl("https://x.test/a.copc.laz")).toBe(0);
  });

  it("names ept.json whichever of the two inputs it was given", () => {
    expect(eptFormat.probeUrl("https://x.test/cloud/")).toBe(
      "https://x.test/cloud/ept.json",
    );
    expect(eptFormat.probeUrl("https://x.test/cloud/ept.json")).toBe(
      "https://x.test/cloud/ept.json",
    );
  });

  it("discriminates on dataType, not on being JSON", () => {
    const probe = (json: unknown) =>
      eptFormat.sniff({
        url: "https://x.test/cloud/ept.json",
        json,
        head: "",
        bytes: new TextEncoder().encode(""),
        contentType: "application/json",
      });
    expect(
      probe({
        dataType: "laszip",
        hierarchyType: "json",
        schema: [],
        bounds: [],
      }),
    ).toBe(3);
    // A Potree manifest is JSON at the same URL shape and must not match.
    expect(probe({ version: "2.0", hierarchy: {} })).toBe(0);
    expect(probe(undefined)).toBe(0);
  });
});
