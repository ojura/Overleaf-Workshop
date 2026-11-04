# Live desktop PDF validation

The installed `7c70643` extension had completed the live LARICS photo spread at the **2.915-second checkpoint**, then completed a **270% native render by the 1.491-second zoom checkpoint**. The document fleet reached twelve couriers, including three helpers carrying one shared fragment. After restoring the reader, all couriers released their cargo and stopped scheduling frames while the desktop disk cache continued accumulating PDF coverage.

The exact numeric record is [pdf-desktop-metrics.json](pdf-desktop-metrics.json). This observation ran on 4 November 2026 in the existing Antigravity book window, using the full `pdfjs` engine and patched PDF.js 5.1.91. The current compiled book contained **460 pages and 1,608,164,635 bytes**. The earlier 459-page phone and cold-network harness results describe a different compiled representation.

## Measurement conditions

This was a short functional and performance check in an existing reader session with its caches preserved. It visited physical page 90, increased zoom from 90% to 270%, then restored the latest saved reader state. Network and power conditions were not controlled for a comparative benchmark.

The occluded Wayland/Electron window initially advanced timers but supplied no animation frames, including in the parent workbench. The validated run used a temporary top-level `Emulation.setFocusEmulationEnabled` lease, following the existing CoS background-rendering technique. Each lease was bounded below sixty seconds, disabled in `finally`, and detached. The native window remained in the background. Trusted pointer, wheel, key and touch input would stop the driver; no such input occurred.

The probe sampled readiness about every 120 ms, required at least 1.2 seconds of observation, and captured cooperative screenshots during the photo phase. The checkpoint times therefore include observation and capture work. The photo capture recorded requestAnimationFrame interval p95 values of 23 ms in the PDF viewer and 22 ms in the workbench. Document robot painting has its own frame gate, so these clocks measure viewer scheduling rather than the courier paint cadence. The earlier observation with no animation frames is excluded from performance comparisons.

## Photo pixels and zoom detail

| Check | Observed result |
| --- | --- |
| Requested physical page | 90, printed label 79 |
| Initial visible pages at 90% | Physical 89–92, printed labels 78–81 |
| Initial visible pages complete at checkpoint | 2,915 ms |
| Initial native canvas size, each visible page | 598 × 850 pixels |
| Zoomed physical page | 90 at 270% |
| Zoomed native render complete at checkpoint | 1,491 ms |
| Zoomed native canvas size | 1,796 × 2,551 pixels |
| Peak retained decoded-image estimate during the photo check | 11,784,192 bytes |
| Peak simultaneous image jobs | 2 |
| Photo-check native canvas peak | 67,178,352 bytes |
| Photo-check retained preview peak | 63,879,072 bytes |

The display-image intent changed from `2___image_1.4142135623730951_864` to `2___image_4_2560`. The larger native canvas and visibly finer text and photograph detail confirmed fresh zoom rendering. The completed pages' rendering-intent maps were empty after their resources were released.

The worker's cumulative counters rose from 187 to 322 native image decodes during the visit, zoom and restoration, with zero fallbacks. Original-pixel work rose from 1,244,403,920 to 2,066,830,864 pixels; output-pixel work rose from 19,010,118 to 33,765,678 pixels. The active sparse-byte peak reached 197,787,648 bytes and returned to the configured 134,217,728-byte target after work drained.

## Cooperative delivery and idle release

Screenshots captured large couriers carrying actual rendered collage pixels. The sampled fleet reached twelve actors. On physical page 89, payload 60 had helpers 71, 72 and 73 in one shared formation, with one fragment target and one progress clock.

The stationary follow-up waited for native work to settle and then observed a 4,058 ms idle-fill phase. The robot frame counter stayed at 315. Active episodes, couriers, payloads, cargo bytes and sprite bytes were all zero, and `scheduled` stayed false. Visible pages were ready, with no failed pages, pending preparations, foreground fetches, worker operations, worker range dependencies, or active/queued image jobs. The raw-byte cache held exactly 128 MiB. The retained-image accounting reported 11,784,192 bytes of bitmap RGBA estimates; the final preview and native-canvas totals were 63,879,072 and 56,984,768 bytes.

