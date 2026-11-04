# Predictive PDF preloading

Both PDF viewers use the same controller, [pdf-prefetch.ts](../views/pdf-viewer/src/common/pdf-prefetch.ts), with PDF.js 5.1.91. The pdfjs application and the Overleaf wrapper each pass their `PDFViewer` to `installPdfPrefetch` once during viewer startup. Document replacement resets that controller through the page lifecycle events. [scroll-prefetch.ts](../views/pdf-viewer/src/common/scroll-prefetch.ts) owns the motion estimator and cache budgets.

## Scheduling and cache layers

The estimator follows CoS's `TimelineScrollDynamics`: react immediately to faster motion or a slower page, then decay the estimates gradually. Wheel events predict motion before the next scroll frame; the controller avoids counting that movement twice. Scroll events cover keyboard navigation and scrollbar movement. A 250 ms gesture gap clears velocity and acceleration, while the document's loading-time estimate remains available. Acceleration is diagnostic; velocity, the latest displacement, and measured page latency determine the preload distance.

The desired distance starts at two viewports, with a 480 px minimum. It grows with speed and page latency, up to twelve viewports or 12,000 px, whichever is smaller, while preserving the base distance for large viewports. Direction changes immediately on reversal.

The controller uses four existing or added layers:

1. PDF.js retains received byte ranges within its active document; the extension keeps hash-addressed pieces on disk across builds.
2. Prepared PDF pages retain PDF.js display operators and decoded resources.
3. Small raster previews cover pages while full-resolution rendering catches up.
4. PDF.js owns the full-resolution page canvases and their rendering queue.

The persistent [piece cache](../src/core/pdfFetchBridge.ts) accepts complete GET requests to `/content/<contentId>/<SHA-256>` when the response bytes match the hash. Dynamic `output.pdf` range requests go to the remote download server each time the bridge receives them. Reusing the harness server or its piece-cache directory therefore does not make another engine's dynamic ranges local.

Preparation uses small `pdfPage.render()` calls with the display intent shared by native rendering. At most three cold pages are admitted across speculative previews and the auxiliary renders that track native resource preparation. A new cold native render starts only after its small auxiliary render is running. That auxiliary render holds its slot until preparation actually completes. Completed native renders and previews mark resources warm; PDF.js clearing the same page proxy's rendering-intent map revokes that status.

Native visible pages and holes in spread layouts retain their rendering priority. An uncovered visible page blocks further offscreen admission. When scrolling makes an already-started preview obsolete, it becomes `retiring` and finishes while holding its slot. This prevents repeated canvas cancellation from launching unbounded worker decoding. Obsolete `getPage` requests whose render has not started are discarded. Document replacement, layout changes, hidden documents, and disposal still cancel work; completion checks reject stale results.

Full-resolution lookahead stays within two viewports. Counting visible pages and spread holes in that window avoids repeatedly evicting and redrawing pages through PDF.js's default ten-view buffer. Rotation, theme, and optional-content changes invalidate saved previews; zoom can reuse and resize them. Disposing the controller removes listeners and restores the queue methods.

### Transfer admission

PDF.js can continue worker image and range requests after a render task is cancelled. Before admitting a page whose resources are cold, the controller also checks unfinished viewer fetches. It pauses new cold native renders and cold preview preparations when at least twelve fetches are pending, or when at least six are pending and the oldest has reached 1,500 ms. Up to five pending transfers can overlap independently of their age, preserving concurrency on high-latency connections. Existing running or paused native renders can continue or resume, and pages with fully warmed resources can render from those resources.

These are admission thresholds: one admitted page can request several images, so the number of pending fetches can exceed twelve. `onFetchChange` schedules a coalesced refresh as requests finish, allowing waiting work to resume from observed completions. The shared limit of three cold pages also includes work still decoding after its transfers finish.

### Budgets and thresholds

The authoritative values are `PREFETCH_LIMITS` in [scroll-prefetch.ts](../views/pdf-viewer/src/common/scroll-prefetch.ts).

| Resource | Budget |
|---|---:|
| Planned preparation window | 16 pages |
| Cold page preparations across native auxiliary renders and previews, including pending `getPage` and retiring jobs | 3 |
| Pending-fetch threshold for pausing cold work at any age | 12 |
| Pending-fetch threshold when the oldest reaches the age limit | 6 |
| Oldest-fetch age limit, combined with the six-fetch threshold | 1,500 ms |
| Full-resolution targets, including visible pages and spread holes | 8 |
| Full-resolution canvas admission and cleanup target | 192 MiB |
| Preview maximum dimension | 768 px |
| Retained preview raster storage | 64 MiB |
| Retained preview count | 128 |

Visible pages remain protected. PDF.js also maintains decoded resources outside the raster byte counters.

## Diagnostics

Focus the PDF pane and press **Ctrl+Alt+Shift+R** to open or close the LARICS motion lab. **Copy measurements** copies a JSON snapshot. In the viewer's developer console:

```js
window.pdfPrefetch.snapshot()
window.pdfPrefetch.toggleDiagnostics()
```

[The diagnostics module](../views/pdf-viewer/src/common/prefetch-performance.ts) samples every 250 ms while open. Its charts cover ten seconds; event storage holds the newest 512 events and transfer storage the newest 2,048 samples. The dashboard and robot animation start when opened and stop sampling when closed or when the document is hidden.

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
| Transfer pressure | `fetchBackpressure` reports the request-admission condition. The performance snapshot includes `pendingFetchCount` and `oldestFetchMs`. |
| Visible-content status | `visibleMissing` lists visible pages awaiting both a full render and a preview; `starved` is true when that list is nonempty. |

The time margin extrapolates the present speed and recent loading cost. Abrupt jumps and changes in page complexity change those estimates.

## Verification

From the checkout:

```sh
node node_modules/typescript/bin/tsc -p ./
node node_modules/.bin/mocha "out/test/pdfViewer*.test.js"
```

The focused suites cover gesture dynamics, reversal, visible rendering priority, bounded preparation, spread holes, stale document completions, preview retention and cleanup, queue restoration, and throughput accounting.

Repository verification on 2026-11-04 passed 678 Mocha tests and the build. Lint reported zero errors and three pre-existing warnings.

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
