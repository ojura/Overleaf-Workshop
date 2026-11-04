# Slipstream: predictive PDF loading

Slipstream is the shared viewer, predictive loading, and cache layer behind both extension engines and the standalone [Spomenar site](spomenar.md). They use the same controller, [pdf-prefetch.ts](../views/pdf-viewer/src/common/pdf-prefetch.ts), with PDF.js 5.1.91. Each passes its `PDFViewer` to `installPdfPrefetch` once during startup. Document replacement resets the controller through the page lifecycle events. [scroll-prefetch.ts](../views/pdf-viewer/src/common/scroll-prefetch.ts) owns the motion estimator and device cache policies.

## Scheduling and cache layers

The estimator follows CoS's `TimelineScrollDynamics`: react immediately to faster motion or a slower page, then decay the estimates gradually. Wheel events predict motion before the next scroll frame; the controller avoids counting that movement twice. Scroll events cover keyboard navigation and scrollbar movement. A 250 ms gesture gap clears velocity and acceleration, while the document's loading-time estimate remains available. Acceleration is diagnostic; velocity, the latest displacement, and measured page latency determine the preload distance.

The desired distance starts at two viewports, with a 480 px minimum. It grows with speed and page latency, up to twelve viewports or 12,000 px, whichever is smaller, while preserving the base distance for large viewports. Direction changes immediately on reversal.

The controller uses five cache layers:

1. The extension keeps verified content-addressed pieces and incremental range blobs on disk, under one budget across all builds.
2. PDF.js stores received bytes as sparse chunks within its active document.
3. Prepared PDF pages retain PDF.js display operators and decoded resources.
4. Small raster previews cover pages while full-resolution rendering catches up. Mobile retains nearby previews at up to 512 px and reduces older detached previews to 192 px before eviction.
5. PDF.js owns the full-resolution page canvases and their rendering queue.

The persistent [disk cache](../src/core/pdfDiskCache.ts) accepts complete GET requests to `/content/<contentId>/<SHA-256>` when the response bytes match the hash, and verified `output.pdf` ranges with stable validators. A build is represented by byte-interval metadata and received blobs. The host fills missing intervals gradually while every visible reader is idle. The configured `pieceCacheSizeMB` budget, 4096 MiB by default, includes old and new builds, reusable content pieces, range blobs, metadata, and bytes reserved for current writes. A new build does not create a full-size file. `0` disables disk caching and background fill.

The [pinned PDF.js patch](../views/pdf-viewer/vendor/pdfjs-5.1.91-dist.patch) adds `rangeCacheBytes`, `getRangeCacheStats()` and `trimRangeCache()` to the same runtime used by both engines and the website. Reading a range checks that each chunk is resident, including the initial progressive prefix. Old chunks can be fetched again after eviction. Active parsing, asynchronous page work, rendering tasks and detached image decodes hold the bytes they may still need. Once those operations finish, the worker trims its LRU to the selected budget.

The worker budget is its idle residency target. One active PDF stream can exceed it temporarily, so the shared controller also stops new cold-page work while the byte cache is over budget. A completed preparation keeps its admission slot until the worker has answered a trim request. Running and fully prepared native pages can continue. A 250 ms memory check runs only while work or memory pressure remains; it operates even with Motion Lab closed, and stops when the document is hidden or disposed. This lets ongoing work finish and gives the worker a chance to release bytes during continuous scrolling.

Preparation uses small `pdfPage.render()` calls with the display intent shared by native rendering. At most three cold pages on desktop, or two on mobile, are admitted across speculative previews and the auxiliary renders that track native resource preparation. A new cold native render starts only after its small auxiliary render is running. That auxiliary render holds its slot until preparation actually completes. Completed native renders and previews mark resources warm; PDF.js clearing the same page proxy's rendering-intent map revokes that status.

Native visible pages and holes in spread layouts retain their rendering priority. An uncovered visible page blocks further offscreen admission. When scrolling makes an already-started preview obsolete, it becomes `retiring` and finishes while holding its slot. This prevents repeated canvas cancellation from launching unbounded worker decoding. Obsolete `getPage` requests whose render has not started are discarded. Document replacement, layout changes, hidden documents, and disposal still cancel work; completion checks reject stale results.