During that idle observation, shared disk coverage for the current document increased from **1,119,983,081 to 1,120,769,513 bytes**, a gain of **786,432 bytes**, while `filling` became true. The shared store occupied 1,865,301,559 bytes against its 4 GiB budget. Coverage can reuse content already present in the shared store, so newly covered document bytes need not equal growth in physical disk bytes.

## Reader restoration and evidence

The driver restored physical page **425**, scale value `"0.9"`, rotation 0, vertical scrolling, odd spreads, `scrollTop: 182267`, and `scrollLeft: 0`. Document robots remained enabled and the measurements panel remained closed. The stationary follow-up confirmed the same state. The engine was not switched during this check.

The workbench's **Compile Project (Ctrl+Alt+B)** control was visible and enabled, measuring 22 × 22 CSS pixels. The validation did not start a compile.

The numeric record names the original traces and three inspected screenshots in `/tmp/spomenar-book-state-XR0QLA`. It retains phase timings, raster sizes, image-intent keys, decoder counters, cooperative payload membership, cache progress, exact restoration checks and successful lease release. Browser target IDs and request capabilities are omitted from the repository copy.

The installed revision had passed **903 Mocha tests and four Node API checks**, with viewer/site builds and lint passing. These measurements precede the sidecar-preview and advance-crew revision.

## Scroll-follow follow-up on `9af6bee`

The user subsequently reported that pages scroll smoothly while the robots follow in visible steps. Independent source review found a direct attachment mismatch: `pdf-document-robots.ts` placed the transit layer in a fixed element under `document.body`, projected page-local cargo destinations through `getBoundingClientRect()`, and updated them through a 30 fps paint gate. Browser scrolling can move the page between those paint updates. The gate also discarded its fractional remainder, allowing an extra refresh interval before the next paint. The separate Motion Lab renderer's draw-duration counters measured the lab canvas, not these document couriers.

A passive 25,002.1 ms observation of the existing book captured 677 animation callbacks, with a 16.7 ms median interval and 16.8 ms p99. One 14,139.3 ms callback suspension accounted for the low average callback rate. The document remained visible but unfocused. There were zero scroll events, zero active robot layers and zero long tasks; the reader stayed on physical page 309 at scroll offset 131879. The document robot frame count stayed at 1280 and scheduling stayed off. Thus this trace records the idle condition; the scroll-follow diagnosis comes from the attachment code and the user's observation.

The probe spent 10.4 ms in total sampling, with a 0.4 ms maximum sample, then removed its observers and animation callback and detached. Its original trace is `/tmp/spomenar-book-state-XR0QLA/robot-scroll-passive.json`. The correction and its live verification are tracked separately from the earlier viewer-clock results above.

An isolated offscreen fixture in the existing Chromium workbench then checked the proposed scroll-local attachment directly, without changing the reader. A synthetic page and its actor both moved by `(-37, -53)` CSS pixels after scrolling, with the actor transform unchanged and no animation frames requested. A fixed-overlay control kept its actor at `(0, 0)` displacement while its page moved by `(-17, -29)`.

The fixture's scrollable area remained exactly `1800 × 2400` with `contain: layout size` and a child translated to `(200000, 300000)`. A size-only negative control expanded it to `200256 × 300160`; restoring layout containment returned the original dimensions. This matches [CSS Containment 2, layout containment](https://www.w3.org/TR/css-contain-2/#containment-layout), which treats visible overflow of a layout-contained box as ink overflow. Focus was unchanged and the fixture was removed. The numeric evidence is `/tmp/spomenar-book-state-XR0QLA/scroll-local-ink-result.json`.

A second fixture checked the final shared stacking rules with the actual current stylesheet. The scroll container computed to `z-index: auto`, while its direct PDF content computed to `isolation: isolate`. Page and annotation offset parents stayed unchanged, with page offsets `(200, 600)` and scroll extent `1800 × 2400`. The courier painted above the body-mounted lab; toolbar and sidebar painted above page annotations. Removing inner isolation made annotations cover those controls, and the old outer stacking boundary put the courier below the lab. The lab stayed at `(240, 80, 140, 80)` and outside the scroll container's input ancestry. Page and actor again moved together by `(-37, -53)` without a transform update or animation frame. Clipping, fixture removal and unchanged focus were verified. Evidence: `document-stacking-current.json` and `document-stacking-before.json` in the same directory.

## Heavy duplex baseline on `9af6bee`

