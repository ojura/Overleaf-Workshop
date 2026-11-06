# Independent PDF layout and progressive photographs

`scripts/motionlab-reading.py` produces a source-bound reading representation from
an exact local PDF. The original PDF remains the download and edition identity.
The producer writes a small structural PDF, external encoded image streams and a
separate `reading.json` beside the existing raster-preview manifest.

## Native composition

The structural PDF retains page contents, fonts, resource references, geometry,
clipping, transforms and image dictionaries. Each image stream receives a
`/MotionLabImage (x635)` marker and an empty encoded body. The identifier is the
original image object's xref, scoped by the source SHA. The worker resolves that
identifier through the verified manifest before applying the original filter
chain. Native PDF operators therefore retain the paint order, including text
behind photographs, nested forms, soft masks, explicit masks and PDF Decode
arrays. Selectable text and vector layout do not depend on fetching the original
photograph bodies.

Eligible JPEGs are transcoded through the maintained
`scripts/pdf-jpeg-progressive/coefficients.c` verifier. Every quantized DCT
coefficient, referenced component quantization table, component identifier, sampling factor and color
interpretation must agree. APP markers, including JFIF and Adobe color-transform
metadata, and COM markers are preserved. The source PDF's ColorSpace,
DecodeParms and Decode remain authoritative. CMYK, unsupported JPEG frames,
oversized coefficient sets and non-JPEG images retain their exact original
encoded bytes and native decoding semantics.

## Generate and register

Requirements are Python 3.9 or newer, PyMuPDF, a C compiler and libjpeg development
headers. The producer uses the existing preview protocol for exact-export
receipts, process limits and cancellation. Use an output directory outside the
checkout:

```sh
python3 -B scripts/motionlab-reading.py /absolute/path/book.pdf \
  --output /absolute/path/reading-work \
  --max-output-mib 2048 \
  --deadline-seconds 3600
```

For an extension-exported build, pass its existing receipt. Its output directory
and build key are reused, and the source is checked against the receipt:

```sh
python3 -B scripts/motionlab-reading.py /absolute/path/exported.pdf \
  --source-receipt /absolute/path/export-receipt.json
```

The reading files can share this directory with `manifest.json` and raster
previews. Raster and reading quotas account for their respective files. The
reserved `reading/` namespace cannot be claimed by a raster manifest. The host
discovers sibling `reading.json` through the existing registered preview build;
no additional filesystem setting is required.

Successful generation emits a `complete` JSON event with source identity,
structural-PDF bytes, encoded asset bytes and coverage distributions. Coverage
includes progressive/original counts, fallback reasons and bytes, eligible JPEG
counts and original bytes, maximum pixel count, and median/p95/p99/maximum encoded
and coefficient allocations. Exit 3 is a resumable output-budget or deadline
stop; no completed manifest is advertised. Exit 143 reports termination.

## Verified representation

The format and hard limits have one cross-language definition in
`src/core/pdfReadingFormat.json`. Python and TypeScript run the same complete
valid/invalid examples from `src/test/fixtures/pdfReadingManifest.json`.

`reading.json` contains `version`, original `source` SHA/size/pageCount, the
structural `pdf` path/SHA/bytes and `images`. Each image has an xref `id`, encoded
asset path/SHA/bytes, `originalSha256`, dimensions and `encoding`. Progressive
entries also declare three components, padded coefficient bytes and an ordered
chunk table. Original entries have identical asset and original digests and may
report a fallback reason.

Paths stay within `reading/`; file/child collisions and conflicting shared-path
metadata are rejected. Asset names contain their content hashes:

- `reading/layout-<sha256>.pdf`
- `reading/image-<sha256>.jpg`
- `reading/image-<sha256>.bin`

Progressive chunks partition the asset exactly, with scans numbered 1 through N.
Each chunk ends after the two-byte marker following a complete entropy scan, so
the decoder can recognize that scan without receiving the next scan's header.
The last chunk includes EOI. Every chunk has its own SHA-256, allowing an early
scan to be verified before the complete JPEG arrives. Repeated xrefs may share an
asset only with identical byte identity and chunk partitions.

