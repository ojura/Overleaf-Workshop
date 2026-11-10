# Offline previews for Motion Lab

`scripts/motionlab-previews.py` builds small page previews and a version 1
`manifest.json` from a local PDF. The viewer can show the smallest available
preview first, refine it as larger assets arrive, and use optional image placement
regions for Motion Lab cargo. Cargo pixels are copied from the page preview.
Original embedded images are not exported.

The producer binds every result to the exact source bytes, limits native parser
and renderer work in child processes, and publishes completed assets
incrementally. A selected subset of pages is a valid result. The same directory
can be resumed with the same source identity. Explicit priority pages and
spreads are prepared through their requested preview levels before other
selected pages. Without explicit priorities, all selected pages receive their
smallest previews before refinement begins.

## Choose the source workflow

### A build already open in the extension

Run `overleaf-workshop.pdfViewer.exportPreviewSource` with the build PDF open.
The command captures that build, completes any missing bytes in its local disk
cache, then atomically publishes the chosen PDF file and a receipt beside it:

```text
captured.pdf
captured.pdf.preview-source.json
```

A complete cache hit needs no network access. If coverage is incomplete, the
explicit export fetches only the missing ranges with bounded parallel requests
and reports progress by phase. It checks `Content-Range` and the captured
output's validator, stays within the existing cache budget, and never requests
a new compile or a full HTTP 200 fallback download. Cancellation, a build change,
or closing the viewer stops the export before publication. Once published, the
PDF and receipt identify that captured build.

Use the receipt when running the producer:

```sh
python3 scripts/motionlab-previews.py ./captured.pdf \
  --source-receipt ./captured.pdf.preview-source.json \
  --pages 99-100 \
  --priority-spreads 99:100 \
  --require-image-regions
```

The receipt supplies the exact document key and the output directory registered
with the host. The host watches that directory's `manifest.json` and announces
valid publications to the viewer. The producer does not need to start a server.

The receipt's exact shape is:

```json
{
  "version": 1,
  "document": {
    "key": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "size": 12345678,
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "pdf": "captured.pdf",
  "outputDirectory": "/absolute/preview-store/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
}
```

The values above illustrate the format. The producer validates the input's
basename, byte size, and full SHA-256 against the receipt. `--output` defaults to
the receipt's absolute `outputDirectory`. An explicitly supplied `--output` or
`--document-key` must agree with the receipt. Keep the exported document key;
it identifies the host's captured build and need not equal the PDF's SHA-256.

The host implementation is in
[`PdfPreviewStore`](../src/core/pdfPreviewStore.ts) and
[`PdfViewEditorProvider`](../src/core/pdfViewEditorProvider.ts).

### A separate local PDF

Specify a dedicated output directory:

```sh
python3 scripts/motionlab-previews.py ./document.pdf \
  --output ./document-previews \
  --pages 99-100 \
  --priority-pages 100 \
  --tiers 192,512,768,1536
```

Without a receipt or an explicit document key, the key is `sha256:` followed by
the complete source SHA-256. `--document-key` supplies an identity expected by a
particular consumer; the manifest still records the actual source size and hash.

These commands are usage examples. Select page numbers that exist in the input.
Omitting `--pages` selects the whole document.

## Dependencies and capabilities

