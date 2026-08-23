# @voxelkloud/format-ept

The [Entwine Point Tile](https://entwine.io/en/latest/entwine-point-tile.html)
driver for [voxelkloud](../../README.md).

```sh
npm install @voxelkloud/format-ept
```

```ts
import { eptFormat } from "@voxelkloud/format-ept";
import { formats, loadPointCloud } from "@voxelkloud/loader";

formats.register(eptFormat);

const { source, tree, openPoints } = await loadPointCloud(
  "https://s3.amazonaws.com/example/ept-dataset/",
);
view.addCloud(source, tree, openPoints);
```

NOT registered by default: a `laszip` dataset needs the wasm LAZ decoder, and an
app that reads neither EPT nor COPC should not carry it.

## What it is

A directory of static files: one `ept.json`, a hierarchy of JSON pages, one
payload per node. **No `Range` support required of the host** — which is why the
USGS 3DEP archive on S3 is published this way, and why pasting one of its URLs
is the shortest path from nothing to a rendered LiDAR survey.

Three payload encodings, all supported:

| `dataType`   | Payload                          | Needs |
| ---          | ---                              | --- |
| `binary`     | the schema packed interleaved    | nothing |
| `laszip`     | a whole LAS file per node        | the wasm LAZ decoder |
| `zstandard`  | a zstd-compressed `binary` block | a `decompress` hook |

No browser exposes zstd to JavaScript, so a `zstandard` dataset needs a
decompressor supplied from outside — the same hook a BROTLI Potree cloud uses:

```ts
openPoints({ decompress: (bytes) => myZstd.decode(bytes) });
```

Without one the error names the hook rather than failing obscurely.

## The one surprise

For `laszip`, **the manifest's schema and the LAS records Entwine actually
writes disagree**. Its schema calls `ScanAngleRank` a 4-byte float; the LAS
record it writes stores a signed byte. So the driver reads the root node's own
LAS header at load time and believes that instead — one extra request, and not
avoidable. For `binary` and `zstandard` the schema is the only description there
is, and it is correct.

## Attribute names

EPT writes `"Intensity"`, `"ReturnNumber"`, `"GpsTime"`. Every other driver here
writes `"intensity"`, `"return number"`, `"gps-time"`, and a colour mode must
not stop working because the cloud was published as EPT — so the names are
translated. `X`/`Y`/`Z` become one `"position"` attribute and `Red`/`Green`/`Blue`
one `"rgb"`; a dimension with no counterpart, like Entwine's `OriginId`, keeps
its own spelling.

## Testing

`demo/potree/pointclouds/` holds the same cloud built four ways — binary,
laszip in LAS 1.2, laszip in LAS 1.4, and zstandard. That is a better oracle
than any of them alone: **two encodings of one dataset must decode to the same
points, and only one of them can be wrong at a time.** The suite compares all
35,091 points of the root node field for field, as sets rather than in order,
because Entwine does not promise a within-node ordering across separate builds.

Those files are gitignored, and the suite skips itself when they are absent.

MIT.