At the user's request, the profiler actively scrolled the existing full PDF.js reader at 90% zoom in odd-spread duplex mode. It captured the latest reader state before starting and restored physical page 93, `scrollTop: 39153`, and the original horizontal offset, modes and controls afterward. The initial spread was physical pages 93–94. This build had 460 pages and 1,608,612,206 bytes, confirmed in all 74 raw trace observations of its length. The run kept existing caches and ran before exact-build desktop sidecars were generated.

Eight native `scrollBy` calls each requested four viewports, or 5,708 CSS pixels: four forward, then four reverse, spaced about 1,400 ms apart. The reader travelled about 45,661 pixels through physical pages 93–145 and back. The active scrolling phase lasted 11.374 seconds; the full observation lasted 18.183 seconds. Low-rate CPU profiling used a 10 ms sampling interval, while coarse state samples ran at about 4 Hz. A bounded background focus-emulation lease kept the existing reader's render clock running; it was released and the profiler detached after exact state restoration. No trusted-input interruption or document replacement occurred.

| Measurement | Active scrolling baseline |
|---|---:|
| Animation callbacks per second | 55.54 |
| Median frame interval | 17.5 ms |
| 95th-percentile interval | 26.4 ms |
| 99th-percentile interval | 34.9 ms |
| Longest interval | 52.2 ms |
| Intervals above 25 ms | 34 of 631 |
| Intervals above 50 ms | 2 of 631 |
| Document courier paints per second | 50.59 |
| Peak courier paint rate in a 253 ms sample | 98.74/s |

The whole trace contained one 62 ms long task. Chrome's main-thread counters increased by 9.288 seconds of task duration, 2.417 seconds of script duration, 0.239 seconds of layout duration and 0.307 seconds of style recalculation. The viewer completed 850 fetches carrying about 1.185 GB, including host cache hits.

The leading sampled costs were `arrayBuffer` body materialization at 1,457.417 ms, garbage collection at 783.933 ms, and `Response` construction at 604.187 ms. Document fleet `paint` accounted for 162.117 ms inclusive; `setVisibleWork` accounted for 191.917 ms inclusive and controller `refresh` for 765.750 ms inclusive. These nested inclusive costs must not be added together. The original bridge wrapped already-delivered bytes in a new binary `Response`, and the pinned loader then called `arrayBuffer`, explaining the two measured materialization sites.

The courier count also confirmed a separate defect: synchronous work updates bypassed the nominal animation cap. The correction routes those updates through the same 30 Hz gate as animation callbacks, while scroll-local attachment lets the compositor move existing sprites continuously. The shared byte-stream response helper targets the larger measured copy cost. The matched post-install run uses the same scrolling scenario before generating desktop sidecars. Its exact numeric comparison is recorded in [pdf-heavy-scroll-metrics.json](pdf-heavy-scroll-metrics.json).

## Follow-up implementation checks

The final combined follow-up gate passed **1,014 Mocha tests and four Node API checks**, host and both viewer builds, the Spomenar build, lint, strict typing of the owned browser entry points, and `git diff --check`. Hashes of changed source files matched before and after the run. Its command records and logs are in `/tmp/spomenar-reviewed-gate-20261104-tykfzj06`. The unchanged Python components retain their preceding 24 generator and 27 publisher passes. The [structural review record](pdf-architecture-review.md) records the three independent review lenses, accepted corrections and retained compatibility boundaries.

The focused renderer, artwork and diagnostics set passed **79 cases**. It includes direct-update paint-cap coverage, deferred parked updates, reentrant capacity admission, no-frame compositor scrolling, parked-anchor stability, ground deliveries and exact-once cancellation. Independent review found that a new mast could expose its border before its first gated geometry paint. A regression reproduced that unpositioned visibility, then passed after all deferred scene elements adopted one hidden-until-positioned initializer. The artwork's shared attachment definition supplies document mast and cargo geometry; tests measure the actual painted rails at compact and desktop scales. A five-pixel negative-control drift failed the external-mast alignment assertion.

The focused bridge and pinned-transport set passed **18 cases**. The old binary `Response` path failed the owned-buffer allocation assertion, and disabling only the two-site loader adaptation produced two unwanted native `arrayBuffer` materializations. The corrected path produced zero. The ownership regression transfers and detaches two delivered range buffers while retaining an oversized cached piece and its existing subarray, then serves the second range from that retained piece without another fetch.

