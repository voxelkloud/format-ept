import type {
  PointAttribute,
  PointCloudSourceBase,
  PointCloudWarning,
} from "@voxelkloud/core";
import type { LasLayout } from "@voxelkloud/format-las";
import type { EptManifest } from "./manifest.js";
import type { EptWarningCode } from "./attributes.js";

/** A node's address. EPT names files after it, so the key IS the payload. */
export interface EptNodePayload {
  readonly key: string;
}

/** A hierarchy page's address. Same key, a different directory. */
export interface EptPageRef {
  readonly key: string;
}

export type EptSourceWarningCode =
  | EptWarningCode
  | "extra-bytes-mismatch"
  | "undecodable-attribute"
  | "laszip-header-unreadable";

export type EptWarning = PointCloudWarning<EptSourceWarningCode>;

export interface EptSource extends PointCloudSourceBase {
  /** Absolute URL of the dataset directory, with a trailing slash. */
  readonly baseUrl: string;
  readonly manifest: EptManifest;
  /**
   * The record layout a node decodes against.
   *
   * For `binary` and `zstandard` this comes from the manifest's schema. For
   * `laszip` it comes from the LAS header of the root node, because the two
   * genuinely disagree: Entwine's schema calls `ScanAngleRank` a 4-byte float
   * while the LAS record it writes stores a signed byte. What is on disk wins.
   */
  readonly layout: LasLayout;
  /** File quantization for X, Y and Z. */
  readonly scale: readonly [number, number, number];
  readonly offset: readonly [number, number, number];
  readonly attributes: readonly PointAttribute[];
  readonly warnings: readonly EptWarning[];
}
