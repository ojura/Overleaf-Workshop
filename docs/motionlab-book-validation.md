# LARICS Motion Lab public-book generation

On 4 November 2026, the generator completed a four-level preview pyramid for the public **459-page, 1,608,644,855-byte** LARICS book. The completed set contains **1,836 JPEG assets and 1,045 image placements**, occupying **179,305,543 bytes including the manifest**. Generation is complete; publication and live viewer consumption are the next validation steps.

Exact values are retained in [motionlab-book-metrics.json](motionlab-book-metrics.json). See [Motion Lab previews](motionlab-previews.md) for generation, import and consumer behavior.

## Exact document identity

The manifest binds the pyramid to SHA-256 `7ff0909e635aa4c4d65aeaa7903397da40cc8f2168af5d3c817cad8e59e496e6`, byte length 1,608,644,855 and page count 459. Its key is the `sha256:` prefix followed by that digest.

This is the public book used by Spomenar. The current live Antigravity book has 460 pages and 1,608,164,635 bytes; its build `1a1a762ffd7-eac7495dfa2ef4ed` needs its own export receipt and generated manifest. The [desktop validation](pdf-desktop-validation.md) records that live document separately.

## Duplex check and full resume

The first run prioritized physical pages **99 and 100**, which display printed labels **88 and 89**. Both have a 612 × 792 point page rectangle and intrinsic rotation 0. The first page supplies ten image placements and the second supplies seventeen. The visual check confirmed the printed pair and the placement rectangles against the rendered pages.

| Run | Workers | Newly generated assets | Total assets after run | Output bytes including manifest | Elapsed seconds | GNU time maximum RSS, KiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Initial pages 99–100 | 1 | 8 | 8 | 699,246 | 5.82 | 128,012 |
| Full book, resumed | 2 | 1,828 | 1,836 | 179,305,543 | 153.65 | 207,156 |

Both GNU time records report exit code 0. The full run used niceness 10 and reused the eight completed assets from the initial duplex run. The RSS column is GNU time's reported maximum RSS, not a summed measurement of simultaneously resident workers.

The two 192-pixel duplex assets total **13,938 bytes**. Their 512-pixel refinements total **71,457 bytes**. Each half has its own raster, allowing the first ready half to be displayed while its partner finishes.

## Completed pyramid

| Maximum raster dimension | Asset count | JPEG bytes |
| --- | ---: | ---: |
| 192 pixels | 459 | 2,853,963 |
| 512 pixels | 459 | 18,415,162 |
| 768 pixels | 459 | 37,543,324 |
| 1,536 pixels | 459 | 119,897,940 |
| All tiers | 1,836 | 178,710,389 |

The final manifest adds 595,154 bytes. The largest single JPEG is 399,813 bytes. Every page has all four tiers, and every listed file exists with the advertised byte count.

The manifest contains 1,045 normalized image-placement rectangles on 280 pages, with at most seventeen placements on one page. All 459 page entries have intrinsic rotation 0. The placements describe PDF image locations; the viewer uses them to crop the already rendered preview or native page pixels, preserving the PDF's clipping and color treatment.

## Validation and retained evidence

The generator's 24 Python tests passed. The actual TypeScript consumer validator also accepted the cropped and rotated test fixture. The recorded real-book run produced eight `asset` events for the initial pair and 1,828 for the full resume, each enclosed by one `start` and one `complete` event.

The read-only metadata check loaded the manifest, the two JSONL logs and the GNU time files on Steffy. It checked file existence and sizes for all 1,836 assets without rereading the source PDF or decoding the generated images. The evidence directory is `/home/juraj/.cache/larics-motionlab/book-previews-20261104`; its parent contains `book-two-page.jsonl`, `book-two-page.time`, `book-full.jsonl` and `book-full.time`. The compact metrics record includes the final manifest digest and the measured values.
