# Spomenar mobile validation

Physical iPhone validation on 4 November 2026 found and drove fixes for repeated idle preparation, retained full-resolution photographs, robot docking congestion, and continuously scheduled idle animation. The adaptive decoder candidate completed both controlled traversals, released every retained decoded image, and settled naturally to 256–258 MB in WebKit's reported memory categories. Its measured transient peak was 560 MB.

The numeric record is [spomenar-mobile-metrics.json](spomenar-mobile-metrics.json). This document uses **MB = 1,000,000 bytes** for measured browser totals and transferred bytes, and **MiB = 1,048,576 bytes** for configured cache budgets. The JSON retains exact byte counts.

## Device and document

| Item | Observed value |
| --- | --- |
| Physical device product type | iPhone17,1 |
| iOS version reported by the paired device | 27.2 |
| Safari version | 27.2 |
| Portrait viewport | 402 × 654 CSS pixels |
| Device pixel ratio | 3 |
| Initial visual viewport scale | 1 |
| Default PDF scale in this viewport | 0.44362745098039214, page width |
| PDF | 459 pages, 1,608,644,855 bytes |
| Pinned PDF.js version | 5.1.91, with the repository's worker patches |
| Device instrumentation | pymobiledevice3 11.20.2 and Safari Web Inspector |

Safari's compatibility user-agent text contains an older iOS token. The OS version above comes from the device service, and the Safari version comes from its Version token.

The phone loaded the real served PDF through byte ranges. The final controlled recording observed 487 requests with status 206, no failed requests, and no native memory-pressure events. The server validation separately checked exact head and tail byte counts and stable validators.

## Controlled comparison

Each pass positioned the reader at physical PDF page 60, scrolled linearly to page 90 over 3,000 ms, and reversed to page 65 over 2,500 ms. The second pass used the caches left by the first. The scroll driver used the phone's animation frames, producing 181 or 182 forward updates and 151 reverse updates. Positioning and recovery were excluded from the moving-sample counts.

The browser snapshot was sampled about every 200 ms. A **gap sample** means that at least one currently visible page had neither a finished native canvas nor a cached preview. A small portion of the next visible page is sufficient to count as a gap. This is a count of viewport readiness samples, rather than the fraction of screen area that was blank.

Web Inspector recorded memory categories and CPU approximately every 500 ms. Host monotonic timestamps were aligned to `performance.now()`; the adaptive run's calibration round trip was 8.3 ms. The final runner used one inspector connection for evaluation, memory, CPU and network recording. No forced garbage collection or explicit PDF cleanup occurred during these comparisons or their natural idle observations. The driver stops on trusted touch; none occurred during either controlled pass.

The baseline below already included the sparse range cache and graduated preview cache. It predates adaptive JPEG sizing and serialized image decoding. The adaptive candidate also included document-mounted robot deliveries, with those effects enabled and the optional lab closed.

| Measurement | Baseline | Adaptive candidate |
| --- | ---: | ---: |
| Peak retained decoded-image bytes | 197.49 MB | 2.73 MB |
| Peak sum of native memory categories | 730.39 MB | 560.23 MB |
| Later naturally settled total | 308.96 MB | 257.73 MB |
| Pass 1 gap samples | 20 / 28 | 14 / 28 |
| Pass 2 gap samples | 17 / 28 | 11 / 28 |
| Pass 1 transferred bytes | 44.04 MB | 118.49 MB |
| Pass 2 transferred bytes | 27.92 MB | 103.94 MB |
| Pass 1 completed range fetches | 121 | 258 |
| Pass 2 completed range fetches | 78 | 216 |
| Pass 1 maximum pending fetches in moving samples | 15 | 23 |
| Pass 2 maximum pending fetches in moving samples | 9 | 19 |
| Pass 1 readiness after stopping | Already ready at first sample | Already ready at first sample |
| Pass 2 readiness after stopping | Already ready at first sample | Already ready at first sample |
| Pass 1 all-work settling time | 307 ms | 304 ms |
| Pass 2 all-work settling time | 307 ms | 303 ms |

The smaller decoded images let more planned pages finish during the same fling. Coverage improved, while transferred bytes increased. The second adaptive pass still transferred about 12.3% fewer bytes than its first pass. These byte totals are part of the performance tradeoff; the faster decoder did substantially more useful preparation within the same traversal time.

The adaptive run completed 304 native image decodes and two fallback decodes. The worker reported 808.69 million original pixels and 33.14 million output pixels. Peak active image jobs was exactly one; the largest observed waiting image queue was 13. At the retained-image peak, the page stores held photographs for pages 82 and 83, mostly 256 × 192 pixels, with one 264 × 352 image. Every page intent and image store was empty after settling.

## Native memory settling

The adaptive run started at 262.82 MB. Its peak was 560.23 MB during the second forward traversal. At that peak, the reported categories were 132.03 MB JavaScript, 11.35 MB JIT, 382.37 MB Page and 34.47 MB Other. The recording ended at 485.67 MB, with zero retained PDF image objects and a 383.17 MB Page category.

The next natural idle recording began **86.27 seconds after the previous recording ended**. That interval was not sampled. At its first sample the total had fallen to 256.01 MB. Over the following 20 seconds, it remained between 256.01 and 257.73 MB. The final Page category was 158.47 MB. The observed reduction happened without forced collection, explicit PDF cleanup, navigation, or another traversal.

This separates two useful measurements: PDF.js retained image storage fell immediately to zero, while Safari's native Page allocation total took longer to fall. The precise release time within the unsampled interval is unknown.

The active mobile policy in this run was:

