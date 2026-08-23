// @voxelkloud/format-ept — the Entwine Point Tile driver.
//
// A directory of static files: one `ept.json`, a hierarchy of JSON pages, one
// payload per node. No Range support required of the host, which is why the
// USGS 3DEP archive on S3 is served this way and why pasting one of its URLs is
// the shortest path from nothing to a rendered LiDAR survey.
//
// What is genuinely EPT lives here: the manifest, the `"D-X-Y-Z": count`
// hierarchy page with its -1 continuation, the schema-to-attribute mapping, and
// the three payload encodings. The octree is @voxelkloud/core's, the record
// decode is @voxelkloud/format-las's, and the laszip path is
// @voxelkloud/wasm-codecs's.

export { EPT_FORMAT_ID, eptFormat } from "./format.js";
export { loadEptSource, resolveEptUrls } from "./load.js";
export { openEptTree, parseHierarchyPage } from "./hierarchy.js";
export type { OpenEptTreeOptions } from "./hierarchy.js";
export { openEptPoints } from "./points-reader.js";
export type { EptPointReader } from "./points-reader.js";
export { eptStride, parseEptManifest } from "./manifest.js";
export type { EptDataType, EptManifest, EptSchemaEntry } from "./manifest.js";
export { eptCrs, eptLayout, neutralName } from "./attributes.js";
export type { EptLayoutResult, EptWarningCode } from "./attributes.js";
export type {
  EptNodePayload,
  EptPageRef,
  EptSource,
  EptSourceWarningCode,
  EptWarning,
} from "./types.js";