Full-resolution lookahead stays within two viewports. Counting visible pages and spread holes in that window avoids repeatedly evicting and redrawing pages through PDF.js's default ten-view buffer. Rotation, theme, and optional-content changes invalidate saved previews; zoom can reuse and resize them. Disposing the controller removes listeners and restores the queue methods.

On both device policies, a retained distant preview is sufficient coverage without keeping decoded photo resources. Finished native canvases release their operator lists and every decoded resolution tier, including when the canvas is still visible. The explicit `releaseRenderedResources` policy is separate from mobile's `pruneOffscreen` canvas policy: desktop retains its larger native-canvas window. PDF.js defers resource cleanup until every active render and its operator list have finished. The native canvas and retained preview remain ready, and neither starts another decode merely to warm resources again. A later zoom requests fresh rendering at the new scale.

The [graduated preview cache](../views/pdf-viewer/src/common/pdf-preview-cache.ts) protects visible, attached, and prepared rasters, reduces the oldest unprotected entries first, then evicts only if needed. A returning finished native canvas upgrades its smaller trail preview with `drawImage`, without decoding the PDF again. Replacing an attached raster publishes its new node before releasing the previous bitmap. Failed admissions and canvas-allocation failures wait for the visible-page plan to change instead of retrying on every refresh.

### Display-sized image decoding

`pdfDocumentCacheOptions()` supplies the same document options to the extension's two engines and Spomenar. Both device policies enable adaptive display-image decoding. Mobile admits one image job per document; desktop admits two while retaining its three cold-page preparation slots and larger raster budgets. These limits cover image construction as well as decoding: one admitted collage page can contain many large photographs. Printing requests original detail.

The display proxy derives image density from the page viewport and actual output transform. Auxiliary previews request the native canvas's density so they can prepare the same decoded resources. Resolution is part of the display-intent identity; a prepared higher-resolution intent can satisfy a smaller render, while a larger zoom requests new detail. Warm-resource records carry the same density and are rejected if the new zoom needs more pixels.

The worker composes each image's placement matrix, including nested Form matrices, and rounds the requested dimensions upward. Repeated image XObjects at different sizes have separate cache entries. Tiling patterns use a conservative page-sized bound when the placement cannot be determined. Adaptive intents avoid the original reference-only global image cache, which could otherwise reuse a smaller image at a larger zoom.

Plain, unmasked DeviceRGB JPEGs decode directly to their required bitmap dimensions through the browser's native decoder. Orientation, color conversion and alpha premultiplication options are explicit, and the existing PDF.js JPEG compatibility checks and EXIF removal remain in use. A decoder that returns the wrong dimensions has its bitmap closed. If the native path is unavailable, a fresh JPEG decoder produces scaled pixels; reusing the same compressed stream at a later zoom therefore cannot reuse an earlier small output buffer. Other image semantics keep the existing PDF.js decoding path.

Queued and active image jobs retain their required PDF ranges until completion. Document termination rejects waiting jobs and closes late native bitmaps. Image statistics travel with the existing range-cache statistics request, so the feature adds no separate polling loop.

### Transfer admission

PDF.js can continue worker image and range requests after a render task is cancelled. Before admitting a page whose resources are cold, the controller also checks unfinished viewer fetches. On desktop it pauses new cold native renders and cold preview preparations when at least twelve fetches are pending, or when at least six are pending and the oldest has reached 1,500 ms. Mobile uses thresholds of six and three respectively. Existing running or paused native renders can continue or resume, and pages with fully warmed resources can render from those resources.

These are admission thresholds: one admitted page can request several images, so the number of pending fetches can exceed its threshold. `onFetchChange` schedules a coalesced refresh as requests finish, allowing waiting work to resume from observed completions. The cold-page limit also includes work still decoding after its transfers finish.

### Budgets and thresholds

The authoritative values are selected by `pdfCachePolicy()` in [scroll-prefetch.ts](../views/pdf-viewer/src/common/scroll-prefetch.ts). Phones and tablets use the mobile policy, including iPads with desktop-mode user agents. A touchscreen desktop keeps the desktop policy. Callers can provide an explicit `cachePolicy` to the shared controller.