Use Python 3.10 or newer with Pillow 9.1 or newer. The tested Pillow version is
10.2.0. The producer uses `Image.Resampling`, introduced in the
[Pillow 9.1.0 release](https://pillow.readthedocs.io/en/stable/releasenotes/9.1.0.html).
Native worker limits require POSIX resource limit support. Rendering and
image-region support are separate capabilities:

| Capability | Dependency |
| --- | --- |
| JPEG encoding and image validation | Pillow |
| PyMuPDF rendering and image placement metadata | PyMuPDF |
| Poppler rendering fallback | `pdfinfo` and `pdftoppm` |

`--renderer auto` selects PyMuPDF when it is installed, otherwise Poppler. Use
`--renderer pymupdf` or `--renderer poppler` to select one explicitly. With
PyMuPDF installed, an explicit Poppler render still uses PyMuPDF for page and
image-region metadata. Poppler previews use the CropBox through `pdftoppm
-cropbox`.

PyMuPDF is required for image placement regions. Without it, the producer can
make Poppler previews and reports the missing region capability, with
`imageRegions` omitted. `--require-image-regions` makes missing PyMuPDF a failure
before output generation. This is appropriate when content-aware cargo is a
requirement of the requested run.

The installed Poppler tools were checked with tiny synthetic input. `pdfimages
-list` reports dimensions, resolution, and object information but no placement
x/y. `pdftohtml -xml` emits image placement elements while also writing raster
image files; `pdftohtml -xml -i` omits both. The producer therefore uses the
explicit preview-only fallback when PyMuPDF is absent.

## Options and work order

```text
python3 scripts/motionlab-previews.py INPUT.pdf
  [--output DIR]
  [--source-receipt FILE]
  [--pages 99-100]
  [--priority-pages 100]
  [--priority-spreads 99:100]
  [--tiers 192,512,768,1536]
  [--document-key KEY]
  [--workers 1|2]
  [--max-output-mib 512]
  [--deadline-seconds 600]
  [--job-timeout-seconds 60]
  [--max-worker-mib 4096]
  [--renderer auto|pymupdf|poppler]
  [--require-image-regions]
```

`--output` is required unless a source receipt supplies it. Page numbers are
1-based, with comma-separated pages and inclusive ranges, such as `1,5-8`.
A priority spread names two adjacent selected pages, such as `99:100`; multiple
pairs are comma-separated, and both pages must belong to the selection. Spread
priorities come first within the priority group, followed by `--priority-pages`.

Explicit priorities create a separate first phase. Every priority page receives
a 192-pixel preview before any of those pages receive a larger tier. Their
requested larger tiers then finish in ascending order before work starts on the
remaining selected pages. The remaining pages all receive their smallest
requested tier before any receive larger tiers.

Without `--priority-pages` or `--priority-spreads`, the whole selection follows
the default order: the smallest requested tier for every selected page, then
each larger tier across the selection.

Tier values are the target longest image dimension in pixels. The default
pyramid is `192,512,768,1536`. `--tiers` accepts a distinct subset of these four
values. The explicit priority phase always includes 192, even when that value
was omitted from `--tiers`. Each JPEG preserves the displayed page's aspect
ratio, including its CropBox and intrinsic rotation.

The default is one native worker. `--max-worker-mib` sets a hard limit on virtual
address space (`RLIMIT_AS`); actual resident memory (RSS) must be measured
separately when deciding whether to use two workers. Allow room for both native
jobs and the parent.

| Option | Default | Meaning |
| --- | ---: | --- |
| `--workers` | 1 | One or two simultaneous native jobs |
| `--max-output-mib` | 512 | Total regular-file byte budget in the output directory, including existing bytes and staging reservations |
| `--deadline-seconds` | 600 | Parent deadline for the run, including source hashing |
| `--job-timeout-seconds` | 60 | Wall-time limit for an individual native job |
| `--max-worker-mib` | 4096 | Address-space limit for each native child |
| `--renderer` | `auto` | Backend selection |

One MiB is 1,048,576 bytes. The resource options do not enlarge the manifest
format's hard bounds. `--max-worker-mib` accepts 128 through 16,384 MiB.
The output budget must be positive and at most 1,048,576 MiB; the parent deadline
must be positive and at most 86,400 seconds, and a job deadline must be positive
and at most 3,600 seconds.

## Source identity, publication, and resume

The parent opens the source PDF, computes its full SHA-256 in one streaming pass,
and keeps that original file descriptor open. A small page selection still needs
the full identity check. Each native worker reopens the source by its path and
verifies the device, inode, size, mtime, and ctime fingerprint before and after
its work. Before publishing a result, the parent checks both its original open
file descriptor and the current source path against that fingerprint. The input
must remain the same file throughout the run.

Each completed JPEG is validated and published atomically before an updated
manifest references it. Asset paths are immutable and relative to the output
directory. Manifest publication is also atomic. A reader sees only complete
assets advertised by a complete manifest, including when generation stops after
only part of the requested work.

Rerunning against the same identity merges with the existing manifest and reuses
valid assets after checking file size, SHA-256, JPEG format, and encoded
dimensions. Existing pages outside a new selection remain available. With
PyMuPDF available, a selected page missing `imageRegionsComplete` receives one
occurrence-metadata update at its first scheduled tier. If that tier already
exists, the worker performs metadata inspection only: it creates no JPEG, and
publication changes only the page's occurrence fields in the manifest. Existing
page geometry, asset descriptors, filenames, bytes and pixels remain unchanged.
Only missing tiers invoke raster generation. A present `imageRegionsComplete`
value, including `false`, marks the metadata processed and prevents repeated
enrichment. A manifest for a different document identity causes the output
directory to be refused. Choose a different directory for different source bytes.

The output quota counts regular-file payload bytes already present in the
directory as well as reservations for native-job staging within that directory.
It does not measure filesystem allocation overhead or directory blocks.
Concurrent jobs share the same total budget. Each worker reserves three
per-file allowances for its possible image, metadata, and diagnostics. Metadata
jobs use the same bounded child and atomic manifest publication path. Initial PDF
inspection uses one worker in a separate temporary directory outside the output
directory, with at most two 64 KiB files present at once and the same worker
memory and time limits. The producer enforces these additional hard bounds:

| Item | Bound |
| --- | ---: |
| Source PDF | 4 GiB |
| Source receipt | 16 KiB |
| Document page count | 10,000 |
| Manifest | 4 MiB |
| Individual preview image | 4 MiB |
| Assets per page | 6 |
| Assets in a manifest | 32,768 |
| Asset width and height | 4096 pixels each |
| Image regions per page | 256 |
| Image regions in a manifest | 65,536 |
| Entries already in the output directory | 100,000 |

Native metadata and rendering run in children with wall-time, address-space, and
file-size limits. The parent additionally enforces its deadline and total output
budget. The per-page region cap retains the largest clipped placements. The
global region budget is consumed in publication order. Asset progress includes
the retained region count and `regionsOmitted`, which counts excess placements
removed by the per-page and global caps for that publication.

`get_image_info(hashes=True, xrefs=False)` interprets the page and constructs its
complete occurrence list and image digests. Resource-link validation also reads
the actual image objects. MuPDF can decode JPEG2000 during image loading and
rasterize shadings during interpretation. Capping returned regions alone would
not bound that work, so metadata extraction uses the same child limits as
rendering. For a new raster, the worker reads basic geometry without occurrence
inspection, encodes the JPEG, and releases its Pixmap, Pillow image and render
document. Optional occurrence extraction then opens a separate document, which
closes on success or failure. Raster pixels therefore do not depend on whether
the job also requests metadata. Each worker process handles one job. The relevant
version-pinned sources are linked in [Geometry and source references](#geometry-and-source-references).

### Exit status

| Status | Meaning |
| --- | --- |
| `0` | The requested work completed |
| `3` | A deadline, worker resource limit, output budget, or manifest bound stopped the run; completed publications are retained |
| `2` | Generation, source, dependency, receipt, or argument failure |
| `130` | Interrupted with Ctrl-C / SIGINT |
| `143` | Terminated with SIGTERM after worker and staging cleanup |

Keep any completed publication after a resource-limited run. It can already be
used, and the same command can resume it with an appropriate remaining budget.
A limit reached before the first asset can leave no manifest; the `partial`
event then reports `manifest: null`.

Progress and completion are JSON lines on standard output:

| Event | Useful fields |
| --- | --- |
| `start` | Document identity, full page count, selected page order, tiers, renderer, image-region capability, worker count |
| `asset` | Page number, tier, immutable path, encoded bytes, retained region count, omitted region count |
| `metadata` | Page number, retained region count and omitted region count; existing raster assets are reused |
| `complete` | Manifest path, total published pages/assets, newly published asset count (`publishedAssets`), metadata-only page count (`metadataPages`), output bytes |
| `partial` | Limit reason, manifest path or null, newly published asset count, available totals |

Validation, generation, and command-line syntax failures use an `error` JSON
object on standard error. Interrupt and termination messages use the same
channel. Use these events and the exit code to distinguish completed work,
capability omissions, and resource-limited work.

## Manifest version 1

The consumer contract and validation are defined in
[`pdf-preview-source.ts`](../views/pdf-viewer/src/common/pdf-preview-source.ts).
The producer writes `manifest.json` with this shape. Values below are illustrative:

```json
{
  "version": 1,
  "document": {
    "key": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "size": 12345678,
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "pageCount": 100
  },
  "pages": [
    {
      "pageNumber": 99,
      "width": 300,
      "height": 220,
      "rotation": 0,
      "assets": [
        {
          "path": "assets/page-99-192-bbbbbbbb.jpg",
          "width": 192,
          "height": 141,
          "bytes": 12345,
          "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "mime": "image/jpeg"
        }
      ],
      "imageRegions": [
        {
          "id": "p99-i0",
          "resourceId": "x42",
          "x": 0.1,
          "y": 0.13636363636363635,
          "width": 0.3333333333333333,
          "height": 0.2727272727272727
        }
      ],
      "imageRegionsComplete": true
    }
  ]
}
```

`document.pageCount` is the full PDF's page count, even when `pages` contains only
a selected subset. `document.size` is the source byte count. Both SHA-256 fields
are full hexadecimal hashes: the document hash identifies the source PDF, and
each asset hash identifies the encoded image file.

Page `width` and `height` are points in the displayed, intrinsically rotated
CropBox orientation. `rotation` records the intrinsic PDF rotation, one of
`0`, `90`, `180`, or `270`. The JPEG and image regions already include that
rotation. The browser applies only any additional rotation chosen by the user.
Asset `width` and `height` are pixels, and `bytes` is the encoded file size.

Paths use safe relative components under the output directory, with no absolute
paths or `.`/`..` components. The browser checks identity, byte counts, dimensions,
and image hashes before using a preview. It accepts a page with missing optional
image regions and continues to display its preview pixels.

## Publish previews to the Spomenar site

`scripts/publish-spomenar-previews.py` publishes an existing generated directory
into the site's namespace for one exact PDF SHA-256. It uses only the Python
standard library and imports the format constants from the adjacent
`motionlab-previews.py`, so keep both scripts together at their resolved
installation location. The publisher entry point may be a symlink to that
installation. It reads the manifest and referenced preview assets; it does not
read the PDF or compute its full source hash, and it needs no PyMuPDF or Pillow
installation.

Run it on the destination host with the generated directory available locally:

```sh
python3 scripts/publish-spomenar-previews.py ./document-previews \
  --web-root /var/www/html/spomenar-previews \
  --sha256 EXPECTED_SOURCE_SHA \
  --max-assets-mib 512 \
  --deadline-seconds 120
```

Replace `EXPECTED_SOURCE_SHA` with the full 64-character SHA-256 of the PDF served
by the site. Both `--web-root` and `--sha256` are required, and the web root must
be an explicit absolute path. The supplied digest is normalized to lowercase
for the namespace. The manifest must have `document.key` equal to
`sha256:<SHA>` and `document.sha256` equal to that same lowercase expected digest.
The producer's default document key uses this form. A manifest bound to an
extension-specific captured-build key needs a separate generation using the
site's expected identity.

Use a separate generated directory. The publisher rejects the destination SHA
namespace as its own input before writing.

For the example web root, the publication is stored at:

```text
/var/www/html/spomenar-previews/<SHA>/manifest.json
/var/www/html/spomenar-previews/<SHA>/assets/...
```

The publisher takes one snapshot of the bounded version 1 manifest. The generator
can continue and atomically replace its manifest while that snapshot is being
published. The publisher preserves the captured bytes; a later invocation picks
up subsequent generator updates. A snapshot may contain only some pages or
tiers, with at least one page and an asset for every listed page.

Referenced paths must be canonical relative paths, with no absolute paths,
empty components, `.` or `..`. Symlinks in source and destination data paths,
including their directory components, are refused. The publisher checks each
referenced asset's byte count and SHA-256, copies complete assets atomically with
fsync, and publishes the manifest last. Matching existing assets are verified
and reused. An existing asset with conflicting bytes or hash causes failure;
asset contents are never overwritten. Old immutable assets remain available for
readers that still hold an older manifest. Unrelated directories are left
untouched.

The publisher sets new published files and a new namespace lock to mode `0644`,
and new directories to `0755`. Verified reused assets and an existing lock retain
their modes. Each SHA namespace retains an empty `.publish.lock` file. An existing
lock must be an empty regular file. A second publisher for that same namespace
fails while the lock is held.

### Publication limits and reporting

| Option | Default | Meaning |
| --- | ---: | --- |
| `--max-assets-mib` | 512 | Maximum sum of asset bytes referenced by the incoming manifest snapshot |
| `--deadline-seconds` | 120 | Deadline for the publication attempt |

The asset budget counts the incoming snapshot, including assets already present
at the destination. Old immutable assets are retained, so this budget is not a
ceiling on the namespace's accumulated disk usage. Manifest, asset, path, and
region metadata must also satisfy the version 1 format bounds. The asset budget
must be positive and at most 1,048,576 MiB; the deadline must be positive and at
most 86,400 seconds.

The publisher writes these JSON lines on standard output:

| Event | Fields |
| --- | --- |
| `asset` | `path`, `bytes`, and `copied` (`true` for a new copy, `false` for verified reuse) |
| `complete` | `namespace`, `manifest`, `sha256`, `assets`, `copiedAssets`, `reusedAssets`, `assetBytes`, `manifestBytes` |

Failures write `{"event":"error","message":"..."}` on standard error. Exit codes
are:

| Status | Meaning |
| --- | --- |
| `0` | The snapshot was published successfully |
| `2` | Validation, asset integrity, quota, deadline, or publication failure |
| `130` | Interrupted with Ctrl-C / SIGINT |
| `143` | Terminated with SIGTERM |

SIGINT and SIGTERM request cancellation at safe checkpoints between bounded I/O
operations, allowing temporary files and open resources to be cleaned up.

The last manifest remains the reader's entry point until a new snapshot has
finished publication. A later invocation can publish a newer generator snapshot
for the same source identity.

## Image region geometry

Each region has `{id, x, y, width, height}` and may carry a validated `resourceId`
link to the original PDF image object, such as `x42`. Coordinates are normalized
to `[0,1]` in the same orientation as the page preview. IDs identify placements;
repeated occurrences of one embedded image keep separate region IDs while
sharing their resource link. The page's optional `imageRegionsComplete` field
reports whether validation, supported extraction and the region limits retained
a complete, linked inventory. Ambiguous image identities, inline or unsupported
content, discarded placements and exceeded caps produce `false`. A decoded-image
digest alone cannot identify an occurrence's object: separate objects can have
identical pixels. The producer only links a unique verified resource on an
inspected content tree. Unproven links remain absent. Older manifests without
these fields remain readable and can receive the metadata-only upgrade above.
The consumer's early-delivery and completed-raster fallback rules are described
in [the shared PDF loading guide](pdf-prefetch.md#placement-metadata-and-payload-geometry).

PyMuPDF returns image placement coordinates in the unrotated page space, while
`page.rect` reflects page rotation. Its `page.rotation_matrix` translates between
the two. These behaviors are documented in the
[Page API](https://pymupdf.readthedocs.io/en/latest/page.html#Page.get_image_info).
MuPDF coordinates start at the top left and use points, with 72 points per inch;
see the [coordinate reference](https://pymupdf.readthedocs.io/en/latest/app3.html#coordinates).

For the native PyMuPDF 1.23.7 implementation verified here, the placement bbox
already includes the displacement of a nonzero CropBox origin. Do not subtract
`page.cropbox.x0` or `page.cropbox.y0` again. The conversion is:

```python
page_bounds = page.rect
bounds = fitz.Rect(info["bbox"]) * page.rotation_matrix
bounds = bounds & page_bounds
```

Discard empty or nonfinite rectangles, then normalize the clipped rectangle's
corners against `page_bounds`. Use the transformed bbox's width and height;
`info["width"]` and `info["height"]` are the original raster's pixel dimensions.
Placements wholly outside the crop are omitted, and partial placements are
clipped to it. The browser crops the resulting region from the prepared page
raster, so any other content visible within that rectangle remains part of the
cargo.

### Native fixture evidence

On 2026-11-04, tiny synthetic PDFs were tested on the native host with PyMuPDF
1.23.7, Pillow 10.2.0, and Poppler 24.02.0. The PDFs and probe images were removed
after the checks. The fixture had a 400 by 300 point MediaBox and CropBox
`(50,40,350,260)`. Image A was placed at `(80,70,180,130)` before cropping, image B
at `(30,20,100,80)`, and image C at `(10,275,30,295)`.

At every page rotation, image information returned the crop-relative,
unrotated bboxes A `(30,30,130,90)`, B `(-20,-20,50,40)`, and C
`(-40,235,-20,255)`. Applying the conversion above matched rendered pixel bounds
exactly at one pixel per point:

| Rotation | Preview size | Image A bounds | Image B bounds | Image C |
| ---: | ---: | --- | --- | --- |
| 0 | 300 by 220 | `(30,30,130,90)` | `(0,0,50,40)` | Omitted |
| 90 | 220 by 300 | `(130,30,190,130)` | `(180,0,220,50)` | Omitted |
| 180 | 300 by 220 | `(170,130,270,190)` | `(250,180,300,220)` | Omitted |
| 270 | 220 by 300 | `(30,170,90,270)` | `(0,250,40,300)` | Omitted |

### Geometry and source references

- [PyMuPDF 1.23.7 `get_image_info`](https://github.com/pymupdf/PyMuPDF/blob/1.23.7/fitz/utils.py#L678-L713)
  creates a structured text page and requests image metadata. Asking for xrefs
  forces hashing.
- [PyMuPDF 1.23.7 `extractIMGINFO`](https://github.com/pymupdf/PyMuPDF/blob/1.23.7/fitz/fitz.i#L11558-L11620)
  constructs the complete list, with pixmap creation and MD5 inside the hashing
  branch.
- [PyMuPDF 1.23.7 text-page wrapper](https://github.com/pymupdf/PyMuPDF/blob/1.23.7/fitz/fitz.i#L5089-L5129)
  runs page interpretation with rotation temporarily cleared, then restores it.
- [MuPDF 1.23.7 placement bounds](https://github.com/ArtifexSoftware/mupdf/blob/1.23.7/source/fitz/stext-device.c#L182-L190)
  come from the transformed image rectangle. Its
  [image-preserving text device](https://github.com/ArtifexSoftware/mupdf/blob/1.23.7/source/fitz/stext-device.c#L830-L875)
  also supports rasterized shadings.
- [MuPDF 1.23.7 JPEG2000 loading](https://github.com/ArtifexSoftware/mupdf/blob/1.23.7/source/pdf/pdf-image.c#L248-L295)
  calls the JPEG2000 decoder while loading the image.

## Verification

Run the producer and publisher synthetic regression suites from the repository
root:

```sh
python3 scripts/test_motionlab_previews.py
python3 scripts/test_publish_spomenar_previews.py
```

The fixture geometry above provides concrete expectations for crop offsets,
intrinsic rotation, partial clipping, and omitted off-page placements. Source
identity and receipt checks, output publication, resume, dependencies, and resource
limits also belong in the producer's regression coverage.
