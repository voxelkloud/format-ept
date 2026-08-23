import type { FormatProbe, PointCloudFormat } from "@voxelkloud/core";
import { openEptTree } from "./hierarchy.js";
import { loadEptSource, resolveEptUrls } from "./load.js";
import { openEptPoints } from "./points-reader.js";
import type { EptSource } from "./types.js";

/**
 * The EPT driver, as a registry entry.
 *
 * Not registered by default: a `laszip` dataset needs the wasm LAZ decoder, and
 * an app that only reads Potree should not carry it. One
 * `formats.register(eptFormat)` turns it on.
 */
export const eptFormat: PointCloudFormat<EptSource> = {
  id: "ept",
  label: "Entwine Point Tile",

  sniffUrl(url) {
    const path = url.split(/[?#]/)[0] ?? "";
    if (path.endsWith("/ept.json")) return 2;
    // A bare directory is EPT's conventional shape, and also Potree's and 3D
    // Tiles'. Weak on purpose: content decides.
    if (path.endsWith("/")) return 1;
    return 0;
  },

  probeUrl(url) {
    try {
      return resolveEptUrls(url).manifest;
    } catch {
      return undefined;
    }
  },

  sniff(probe: FormatProbe) {
    const j = probe.json;
    if (j === null || typeof j !== "object") return 0;
    const o = j as Record<string, unknown>;
    // `dataType` plus `hierarchyType` is the pair no other manifest in this
    // space carries; either alone would be a guess.
    const dataType = o["dataType"];
    if (
      dataType !== "binary" &&
      dataType !== "laszip" &&
      dataType !== "zstandard"
    ) {
      return 0;
    }
    if (typeof o["hierarchyType"] !== "string") return 2;
    return o["schema"] !== undefined && o["bounds"] !== undefined ? 3 : 2;
  },

  load: (url, options) => loadEptSource(url, options),

  openTree: (source, options) => openEptTree(source, { signal: options?.signal }),

  openPoints: (source, options) => openEptPoints(source, options),
};

/** Re-exported so a caller can pin the driver by its stable id. */
export const EPT_FORMAT_ID = eptFormat.id;