| Resource | Desktop | Mobile |
|---|---:|---:|
| Planned preparation window | 16 pages | 6 pages |
| Cold page preparations, including pending `getPage` and retiring jobs | 3 | 2 |
| Pending-fetch threshold for pausing cold work at any age | 12 | 6 |
| Pending-fetch threshold when the oldest reaches the age limit | 6 | 3 |
| Oldest-fetch age limit | 1,500 ms | 1,500 ms |
| Full-resolution targets, including visible pages and spread holes | 8 | 3 |
| Full-resolution canvas admission and cleanup target | 192 MiB | 48 MiB |
| Preview maximum dimension | 768 px | 512 px |
| Distant trail preview maximum dimension | No downsampling | 192 px |
| Retained preview raster storage | 64 MiB | 8 MiB |
| Retained preview count | 128 | 128 |
| Sparse worker byte-cache target | 128 MiB | 32 MiB |
| Concurrent adaptive image jobs | 2 | 1 |

Visible pages remain protected. Mobile destroys native canvases outside its current visible/render-ahead plan when their active preparation has finished, even when their total is below 48 MiB. It retains the graduated preview LRU for revisits and releases unneeded display resources. PDF.js also maintains decoded resources outside the raster byte counters.

## Early page previews

Both extension engines and Spomenar use the same [preview-source consumer](../views/pdf-viewer/src/common/pdf-preview-source.ts). The [Motion Lab postprocessor](motionlab-previews.md) prepares 192, 512, 768 and 1536-pixel page images with their intrinsic CropBox orientation and optional photograph placements. These small assets can cover a page while PDF.js prepares its original resources. The shared preview cache owns admitted canvases, so sidecars use the same retention and eviction budgets as previews rendered by PDF.js.

Every source is bound to the exact installed `PDFDocumentProxy`, document identity, byte length and page count. The extension uses its canonical cached-build key and an export receipt; Spomenar additionally matches the published digest against the PDF transport's observed size and HTTP validator. The host watches atomic manifest publication and announces changes to the correct webview generation. An absent or rejected sidecar leaves native rendering available. Idle viewers do not poll for another manifest.

The loader gives every uncovered visible page its smallest usable image before refining either half of a spread. At most two requests occupy the pipeline; cancelled requests retain their slots until cleanup finishes. Phone image decoding is serialized and capped at a 512-pixel longest edge. Desktop permits two decodes with an input edge of at most 1536 pixels, retaining its normal 768-pixel preview size. Encoded dimensions, declared byte counts and SHA-256 are checked before browser decoding; the decoded dimensions are checked again before publication. Hidden documents, replacements, incompatible themes or optional-content changes cancel the binding, and late bitmaps are closed.

The [actual-book generator report](motionlab-book-validation.md) records all 459 public pages, 1,836 preview assets and 1,045 image placements. That public PDF has a separate identity from the evolving 460-page build open in Antigravity.

## Document deliveries and diagnostics

The SVG robot button in every viewer header enables the document effect, which starts on. A page's first substantial visible encounter summons the fleet to carry real rendered fragments into place, including when prefetch has already prepared the page. The controller uses the finished native canvas or an available preview without starting another render for the effect. Thin strips at the viewport edge wait until enough of the page is visible. Offscreen prefetch completions do not start a delivery. A preview and its native replacement share one episode per page and document; revisiting, zooming or toggling a delivered page does not repeat it. The underlying page and its text layer remain readable and selectable.

Before pixels arrive, a visible duplex can receive one advance crew for its actual `.spread` membership. The crew enters and coordinates for a finite interval, then parks without scheduling animation frames. A real preparation-state change can trigger one further gesture. Staging reserves no cargo and does not mark a page as delivered. Once pixels arrive, the delivery reuses the staged actors and their positions. Hidden, removed, failed or replaced work releases those reservations; reduced-motion mode shows static status.

When placement metadata is available, couriers select actual image rectangles from the rendered page preview and deposit them at those images' real locations. Normalized coordinates follow the page's intrinsic rotation and the viewer's additional rotation. The crop preserves the PDF's clipping and colour treatment. Payload snapshots include the image ID; a large photo can receive a shared crew under the same allocation rules as other substantial cargo.