| Resource | Policy | Observed after the controlled run |
| --- | ---: | ---: |
| Sparse raw PDF cache | 32 MiB target | 33,552,631 bytes |
| Near and trail preview cache | 8 MiB | 8,194,560 bytes across 29 pages |
| Near preview maximum dimension | 512 pixels | Applied |
| Trail preview maximum dimension | 192 pixels | Applied |
| Native page canvases | 3 pages, 48 MiB budget | 18,246,384 bytes |
| Planned pages | 6 | Device policy selected |
| Concurrent cold preparation jobs | 2 | Device policy selected |
| Concurrent image decodes | 1 | Peak active count 1 |

Raw cache residency briefly reached 71,956,727 bytes while work was active, then returned to 33,552,631 bytes. The 32 MiB setting is a trimming target: active worker operations and pending range dependencies delay eviction. The peak browser total includes those active allocations and native decoder memory as well as the caches.

## Why adaptive native decoding was chosen

A separate bounded capability check fetched one exact JPEG stream from the book. The source was 4,320 × 3,240 pixels. On the physical phone, worker `createImageBitmap` with resize options produced a 1,080 × 810 bitmap in 122 ms. Its RGBA footprint was 3,499,200 bytes. The check closed the bitmap, terminated the temporary worker and revoked its object URL.

This phone exposed `OffscreenCanvas` and `createImageBitmap`, while `ImageDecoder` was unavailable. The repository therefore uses the supported native bitmap path for suitable JPEGs, requests dimensions from their actual display placement, serializes mobile image jobs, and releases completed render resources. Higher-resolution zoom intents have separate cache identity in the worker tests.

The book's photo collages make that sizing important. Server-side source inspection found twelve unique RGB JPEGs on page 90, totaling 364.86 MiB at full RGBA resolution, including four photographs whose full bitmap size is 53.39 MiB each. Those numbers describe source-image sizes, rather than simultaneous phone residency.

## Idle work and CPU

During the final natural idle observation, document effects were enabled and the optional lab was closed. The following remained constant for the entire 20-second recording:

- Event count 727 and fetch count 504.
- Document robot frame count 14.
- Zero active episodes, actors, cargo bytes, sprite bytes or retained robot bytes.
- `scheduled: false` for the document effect.
- Zero decoded image bytes, pending fetches and recorded range requests.

CPU averaged 0.229% of a core after the first second, with a maximum sample of 1.9%. The old always-visible stage had averaged 16.73% in an earlier idle observation. The new default presentation sleeps completely after finite document deliveries; opening the optional lab is a separate user action.

An earlier phone trace also exposed a page 67 loop that alternated eviction and preparation about 30 times per second while page 65 was stationary. The controller regression reproduces that failure. Subsequent physical runs showed stable event and fetch counters at rest.

## Physical layout and document effects

The official LARICS mark and book title fit the 402-pixel header. Share, download, robot and measurements controls each measured 44 × 44 CSS pixels. Their left edges were 206, 254, 302 and 350 pixels; the final target ended at 394 pixels. The first-visit document outline remained closed, leaving the book visible. The green dot beside its toggle is PDF.js's built-in outline/attachment/layer notification.

The optional compact lab measured 340 × 201 pixels, positioned at x=54, y=445. Its stage measured 320 × 86 pixels. Both its close button and measurements summary were 44 pixels tall. Measurements expand within the panel's internal scrolling area.

Two cold-page visual checks demonstrated the requested delivery behavior:

- With the lab closed, four couriers carried copied page fragments across pages 110 and 111. Their combined retained cargo and sprite storage was 312,320 bytes. The vehicles included a quadrotor, rover, hexapod and Navines forklift.
- With the lab open, four document couriers reported `fromLab: true`. Their matching stage actors reported `outside: true` and left the stage. The visible handoff used the compact stage's artwork scale, then enlarged the couriers for document travel. All four returned to the stage after their deliveries.
- The two checks completed eight fragments. Afterwards the document effect reported zero actors, cargo, retained bytes and scheduled frames.
- Every transit, vehicle and cargo element had `pointer-events: none`.

The closed-lab screenshot exposed one presentation defect: a courier and cargo could cross the header while entering from the top. A narrow viewer-bounds correction is being validated separately. It does not change the decoder or the controlled memory comparison above.

The optional lab continued processing its finite telemetry cargo after the document couriers returned. Its stage paint averaged 1.15 ms, with a 3 ms maximum in that physical observation. The default-idle CPU measurement above was taken with the lab closed and the document fleet fully empty.

## Genuine touch validation

The physical phone is ready for the invited user swipe, reverse, pinch, rotation, toggle and text-selection pass. A bounded passive logger records trusted input, visual viewport geometry, PDF scale, canvas dimensions, decode counters and selection length. It creates no DOM indicator, records no selected text, and runs no timer while idle.

This section will be updated with the captured gesture results and high-zoom inspection. The current reading tab is being preserved.

## Narrow extension toolbar check

The Overleaf toolbar was also rendered in a temporary invisible fixture on this same Safari context. At 220, 300, 480 and 600 pixels, its scroll width matched the viewport. At 220 pixels, the direct robot button ended at x=218 and the More menu fit from x=4 to x=216. At 640 and 900 pixels, the original action nodes returned to their direct positions.

The check exercised the actual toolbar class. Existing node identities and action listeners survived moves into and out of the More menu. Arrow keys, Home, End, Escape, Tab and outside-pointer dismissal worked; Escape returned focus to the trigger. Save and measurements handlers each ran once. The fixture was removed, and page 65 and its scroll position were preserved.

The larger full PDF.js fixture encountered a stalled Automation reply. The independent inspector confirmed the original Safari page was still visible, focused and healthy, with no fixture remaining. Validation continued through the same tab's Web Inspector. The full PDF.js narrow-layout check was transferred to the existing desktop viewer context; no extra phone tab or browser was created.