An additional in-memory check ran the production helper in the existing Chromium 142.0.7444.175 workbench. It verified original-buffer transfer and detachment, full-span consumption through EOF with zero native materializations, reader unlock, exact sliced boundaries, and independent raw-reader bytes after cloning. It made no DOM or reader changes and detached afterward. Evidence: `/tmp/spomenar-book-state-XR0QLA/byte-ownership-chromium.json`.

The cache and bridge set passed **45 cases** after a second live cache writer reproduced a representation change between multipart reads. All parts now use one captured manifest, validator and set of read plans; a missing captured blob rejects the whole cache hit. Conditional `If-Range` requests reach the origin for evaluation. Restoring the previous per-part read loop failed both the retained-blob and evicted-blob transition cases.

The shared motion-policy set passed **106 cases**. A nondefault 1,000 ms gesture gap now reaches both the estimator and controller settlement timer. Sidecar decode settings belong to the selected cache policy, with an isolated fallback for legacy custom objects. Exact desktop and mobile edge, concurrency and area limits remain covered, including the original mobile area cap.

## Installed build and matched heavy scrolling on `36d99a2`

The installed extension matched all **463 runtime files**, totaling 12,532,155 bytes, plus its manifest and translations. Both existing Antigravity hosts reloaded successfully and restored their freshly captured reader states and editor groups. The book and TurtleSim replicas remained clean, with 1,154 and 94 unchanged files respectively. The book's newer automatic build contained **460 pages and 1,608,358,464 bytes**; all 76 length observations in the matched trace agree.

The matched run repeated the eight native four-viewport scrolls, the 1,400 ms pacing, 90% zoom, odd spreads and 45,661-pixel total travel before desktop sidecars were available. It visited pages 93–147 and returned to page 93. The viewport was 1,246 × 1,427 CSS pixels. No trusted-input interruption or document replacement occurred. The driver restored every captured reader setting and offset, released its focus-emulation lease, removed its observers and detached.

| Measurement | `9af6bee` baseline | `36d99a2` |
| --- | ---: | ---: |
| Active scrolling duration | 11,373.7 ms | 11,392.5 ms |
| Animation callbacks per second | 55.540 | 56.336 |
| Median interval | 17.5 ms | 17.4 ms |
| 95th-percentile interval | 26.4 ms | 22.5 ms |
| 99th-percentile interval | 34.9 ms | 35.1 ms |
| Longest interval | 52.2 ms | 51.6 ms |
| Intervals above 25 ms | 34 of 631 | 14 of 641 |
| Intervals above 50 ms | 2 | 1 |
| Courier paints during the full observation | 575 | 267 |
| Active courier paints per second | 50.59 | 23.17 |
| Completed response bytes | 1,184,886,977 | 841,361,908 |
| Completed responses | 850 | 740 |
| PDF main-thread task duration | 9.288 s | 7.329 s |
| Script duration | 2.417 s | 1.990 s |
| Sampled native `arrayBuffer` time | 1,457.417 ms | 0 ms |
| Sampled `Response` construction | 604.187 ms | 20.042 ms |

The native body-materialization hotspot disappeared from the sampled profile after the shared response helper and loader adaptation. The matched trace delivered 29% fewer response bytes from a newer representation and existing caches, so the task-duration change includes a different byte workload. The JSON record retains the actual byte totals and normalized costs alongside the raw timings. It also retains missing-page samples: 132 of 350 baseline page slots and 138 of 380 matched slots. Useful-preview coverage is checked separately after sidecar activation.

Actual document paint instrumentation measured **93.4 ms across 267 paints**, or **0.350 ms per paint** on average. The lifetime maximum remained 8.2 ms. During the final **4,329.9 ms** idle observation, the frame count stayed at 507, with zero actors, cargo and scheduled work. The shared paint gate removes redundant updates while the browser's scroll layer carries the sprites with the pages.

Evidence is retained under `/tmp/spomenar-book-state-XR0QLA/robot-scroll-heavy-pdfjs-matched36d99a2-1*`, with installation and activation records in the same directory. The repository JSON includes the sanitized profiler aggregates and exact before/after metrics.

## Exact-build export and desktop preview atlas