[The document robot module](../views/pdf-viewer/src/common/pdf-document-robots.ts) varies the vehicles, entry sides, paths and ink-bearing fragment targets. It copies small fragments synchronously and never retains the source page canvas. The shared device policy keeps phones, tablets and narrow desktop panes at four couriers, 512 KiB of cargo and 200 KiB of vehicle backing storage. Desktop reading areas at least 700 × 480 CSS pixels use six to twelve couriers, scaled with the available area, under a 3 MiB cargo limit and 24 MiB vehicle-backing limit. Vehicle artwork is redrawn for the actual scale and pixel density, up to DPR 3. In the measured 1076 × 1427 desktop pane, four full pages can receive three couriers each, with vehicles at three times the compact apparent size.

Only visible page IDs wait for capacity; queued work retains no canvas. The first busy offer suspends admission until an active delivery releases capacity. Pages deferred for insufficient visible area retry when container or visual-viewport geometry changes. No retry timer runs at rest. Per-document handled history lives in the renderer and resets only for a replacement document. The pointer-transparent layer follows current page geometry and clips to the visible reading area, keeping the toolbar clear. Finished deliveries stop requesting animation frames; hidden or removed pages, layout invalidation, disabling, document replacement and disposal release active cargo. Reduced-motion mode cancels moving cargo, and a blocked visible offer can resume when that preference is disabled again.

Substantial content-bearing fragments can receive a cooperative crew. A shuffled mix chooses solo, paired, three-vehicle and aerial-ground deliveries. Each payload owns one copied raster, one route and one clock; helpers share it with formation offsets. The larger fragment still counts once against the existing cargo budget, and every helper counts against the actor and vehicle-backing limits. Deposit increments the fragment counter once. Partial crew admission rolls back its sprites, cargo and lab reservations before trying ordinary deliveries.

