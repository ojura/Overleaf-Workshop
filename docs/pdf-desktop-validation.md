# Live desktop PDF validation

The installed `7c70643` extension had completed the live LARICS photo spread at the **2.915-second checkpoint**, then completed a **270% native render by the 1.491-second zoom checkpoint**. The document fleet reached twelve couriers, including three helpers carrying one shared fragment. After restoring the reader, all couriers released their cargo and stopped scheduling frames while the desktop disk cache continued accumulating PDF coverage.

The exact numeric record is [pdf-desktop-metrics.json](pdf-desktop-metrics.json). This observation ran on 4 November 2026 in the existing Antigravity book window, using the full `pdfjs` engine and patched PDF.js 5.1.91. The current compiled book contained **460 pages and 1,608,164,635 bytes**. The earlier 459-page phone and cold-network harness results describe a different compiled representation.

## Measurement conditions

This was a short functional and performance check in an existing reader session with its caches preserved. It visited physical page 90, increased zoom from 90% to 270%, then restored the latest saved reader state. Network and power conditions were not controlled for a comparative benchmark.

The occluded Wayland/Electron window initially advanced timers but supplied no animation frames, including in the parent workbench. The validated run used a temporary top-level `Emulation.setFocusEmulationEnabled` lease, following the existing CoS background-rendering technique. Each lease was bounded below sixty seconds, disabled in `finally`, and detached. The native window remained in the background. Trusted pointer, wheel, key and touch input would stop the driver; no such input occurred.

The probe sampled readiness about every 120 ms, required at least 1.2 seconds of observation, and captured cooperative screenshots during the photo phase. The checkpoint times therefore include observation and capture work. The photo capture recorded a 23 ms PDF-frame p95 and 22 ms workbench-frame p95. The earlier observation with no animation frames is excluded from performance comparisons.

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