The normal **Export PDF for LARICS Motion Lab** command exported build `1a1a80d2f06-11f9b2b799411a3c` in approximately **124 seconds**, including completion of missing cached ranges. The 1,608,358,464-byte file's independently computed SHA-256 is `6abb3d0b13d2970bca0f613287a6ea5d30280be14435b5c681b8ca8bd61d24d0`; it matches the current public PDF. The receipt key is `ef62b518041153d09c5c5d56937a1abf63e407c9415436416b73800922ae32f4`.

The desktop atlas contains **460 pages, 1,840 JPEGs and 1,045 image placements**, with 192-, 512-, 768- and 1,536-pixel tiers. Every asset was independently checked for format, dimensions, byte count and SHA-256. The images occupy 203,910,202 bytes and the manifest adds 607,866 bytes. Priority pages 99–100 completed in 5.347 seconds. A process interruption left 1,595 valid assets; the verified resume generated only the remaining 245 and completed in 30.218 seconds. All eight priority assets were unchanged.

At export completion the desktop cache covered the complete PDF, while total persistent usage was 2,755,291,949 bytes against the 4 GiB budget. Settings were restored byte-for-byte; `main.tex` regained focus, and page 93, 90% zoom, odd spreads and offset 39153 were preserved. Evidence and full verification records are in `/tmp/spomenar-motionlab-live-20261104-m3BPGo/`.

## Exact-atlas consumption in both engines on `3cb12a3`

The installed JPEG compatibility correction accepts Antigravity's `image/jpg` response header as the standard `image/jpeg` alias. It preserves the manifest's hash, size, geometry and image-format checks. All 391 installed viewer files matched the build, totaling 11,419,868 bytes, and both engine bundles contained the correction.

The existing book window then completed a full → native Overleaf → full cycle on the exact 460-page, 1,608,358,464-byte build and atlas described above. Both photo-spread probes visited physical pages 99–100 at 90% in odd spreads, retaining existing caches. The compact record is [pdf-sidecar-live-metrics.json](pdf-sidecar-live-metrics.json).

| Observation | Native Overleaf PDF.js | Full PDF.js |
| --- | ---: | ---: |
| Page 99, 192-pixel preview ready event | 65.8 ms | 38.2 ms |
| Page 100, 192-pixel preview ready event | 70.4 ms | 42.0 ms |
| Page 99, 768-pixel preview ready event | 99.8 ms | 58.6 ms |
| Page 100, 768-pixel preview ready event | 99.0 ms | 59.6 ms |
| First coarse observation with both pages supplied | 266.2 ms | 262.2 ms |
| Rejected preview images at probe completion | 0 | 0 |
| Peak document actors | 8 | 8 |
| Peak cargo bitmap bytes | 428,524 | 287,240 |
| Peak sprite bitmap bytes | 1,511,424 | 1,511,424 |
| Actor/page relative scroll error, five measured steps | 0 px | 0 px |
| Robot frame count across final 1.5-second idle | 141 → 141 | 166 → 166 |

At the first coverage observation, physical page 100 still had no native canvas; its 541 × 768 preview supplied the page. The screenshots show real book photographs in the cargo. The native quad's `p99-i0` crop and full viewer Navines' `p99-i8` destination matched the corresponding normalized manifest regions. The scroll test included 26-pixel native and 25-pixel full-viewer steps while the actor transform stayed unchanged; compositor scrolling moved the page and actor together. At idle there were no active episodes or actors and no scheduled robot animation.

The full window returned to page 121, scale `"0.9"`, rotation 0, vertical scrolling, odd spreads, offsets (0, 51314), robots enabled and Motion Lab open. The final passive check confirmed the original editor focus, no missing visible pages, no temporary observers and no active robot scheduling. The companion TurtleSim viewer also returned to its original page 1 and page-width state. All focus-emulation leases and inspection sessions were released; no book compilation was started.

Two follow-ups were identified from these actual captures. The first carried crop remained 43 × 25 pixels while displayed at about 189 × 106 even after the 768-pixel page arrived, motivating in-place cargo refinement. Separately, the background render suspension produced a 43,108 ms load-delay estimate before the full probe; fresh samples reduced it to 124 ms by the final passive check. The next timing module excludes observer-detected suspended-frame intervals while preserving genuinely long foreground work. These checks precede that helper and the finite cleaner/refinement integration.