The UAV–UGV sequence draws on the complementary roles in [Arbanas et al., *Decentralized planning and control for UAV–UGV cooperative teams* (2018)](https://doi.org/10.1007/s10514-018-9712-y). The aerial vehicle approaches with the fragment, meets a ground vehicle, pauses for a visible handoff and landing, then rides or accompanies the ground carrier to the deposit. The shared clock makes that order explicit. Crews return individually to their actual lab origins, or leave the viewport when the lab is closed. The snapshot exposes payload IDs, helper IDs, mode, stage, progress and carrier so these transitions can be inspected.

A separate measurement button opens **LARICS Motion Lab**, initially closed. It also provides the optional **LARICS Fleet dispatch** window for summoning the crew while the document is ready. If the window is open when a document delivery starts, its actors leave from their actual window positions and return there afterward. The same actor is hidden in the window while it is dispatched. Closing the window lets an active courier depart from the viewport instead.

The full PDF.js extension keeps the lab entry in its existing tools menu and the robot button directly in the header. Overleaf's compact viewer moves secondary actions into a More menu below 601 px. Both layouts keep the robot and tools launcher reachable in a 220 px editor pane. Spomenar has enough room for both controls in its phone header.

On mobile, detailed measurements start collapsed behind **Motion and buffer measurements**. The document toggle exposes `aria-pressed`; the lab control exposes `aria-expanded`. Escape closes the panel when focus is inside it. There is no global keyboard shortcut. **Copy measurements** copies a JSON snapshot. In the viewer's developer console:

```js
window.pdfPrefetch.snapshot()
window.pdfPrefetch.setRobotsEnabled(false)
window.pdfPrefetch.robotsEnabled
window.pdfPrefetch.toggleDiagnostics()
window.pdfPrefetch.setDiagnosticsEnabled(false)
window.pdfPrefetch.diagnosticsEnabled
```

[The diagnostics module](../views/pdf-viewer/src/common/prefetch-performance.ts) samples every 250 ms while open. Its charts cover ten seconds; event storage holds the newest 512 events and transfer storage the newest 2,048 samples. Closing the panel or hiding the document stops chart sampling and lab animation. The document effect has its own finite scheduling and works with the lab closed. `installPdfPrefetch` accepts `diagnosticsToolbar`, an optional `robotsEnabled` preference, and an independent `diagnosticsEnabled` initial preference. The controller snapshot includes bounded document-robot counters and the optional lab state for performance inspection.

| Measurement | Meaning |
|---|---|
| Velocity | Conservative speed estimate, signed by direction in the UI. The snapshot stores magnitude in px/ms and direction separately. |
| Acceleration | Smoothed derivative of signed input speed; resets at reversal or gesture end. |
| Measured load delay | Fast-rising, slowly decaying estimate from preview preparation and native page renders. |
| Ready distance | Contiguous distance beyond the viewport with a finished native render or retained preview. It becomes zero when a visible page is uncovered. |
| Buffered time | Ready distance divided by estimated speed. |
| Time margin | Buffered time minus measured load delay. A negative value means the available coverage is shorter than the estimated loading time. At rest the time fields are `null`, shown as “idle”. |
| Viewer fetch throughput | Bytes delivered through the viewer fetch bridge, including cache hits, over a rolling five-second window. Bytes are distributed across each transfer's measured duration. |
| Preview targets | `prepared` is the current plan's page IDs. `pending` lists unfinished admitted preparations, including the `retiring` subset that is finishing obsolete work. `previewPages` counts retained raster previews. |
| Preview source | `previewSource` exposes source state, manifest and asset request counts, available page coverage, pending work and decode activity. Sidecar events enter the same bounded performance event buffer. |
| Transfer pressure | `fetchBackpressure` reports the request-admission condition. The performance snapshot includes `pendingFetchCount` and `oldestFetchMs`. |
| Device retention | `cachePolicy` and `cacheLimits` expose the selected device budget. `rangeCache` reports worker residency, eviction and peak byte counts. `memoryBackpressure` explains when new cold work is waiting for cleanup. Results from replaced documents are discarded. |
| Decoded images | `decodedImages` counts retained image backing buffers and estimates bitmap storage as width × height × four bytes. Shared objects and aliased buffers are counted once, with shared storage attributed first. The scan is bounded to 512 page views and 512 stored objects; unsupported or incomplete results are labeled. These readings are separate from raw PDF bytes, preview rasters, native canvases, and total browser memory. |
| Image decoding | The worker statistics include current and peak active image jobs, queued jobs, completed native and fallback decodes, and cumulative original/output pixel counts. They use the existing byte-statistics request and stop with its lifecycle. Pixel totals describe decoded work; retained memory is reported separately by `decodedImages`. |
| Disk accumulation | `performance.diskCache` reports this build's stored/total bytes, all builds' disk usage and budget, and whether filling is active, paused or complete. Host updates are coalesced to at most one per second. |
| Idle fill eligibility | `idle` becomes true only with a covered viewport, no motion, no cold-page jobs, no foreground fetches, no active native render and no unsettled worker-byte operations or memory pressure. Both extension engines send this state with their page ID and displayed build ID. Motion, fetch admission, rendering, hiding and disposal revoke it immediately. |
| Visible-content status | `visibleMissing` lists visible pages awaiting both a full render and a preview; `starved` is true when that list is nonempty. |

The time margin extrapolates the present speed and recent loading cost. Abrupt jumps and changes in page complexity change those estimates.

## Verification

From the checkout:

```sh
node node_modules/typescript/bin/tsc -p ./
node node_modules/.bin/mocha "out/test/**/*.test.js"
```

The suites cover gesture dynamics, reversal, visible rendering priority, bounded preparation, spread holes, stale document completions, preview retention and cleanup, queue restoration, throughput accounting, actual worker image decoding, sparse byte refetches, disk accumulation, and document-courier lifecycle.

The initial extension implementation at `0681c21` passed 678 Mocha tests and the build on 2026-11-04. Its benchmark results below precede the standalone site and device-specific retention changes. The follow-up at `ec52ed4`, integrated with the local-project workflow change, passed 831 Mocha tests and all four Node API checks. Both extension viewers, the host, chat view and standalone site built successfully. It adds mobile device selection, native-canvas pruning, long-traverse preview bounds, host idle leases, actual adaptive-worker regressions and document-delivery lifecycle tests.

The [physical iPhone report](spomenar-mobile-validation.md) records the adaptive follow-up on the actual 459-page, 1.61 GB book, including decoded-image memory, native browser memory, visible coverage, transferred bytes, idle CPU and document deliveries. Its exact measurements are retained in [spomenar-mobile-metrics.json](spomenar-mobile-metrics.json).

The [live desktop report](pdf-desktop-validation.md) records installed `7c70643` in Antigravity against the subsequent 460-page build: completed photo and 270% zoom renders at the 2.915-second and 1.491-second checkpoints, twelve active couriers, cooperative shared cargo, exact reader restoration and continuing disk accumulation after idle. Its [numeric record](pdf-desktop-metrics.json) preserves the measured values.

The [prefetch probe](../scripts/pdf-viewer-harness/probes/prefetch.mjs) compares native scheduling with the shared controller for both engines:

```sh
npm run build-pdf-viewer
node scripts/pdf-viewer-harness/probes/prefetch.mjs --headless yes --latency 60 --port 8786
```

See [harness requirements](../scripts/pdf-viewer-harness/README.md#requirements). The probe uses an owned browser and test server, writes `prefetch-results.json` and `prefetch-dashboard.png` under `$PDF_VIEWER_HARNESS_WORK` or `/tmp/pdf-viewer-harness`, then closes its browser and server.

### Synthetic benchmark, 2026-11-04

The measured document had 120 pages and 125,953,367 bytes, with about 1 MiB of image payload per page. The viewport was 1200 × 900. Each response had 60 ms of added latency. Each run scrolled for three seconds at 3 pages/s, three seconds at 10 pages/s, then three seconds backward at 7 pages/s.

“Visible-content missing time” is the percentage of sampled elapsed time when at least one visible page had neither a finished native render nor an attached preview. The probe weights samples by frame duration.

| Engine | Motion | Native missing time | Predictive missing time |
|---|---|---:|---:|
| pdfjs | Forward, 3 pages/s | 0% | 0% |
| pdfjs | Forward, 10 pages/s | 94.07% | 0% |
| pdfjs | Reverse, 7 pages/s | 1.51% | 0.551% |
| Overleaf | Forward, 3 pages/s | 0% | 0% |
| Overleaf | Forward, 10 pages/s | 94.06% | 0% |
| Overleaf | Reverse, 7 pages/s | 1.56% | 0.555% |

The predictive reverse phases each had one missing interval of 16.6 to 16.7 ms. The 95th-percentile frame interval was 16.7 to 16.8 ms across the runs. Peak predictive storage was 65,691,648 preview bytes (62.65 MiB) and 68,448,000 native canvas bytes (65.28 MiB), with three pending preparations and a maximum requested lead of 10,416 px.

Across each complete run, delivered bridge bytes increased from 58,055,718 to 66,336,012 in both engines, about 14.3%. Every run completed without a recorded browser or bridge error and without a whole-PDF output request. All zoom, controller-preservation, and document-replacement checks passed. All four cases ran on AC power, charging at 42% to 43%, recorded before and after each case.

### Real LARICS book, 2026-11-04

The book contained 459 pages and 1,608,644,855 bytes. Each final engine run started at page 60 and used three-second phases at 3 pages/s, 10 pages/s, and then 7 pages/s in reverse. Both used AC power over a user-reported 5G connection, charging at 29% during the Overleaf run and 40% during the pdfjs run. Network conditions were uncontrolled across these separate runs.

| Engine | Missing time, 3 pages/s | Missing time, 10 pages/s | Missing time, reverse 7 pages/s | Stop to full render | Bytes through full recovery |
|---|---:|---:|---:|---:|---:|
| Overleaf | 0% | 95.61% | 100% | 21.87 s | 111,147,401 |
| pdfjs | 41.62% | 100% | 100% | 16.35 s | 83,360,137 |

The 95th-percentile frame interval was 16.7 ms in Overleaf and 16.7 to 16.8 ms in pdfjs. The pdfjs viewport acquired preview coverage at 16.15 s, before full rendering completed. Final retained previews occupied 38.32 MB in each run; native canvases occupied 34.22 MB in Overleaf and 41.07 MB in pdfjs. The runs recorded zero errors and zero failed pages. The pdfjs run reached at most three cold jobs and made 177 PDF range requests through settling, with zero whole-PDF requests. Fast traversal of new image-heavy pages exceeded preparation throughput; the three-page admission limit kept outstanding cold page work bounded while decoding caught up.