The current format bounds the manifest at 4 MiB, source at 4 GiB, structural PDF
at 32 MiB, encoded assets at 64 MiB each, pages at 10,000 and images at 32,768.
Progressive conversion accepts verified 8-bit, three-component JPEGs up to
16,777,216 pixels and 64 MiB of padded signed-16-bit coefficients. Original-mode
images remain subject to the shared dimension/pixel/encoded limits. Device
budgets can choose complete native decode when retained progressive state does
not fit; those runtime budgets are separate from publication eligibility.

## First-color precision

The production encoder chooses the largest initial DC successive-approximation
value `Al` from 0 through 4 satisfying:

```text
max(component DC quantizer) * (2**Al - 1) <= 16
```

A DC coefficient contributes `Q[0] / 8` to each component sample in its 8-by-8
block. This bounds the additional DC truncation to two 8-bit component levels
before rounding. It is independent of the detail omitted by an initial DC-only
scan. Low-quality JPEGs with coarse quantizers therefore receive fewer discarded
DC bits, down to exact DC at `Al = 0`. Every discarded bit is refined later and
the complete coefficients remain identical.

For the current book's 4128-by-2322 page-99 photograph x635, whose DC quantizers
are 1, the measured alternatives were:

| Initial DC Al | First complete scan bytes | Complete JPEG bytes | Scans |
| --- | ---: | ---: | ---: |
| 1 | 311,354 | 5,482,709 | 10 |
| 3 | 237,752 | 5,484,436 | 12 |
| 4 | 203,121 | 5,487,566 | 13 |

The adaptive choice retains Al 4 for that image. It reduces first-color bytes by
34.8% relative to the default progression, with 4,857 additional complete-file
bytes. The maintained tests cover Al 0 through 4, low-quality quantizers, Adobe
RGB, exact final pixels and the DC-only error bound. The existing opt-in JPEG
experiment retains its original default progression unless `coefficients` is
explicitly invoked with `--early-dc`.

## Quotas, recovery and publication

The default 2 GiB output quota covers all retained reading assets and metadata.
Before each atomic checkpoint/manifest replacement, both the old file and the
new temporary bytes are charged. Repeated image IDs sharing a tiny asset cannot
grow checkpoint metadata beyond the quota. Native scratch has separate bounded
input/output files and is removed on completion or cancellation.

One exclusive output lock owns resumable `.reading-state.json` and native work.
Resumption verifies the exact source and every reused asset/chunk. If the
encoder/format recipe changed, bounded `--verify-only` checks compare the cached
JPEG's actual referenced quantizers and every coefficient against its original
source stream before reuse. An unused quantization table may be omitted by
libjpeg; changing a referenced table remains a failure. Verified assets retain
their existing bytes and inodes. The source fingerprint is checked throughout generation. The
compiler and native worker have owned process groups; termination and deadlines
release descendants before returning. Completed `reading.json` appears only
after all assets verify, and abandoned owned temporary files are reclaimed under
the same lock.

Publish with the existing manifest-last publisher:

```sh
python3 -B scripts/publish-spomenar-previews.py /absolute/path/reading-work \
  --reading --sha256 ORIGINAL_PDF_SHA256 \
  --web-root /absolute/path/published-previews \
  --max-assets-mib 2048
```

It checks the manifest, source identity, full asset hashes and scan hashes, reuses
matching immutable files, and replaces only `reading.json` after success. The
existing raster atlas remains in place. The publication service binds the
reading-manifest byte digest, original source SHA/size and observed original HTTP
validator in the same atomic catalog config. Its
[upgrade procedure](spomenar-watch.md#upgrading-an-existing-edition) also generates
a missing reading representation for an unchanged current book.

Run the maintained offline gate with `npm run test:spomenar:offline`. It includes
real small-PDF composition, source identity, shared schema, scan verification,
color fidelity, metadata quotas, process cancellation, publication and watcher
migration controls.
