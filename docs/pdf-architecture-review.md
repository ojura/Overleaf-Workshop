# PDF performance architecture review

Three independent reviewers inspected the combined follow-up on 4 November 2026 before live activation. Their lenses were shared policy and engine boundaries, cache and transport ownership, and renderer structure and lifecycle. The final reviewed source passed 1,014 Mocha tests, four Node API checks, host and both viewer builds, the Spomenar build, lint, strict owned browser types and whitespace checks. Source hashes stayed unchanged during that gate.

## Findings and corrections

| Review finding | Structural correction | Evidence |
|---|---|---|
| Multipart cache reads could span two manifests and label both representations with the first validator. | `PdfDiskCache.readRanges()` captures one manifest, validator, segment list and all read plans. The bridge consumes that single snapshot. `readRange()` delegates to the same implementation. A missing captured blob rejects the whole hit. | A second live cache instance publishes a replacement during the first instance's read. Both retained-blob and evicted-blob regressions fail with the old per-part loop. The affected cache/bridge set passes 45 cases. |
| A cache hit could skip `If-Range` evaluation. | Conditional requests follow the existing origin path and forward the header. The bridge retains its early cancellation of whole-document `200` bodies. | The old cache path failed the origin-forwarding assertion. The fix uses origin HTTP semantics without duplicating validator parsing. |
| Custom gesture timing reached settlement but not the motion estimator. | The controller passes the selected `gestureGapMs` into `ScrollPrefetchDynamics`. | A 1,000 ms policy retains motion across 300 ms and resets after 1,001 ms; the original code fails. |
| Sidecar limits were derived from the policy name inside the controller. | The shared policy owns explicit sidecar concurrency and edge scaling; one helper derives consumer options. A documented fallback preserves legacy custom objects. | Explicit settings override the name and worker-image options. Exact default and legacy area caps are asserted. The two policy suites pass 106 cases. |
| Decorative scene nodes repeated initialization, and a new mast could appear before positioning. | One initializer sets hidden, absolute, decorative and noninteractive state before attachment. | Deferred reveal and drained scheduling are checked for every scene-node category; the old mast behavior fails. |
| Document attachment geometry duplicated coordinates from forklift artwork. | `ROBOT_FORKLIFT_ATTACHMENT` owns unscaled artwork coordinates and its internal scale. The document renderer derives its rounded offsets. | Actual painted strokes align with document mast and cargo in compact and desktop fixtures. A five-pixel derived-offset mutation fails. The renderer, artwork and diagnostics set passes 79 cases. |

## Ownership boundaries retained

The [motion policy](../views/pdf-viewer/src/common/scroll-prefetch.ts) owns estimation, device budgets and sidecar options. The [controller](../views/pdf-viewer/src/common/pdf-prefetch.ts) coordinates visible priorities, bounded admission, retention and lifecycle. Engine entry points supply the existing viewer and document lifecycle; they do not duplicate the scheduler.

The [disk cache](../src/core/pdfDiskCache.ts) owns immutable blobs, manifests, its serial operation queue and short writer leases. Export completion uses the same admission and cancellation machinery. Network fetches stay outside the writer lease and foreground read queue. The review considered extracting a separate lease manager; the existing single owner remains because that extraction would broaden lifetime changes without removing a second owner or correcting another observed defect.

The [document renderer](../views/pdf-viewer/src/common/pdf-document-robots.ts) owns routes, cargo, capacity and its finite paint schedule. Procedural artwork owns vehicle shape and attachment geometry. The diagnostics module reads bounded counters through its existing sample timer. Lab reservations remain attached to the port that granted them, including when the lab closes during a delivery.

## Contained compatibility boundaries

The full PDF.js and standalone entry points attach the exact document immediately after their synchronous `setDocument` call. The native Overleaf engine can defer that call through `startViewTransition`, so its [preview binding adapter](../views/pdf-viewer/src/common/pdf-preview-binding.ts) waits for the actual installed proxy. Keeping this adapter at the native lifecycle boundary preserves exact-document matching.

The [build script](../scripts/build-pdf-viewer.mjs) adapts exactly two response-consumption sites in the pinned Overleaf loader and checks their path and source count. Both extension engines use the [shared response helper](../views/pdf-viewer/src/common/bridge-response.ts); normal HTTP responses retain native consumption. A private stream marker selects direct reads only for untouched owned bodies. Cloning, locking and reuse retain native response semantics. The final worker-transfer copy preserves chunks still retained by the incremental loader. Eighteen focused bridge/transport cases and a real Chromium ownership check cover this boundary.

The native webview resource grant uses a file URI for the exact preview root because Antigravity represents global storage with a `vscode-userdata` URI while local preview descriptors use `file:`. The compatibility conversion is confined to the resource boundary and covered by the host preview regression.

## Evidence and live follow-up

The final gate is recorded in `/tmp/spomenar-reviewed-gate-20261104-tykfzj06`. Focused cache transition logs are in `/tmp/spomenar-multipart-cache-20261104-6q2nyfgd`. Renderer and browser controls, including the deliberate attachment drift, are retained under `/tmp/spomenar-book-state-XR0QLA`.

The [desktop validation report](pdf-desktop-validation.md) and [heavy-scroll metrics](pdf-heavy-scroll-metrics.json) distinguish the installed baseline from matched follow-up measurements. The matched run precedes desktop sidecar generation so the response and renderer changes can be assessed against the same scrolling scenario.
