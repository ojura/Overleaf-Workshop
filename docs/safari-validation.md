# Physical Safari validation

The tools in `scripts/pdf-viewer-harness/safari/` exercise the published reader in an existing Safari tab on a paired iPhone. They preserve the reader state and collect both browser measurements and native Web Inspector memory, CPU and network events. The [reader guide](spomenar.md) describes the application; [PDF prefetch](pdf-prefetch.md) describes its rendering and resource limits.

## Setup and ownership

The observed device was an iPhone17,1 running iOS 27.2. The host used Python with `pymobiledevice3` 11.20.2, pinned in [requirements-live.txt](../scripts/pdf-viewer-harness/safari/requirements-live.txt). The installed library matched the official wheel's Python source; no local Inspector patch was required. Use an existing isolated Python environment or install that requirement in one dedicated to the live tools. Offline fixtures use Python's standard library and Node, without attaching to a device.

Keep the pairing record and device selection in an external JSON file with `udid` and `pair_record`. Copy [document.example.json](../scripts/pdf-viewer-harness/safari/document.example.json) to an external file and update its `pageUrl`, `entryUrl`, `pdfUrl`, PDF SHA-256, byte length and page count for the exact publication. All three URLs must share the origin, and the reader URL ends in `/`. Generated receipts, screenshots and raw recordings belong in an output directory outside the repository. The maintained fixtures contain public document identity and selected numeric observations only.

Open the existing Spomenar tab on the phone, keep Safari in the foreground and leave the reader untouched during the agreed workload. A paired USB connection does not establish that the desired page is inspectable or foreground. The runner checks the exact origin and page path, requires one matching tab, and uses its existing Web Inspector target. It does not create a tab, browser profile, automation bridge or debug port.

One host process owns the inspector connection. Subsequent source checks, probes and result collection use that owner. A second inspector must not attach while the owner is active. If the page temporarily stops replying, preserve the owner and its identity while checking whether the same page has returned. A surviving token-owned probe can provide its terminal report after reconnection. Repeating a workload before collecting that report would lose the distinction between attempts.

The unattended workload can wait for a real tap on its Start button. Its initial acknowledgement is immediate and reports `armed`. The trusted click requests a native screen wake lock synchronously before motion starts; denial leaves the workload stopped. The default tap allowance is 60 seconds, configurable from one to 300 seconds, separate from the motion budget. Controlled immediate diagnostics may record an explicit `NotAllowedError` and continue. That mode does not keep the phone awake: foreground visibility, input and the finite host lease remain necessary. Both automated modes stop on a real visibility change, trusted input or lost document identity. The passive manual scenario deliberately records user input and never changes or restores the reader.

## Commands

Run these commands from the checkout root. The offline gate needs no phone:

```sh
npm run test:safari:offline
```

`npm run test:pdf-viewer` additionally compiles and runs the PDF unit suites. For live use, choose an external working directory and the Python executable that has the pinned dependency:

```sh
SAFARI_PYTHON=/absolute/path/to/safari-venv/bin/python
SAFARI_WORK=/absolute/path/to/safari-results/session-1

"$SAFARI_PYTHON" scripts/pdf-viewer-harness/safari/safari_owner.py serve \
  --execute --work-dir "$SAFARI_WORK" \
  --document-config /absolute/path/to/document.json \
  --device-config /absolute/private/path/to/device.json \
  --entry-file dist/spomenar/assets/spomenar.mjs \
  --worker-url https://cloud.larics.fer.hr/spomenar/assets/pdfjs/build/pdf.worker.mjs \
  --worker-file dist/spomenar/assets/pdfjs/build/pdf.worker.mjs
```

Leave that owner running. Submit commands from a second terminal, using a new command ID and receipt prefix for each operation:

```sh
"$SAFARI_PYTHON" scripts/pdf-viewer-harness/safari/safari_owner.py command \
  --execute --work-dir "$SAFARI_WORK" --id source-1 activate --prefix source-1 --source-only

"$SAFARI_PYTHON" scripts/pdf-viewer-harness/safari/safari_owner.py command \
  --execute --work-dir "$SAFARI_WORK" --id endurance-1 run \
  --prefix endurance-1 --scenario sustained --seconds 600 \
  --start-mode tap --start-wait-ms 60000
```

The expected entry can instead be supplied as `--entry-sha <64 lowercase hex>` with `--entry-bytes <length>`. It must identify the release that was deployed. Reading a new copy over HTTP cannot identify the source an old tab is executing. The optional worker check uses `--worker-file`, or `--worker-sha` plus `--worker-bytes`, with the exact `--worker-url`. Its `workerArtifact` receipt is labeled `fresh-public-artifact`; the entry check separately reads executed source. This records the patched worker delivered by the publication, which is a different asset from the entry. The historical hashes below identify the saved baseline only.

| Scenario | Run options | Purpose |
| --- | --- | --- |
| `sustained` | `--scenario sustained --seconds 600 --start-mode tap` | Example extended budget: twelve stages over a selected 600 seconds of motion, 12 seconds of dwell, then exact awake restoration. |
| `traverse` | `--scenario traverse --start-mode immediate` | Two 60→90→65 passes with 11 seconds of actual motion, bounded settling, eight seconds of robots-on idle and four seconds off. |
| `short` | `--scenario short` | Actual photo delivery, screenshot, refinement/retirement and finite Motion Lab drag/resize/dock checks. |
| `manual` | `--scenario manual --seconds 120` | Passive observations while the user performs actual pinch, fling, selection, rotation and toolbar/lab actions. |

For a passive manual session on the same retained connection:

```sh
"$SAFARI_PYTHON" scripts/pdf-viewer-harness/safari/safari_owner.py command \
  --execute --work-dir "$SAFARI_WORK" --id manual-1 run \
  --prefix manual-1 --scenario manual --seconds 120
```

For a stale release, submit `activate` without `--source-only`, adding the new `--entry-file` if the owner was started against an earlier release. `recover --receipt-prefix <original-prefix>` collects the surviving original probe. `resume` explicitly asks the existing Safari application to resume without creating a tab. `transport-check` performs the maintained bounded Inspector transport diagnostic. `status`, `stop` and `close` report state, stop the owned workload, or close the owner respectively. Every command includes the same `--work-dir`, a fresh `--id`, and `--execute`.

An invocation without the execution flag is inert. Command receipts are consumed before mutation so repeating an ID cannot repeat a workload. Keep the owner attached through result collection and review; use `close` when finished. Host errors and an unavailable page are recorded without silently starting a different attempt.

## Verify and activate the executed release

First read the entry script already loaded by the owned page. Native WebKit's `scriptParsed` event does not supply CDP's execution-context association, so the source check requires a single main frame without child frames and one exact entry URL. It reads that script's source with `Debugger.getScriptSource`, checks its byte length and SHA-256, and disables the temporary debugger on every outcome. Ambiguous script or frame identity stops the check.

If the executed source matches, keep the current document and skip reload. This branch is useful even when an automatic reload would be unsafe to restore.

For stale source, capture page, numeric scale and scale value, rotation, scroll/spread modes, scroll offsets, sidebar, robot toggle, Motion Lab visibility/geometry and actual focused control. Stop before navigation when pinch scale is not one, text selection or editing is active, focus cannot be recovered, the panel or column has pending movement, or a nonempty effective bookmark may navigate asynchronously. Numeric page/zoom bookmarks and an ordinary empty URL hash are supported. Named destinations, explicit destination arrays and search-driven hashes require a separate navigation-aware procedure.

The temporary native `Page.setBootstrapScript` guard spans the reload. One JavaScript call rechecks the current token, trusted input and saved view, marks the owned navigation, and calls `location.reload()` in the same turn. Context loss after that call is an attempted navigation; it must not trigger a second reload. The old document's expected pagehide/visibility events are recorded separately from user input. The new document must retain the exact origin and a fresh time origin.

Wait for `isInitialViewSet`, fulfillment of the captured same-document `pdfViewer.pagesPromise`, and two actual animation frames before restoration. Pinned PDF.js may apply its initial view twice when page dimensions differ. Restore the captured numeric view after those passes, then verify reader, sidebar, lab and focus state. For saved BODY focus, blur the current control and verify BODY became active; BODY.focus() is not a reliable restoration method. A saved element ID is valid only when it resolves to that exact light-DOM element.

The pinned anonymous page text layer has a page-number focus descriptor only when it is exactly that page view's `textLayer.div`, inside its connected authoritative page root and reader. After the saved numeric view is applied, restoration waits for the new page view's actual connected text layer under the same cancellation and expiry owner. Lab handles have unique physical directions in `data-panel-resize`, so focused edge and corner controls can be reacquired exactly.

Saved Lab restoration first restores the measurements disclosure, waits for its queued native toggle event, then waits for its content-height change to settle. It then restores the dock and waits for both movement markers to clear and measured geometry to settle before applying direct gestures. Use the southeast handle for a floating panel, east for a left dock and west for a right dock. Floating geometry uses one synchronous move toward the saved position, resize, then final position correction, followed by one settling wait. Moving first allows anchored growth; the final correction handles a starting panel whose larger size initially limits its position. Applying the disclosure after these gestures would replace the restored height with the new content fit.

The activation deadline reserves separate time for restoration, bootstrap/guard removal and inspector cleanup. If input or navigation transfers ownership to the user, stop applying saved state. Let the temporary token expire and remove reachable bookkeeping; do not navigate the user back to a page solely to clean up a token.

## Coverage

| Check | Evidence collected |
| --- | --- |
| Executed release and publication | Entry SHA/bytes; exact PDF size, page count and preview manifest identity; actual HTTP range validator. |
| Useful page pixels | Connected preview or finished native canvas, positive backing and displayed dimensions, and computed visibility. A detached native canvas counts as covered only if a displayed preview covers it. |
| Photo delivery | Actual photo ID, stable payload ID, logical target and original deadline; crop, arrival cover, refinement underlay and cleaner ownership. |
| Retirement | A zero-sized payload has released every associated pixel artifact and cannot regain a raster or refinement. Helpers may finish their independent route. |
| Refinement | The same live payload keeps its target/deadline and increases or preserves raster dimensions. A natural retirement between samples is recorded separately from refinement. |
| Phone limits | Compact device policy, at most four actors, the selected cargo/sprite limits, eight MiB of retained previews and at most two preview-source requests. Record current values separately from lifetime maxima. |
| Reader input and controls | Hover/tap where applicable, scroll/zoom, sidebar, Motion Lab drag/resize/dock, shared page/actor/annotation coordinates and toolbar clipping. |
| Native workload | CPU and memory events, memory-pressure severity, each PDF range response/body, preview transfers and cancellations, and RPC completion/timing. |
| Final state | Exact saved reader/sidebar/lab/focus values, released pixel artifacts, finite observer/lease cleanup, useful visible pixels and an actual-frame idle interval with unchanged robot frame count. |

Keep the short and manual scenarios separately named: two page 60 to 90 to 65 traversals for reversal/recovery, robots enabled/disabled and natural idle; a first-delivery/refinement/retirement check; and actual trusted pinch, fling, text selection, orientation, toolbar and lab manipulation. Programmatic scrollTop and viewer scale changes do not exercise those trusted gesture paths.

The short scenario waits for the panel and column movement flags to clear, then checks stable measured geometry on consecutive animation frames. This includes the quiet period for a pending destination, stationary approach, parked continuation and the panel's wait for the column. Floating placement may shift the column in either direction: a feasible placement must preserve the whole visible page/spread and a 16 px panel gap; an already-clear column or a layout with no feasible side keeps zero displacement. Each settle has a six-second failure limit. The host defines one shared budget of 35 seconds for delivery observation, five seconds for capture and 60 seconds for finish, totaling a 100-second work watchdog, with 15 seconds reserved for recovery. These are limits, not inserted delays. Normal finish, abort and watchdog share awaited panel restoration before reader/focus cleanup; trusted input ends that restoration without overwriting the user's state.

For manual participation, start the passive scenario and perform a natural fling followed by reversal, a pinch in and out, text selection and dismissal, device rotation and return, toolbar zoom/sidebar changes, then Motion Lab drag/resize/dock and robot toggles. The recorder labels actual trusted events and captures the visual viewport, toolbar geometry, displayed canvases, payload transitions and resource counters. It does not manufacture those events or restore over the user's chosen final state. Typed text and selected document content are not recorded.

The targeted visual probe and the endurance workload serve different checks. Endurance repeatedly visits pages and zoom levels; the first-encounter ledger deliberately prevents the same delivery from replaying at every visit. A fast traverse can cancel a delivery when its page leaves the viewport. Count actual refinements and deposits, and use a deliberate first visible encounter when inspecting the crop or a caption.

### Extended workload sequence

The command example selects 600 seconds of motion. Choose `--seconds` from 60 to 600 for the question being investigated; ten minutes is a selected extended budget, not a universal validation requirement. The table shows this 600-second example. Leg durations scale with the selected motion budget, while the twelve one-second dwells and bounded setup/restoration remain separate. Each leg uses actual animation frames. Zoom changes use the viewer's normal scale state. A successful run must complete its requested budget and all planned stages; an interruption retains its actual duration and remains partial.

| Stage | Zoom | Start page | Destination and motion seconds |
| --- | --- | --- | --- |
| 1 | Page width | 30 | 160 in 35 s; 90 in 15 s |
| 2 | 50% | 90 | 360 in 40 s; 160 in 10 s |
| 3 | 80% | 160 | 110 in 15 s; 90 in 20 s; 110 in 5 s; 94 in 10 s |
| 4 | 160% | 94 | 104 in 20 s; 98 in 8 s; 110 in 12 s; 90 in 10 s |
| 5 | Page width | 90 | 420 in 40 s; 300 in 10 s |
| 6 | 50% | 300 | 455 in 25 s; 90 in 25 s |
| 7 | 80% | 90 | 110 in 30 s; 94 in 10 s; 105 in 10 s |
| 8 | 160% | 105 | 98 in 20 s; 110 in 10 s; 90 in 20 s |
| 9 | Page width | 90 | 10 in 30 s; 90 in 20 s |
| 10 | 50% | 90 | 430 in 35 s; 90 in 15 s |
| 11 | 80% | 90 | 110 in 30 s; 90 in 20 s |
| 12 | 160% | 90 | 110 in 20 s; 98 in 5 s; 104 in 15 s; 99 in 10 s |

The browser samples resource/coverage state every 500 ms and keeps bounded detailed tails plus cumulative aggregates. The host renews a 20-second token lease every five seconds and persists each acknowledged heartbeat immediately. Every heartbeat also carries a compact `clientCheckpoint` made from the cached latest sample and cumulative frame, coverage, resource, counter and stage totals. It adds no DOM reads, sample ring or RPC, so the last acknowledged heartbeat retains useful client evidence even if the terminal result is temporarily unavailable. A missed reply has a bounded timeout because the native endpoint may stop answering. Trusted touch, pointer, wheel, keyboard or orientation input takes precedence over scripted motion. Hiding or a different document also stops it.

Successful automated completion requires exact reading, panel and active-element restoration; a visible viewport with useful displayed pixels; no pending native/preview work; released fleet resources; and at least 1,500 ms continuously observed through actual animation frames with zero additional robot paints. A frame gap over 100 ms restarts that idle interval. `document.hasFocus()` is recorded but is not an awake-success predicate: this phone returned false during visible 60 fps work. Hidden samples retain their numeric state but do not contribute to visible-coverage totals or claim displayed pixels. A hidden interruption can verify coordinates without being labeled an awake completion.

Keep native recording active through the workload and final restoration. Record screenshot intervals so CPU/frame analysis can identify their cost. A terminal failure is still a useful capture: retain its first failure, last acknowledged state, native event tail and cleanup outcomes.

## Interpret the measurements

Native process CPU can exceed 100% when several cores work. Calculate its weighted mean from timestamp intervals. Native memory categories such as `page` cover more than the explicitly counted PDF canvases; keep those measurements separate from the application's raster, decoded-image and raw-byte budgets.

For a completed PDF range, compare actual `Network.dataReceived` body lengths with the requested range, `Content-Range` and `Content-Length`. Preserve encoded bytes, decoded bytes, completion summaries and advertised lengths as separate counters. WebKit's completion `responseBodyDecodedSize` can disagree with its data events; record that discrepancy rather than replacing valid body evidence. Short actual data still fails even if a completion summary claims the expected length.

The native recorder accumulates counters over the full observed interval. Its detailed tails hold the newest 512 memory samples, 512 CPU samples, 1,024 requests, 32 pressure events and 64 errors. The dropped-tail counters describe detail removed from those arrays; the accumulated native totals remain. Report which client aggregates were actually recovered when the page or inspection channel becomes unavailable.

Compare fresh runs with the same initial document, page, zoom, viewport, cache state and power conditions. Preserve the exact executed entry identity in the receipt. Differences in those conditions belong beside the comparison. Readiness from an available low-resolution preview and readiness of the final native canvas are separate observations.

## Observed partial baselines, 5 November 2026

The [sanitized fixture](../scripts/pdf-viewer-harness/safari/fixtures/endurance-2026-11-05.json) records two attempts on release `6f2345ee52fd1b9a935011bc6e60217e0854e675`. The executed entry was 254,505 bytes with SHA-256 `64989688247ed487e343e142a7e85e5ac3654f763f2864180609802a1fadb29f`. The public book was 1,608,358,464 bytes and 460 pages, with SHA-256 `6abb3d0b13d2970bca0f613287a6ea5d30280be14435b5c681b8ca8bd61d24d0`.

| Observation | Attempt 1 | Attempt 5 |
| --- | --- | --- |
| Requested motion | 600 s | 600 s |
| Recorded motion | 12.907 s | 278.608 s |
| Recorded dwell | 0 s | 5.002 s |
| Stop | Recorder selected an inconsistent completion decoded-byte counter | Document became hidden; inspection replies then ceased around native memory pressure |
| Native memory samples | 40 | 568 |
| Native peak | 570,233,856 B | 1,449,668,608 B |
| Native last sample | 495,825,408 B | 876,604,416 B |
| Native weighted CPU | 52.54% | 92.15% |
| PDF body bytes | 119,406,592 B | 4,737,343,616 B |
| PDF responses | 267 | 4,858 |
| Frontend terminal report | Collected | Recovered from the surviving original probe |

Attempt 1's failing request delivered exactly 1,048,576 bytes, matching its requested range and Content-Length. Its completion decoded counter said 2,097,152 bytes. The corrected recorder now uses the complete data-event body length and retains the differing completion value separately. This attempt restored the reader and focus exactly, removed its observers and probe, detached, and recorded 1.502 seconds at idle with zero additional robot frames. Its 771 motion intervals averaged 59.85 per second; 746 were at most 20 ms, 23 were between 20 and 34 ms, and two were between 34 and 50 ms. All 67 sampled page observations had useful displayed pixels.

Attempt 5 completed five stages and part of stage 6. Its recovered report records a `hidden` interruption at 283.929 seconds after initialization. Native memory peaked at 1.450 GB; 1.279 GB of that peak was categorized as `page`. The recorder received critical memory pressure at native timestamp 284.469 seconds. The first unanswered heartbeat was sent 0.793 seconds after that event. Native CPU/memory events ended at 285.520 seconds, and the subsequent stop, recording cleanup and object-release RPCs also timed out. All 4,858 observed PDF bodies passed range validation. The two native completion-counter discrepancies remained separate observations.

The recovered browser intervals average 59.27 per second across 278.608 seconds of motion. Stages 1 through 5 average 59.39 to 59.74; the interrupted sixth stage averages 56.45 with a 311 ms maximum gap. Four of the 1,032 stage page observations lacked useful displayed pixels. All 69 observations of a detached native canvas had a displayed preview. Actual sampled raw bytes peaked at 211,655,232 B with as many as 42 active worker operations and 41 queued image decodes. Decoded page bitmaps peaked at 64,056,880 B, and native canvases at 62,672,568 B during 160% zoom. Preview retention remained within eight MiB and the fleet within four actors, 413,440 B of cargo and 204,800 B of sprites. The two revisited zoom stages performed zero robot paints while native memory and image work remained substantial.

The original document and probe survived. Their recovered terminal report verifies exact page 46, page-width scale, scrollTop 23685, sidebar, robot/lab settings and focus, plus observer removal and empty fleet ownership. The probe was then disposed through the retained owner. Its nominal 1.5-second idle wait took 308.282 seconds during suspension, and its final sample still had missing pages 46 and 47. That report verifies coordinate restoration and released fleet resources; the maintained success check additionally requires a visible rendered viewport and a continuously observed animation-frame interval. The recovery wrapper recorded `Memory.disable` protocol error `-32000`; frontend cleanup reported no error. Both attempts ended before their selected 600-second motion budget.

### Maintained release b8920d6

The [maintained-run fixture](../scripts/pdf-viewer-harness/safari/fixtures/endurance-2026-11-05-b8920d6.json) records release `b8920d66259dd9f359ff624e3c9928559f63087e` against the same public book. Executed entry source matched SHA-256 `cf2ab2b5f7826973a40749044ea11bfb9a174dfbd15d91628e777e2694d98f0b` and 254,643 bytes. The separately checked public worker matched SHA-256 `b2ca936cf9c6fc937b57df713181b703ee1e4debe25d424f7ee42f780cadc8b9` and 1,890,669 bytes.

A real tap obtained the wake lock in 14 ms. The run completed seven stages and 8.602 seconds of stage 8, totaling 358.707 seconds of motion and 7.013 seconds of dwell from its selected 600-second budget. It stopped with `wake-lock-released`. The terminal result was collected on the same retained target, with 111 RPCs and no RPC, recorder or cleanup errors.

All 1,329 visible page observations had useful displayed pixels. All 47 observations of a detached native canvas had a displayed preview. The 21,279 measured motion intervals averaged 59.44 per second, with a 136 ms maximum; 173 intervals exceeded 34 ms and 47 exceeded 50 ms. The final hidden samples were excluded from visible coverage. The frame and native summaries by stage are:

| Stage | Zoom | Motion | Frame intervals/s | Native peak | Native weighted CPU |
| --- | --- | --- | --- | --- | --- |
| 1 | Page width | 50.018 s | 59.83 | 769.49 MB | 75.39% |
| 2 | 50% | 50.019 s | 59.68 | 971.40 MB | 95.05% |
| 3 | 80% | 50.009 s | 59.64 | 1,114.89 MB | 87.33% |
| 4 | 160% | 50.009 s | 59.55 | 1,257.73 MB | 95.60% |
| 5 | Page width | 50.011 s | 59.35 | 1,288.05 MB | 105.93% |
| 6 | 50% | 50.022 s | 58.47 | 1,452.04 MB | 105.85% |
| 7 | 80% | 50.017 s | 59.49 | 1,602.11 MB | 91.65% |
| 8, partial | 160% | 8.602 s | 59.78 | 1,403.19 MB | 106.23% |

Native counters cover 776 memory/CPU samples and 390.280 seconds, including the tap wait and cleanup. Weighted CPU over that full interval was 88.35%, peaking at 164.10%. Native memory peaked at 1,602,112,512 B and ended at 1,016,332,288 B. At the peak, 1,312,638,675 B belonged to `page` and 223,413,549 B to JavaScript. Inspector's [`page` category sums bmalloc and LibcMalloc allocations](https://github.com/WebKit/WebKit/blob/a08d46521cd6f2af2121d9ef8f50cdf98197f23b/Source/WebCore/inspector/agents/InspectorMemoryAgent.cpp#L150-L153), so it includes more than the application's counted caches. Native stages 1 through 5 were preserved as during-run numeric summaries before their raw rows rolled out of the bounded tail; their provenance is recorded in the fixture.

Sampled raw residency peaked at 122,788,416 B, with at most seven active worker operations; the worker's peak counter grew from 6,265,408 B to 160,930,368 B during the run. The decode queue reached 54 waiting jobs, and decoder concurrency remained one. Decoded page bitmaps peaked at 134,824,952 B and native canvases at 43,379,280 B. Retained previews stayed within eight MiB, and sampled fleet resources within four actors, 413,440 B of cargo and 204,800 B of sprites. Stages 3, 4, 7 and 8 performed zero robot paints. The saved browser sample nearest the native peak had no fleet resources and 87,136,832 B of raw residency across five active operations.

All 6,293 completed PDF bodies passed exact range checks, transferring 6,815,310,336 body bytes. Preview responses contributed 99,754,498 body bytes, 1.44% of the observed total. Seven completion decoded-byte summaries disagreed with complete data events; those differences stayed separate from body validation. All 122 cancellations were preview requests. The browser counted 74 refinements but no completed deposits during this repeated traverse; the short photo scenario remains the place to inspect a complete delivery and readable caption.

The actual visibility transition lies within a 510 ms sampled bracket that contains the wake-lock release. The critical notification followed the recorded release by approximately half a second under host/client clock association. Native timestamps show memory falling from 1,358,671,104 B to 1,021,263,872 B, with the lower-memory sample 270.774 ms before that notification; host delivery reversed the latter two events. At the pinned official WebKit revision, [`prepareToSuspend` can call a critical synchronous memory release](https://github.com/WebKit/WebKit/blob/a08d46521cd6f2af2121d9ef8f50cdf98197f23b/Source/WebKit/WebProcess/WebProcess.cpp#L1902-L1963), and [`MemoryRelease.cpp` reports `didHandleMemoryPressure` after the release work](https://github.com/WebKit/WebKit/blob/a08d46521cd6f2af2121d9ef8f50cdf98197f23b/Source/WebCore/page/MemoryRelease.cpp#L193-L225). This ordering fits suspension cleanup; the phone-side trigger remains unobserved in the recorder.

The last three visible samples already had zero worker operations, pending range requests, active/queued decodes, decoded page bytes and fleet resources, with raw residency at 33,528,384 B. Cleanup restored page 46, page-width scale, scrollTop 23685, sidebar, robot/lab settings and focus exactly; preview requests also drained. Observers and the probe were removed while the inspector owner stayed attached. The final document was hidden, pages 46/47 were undisplayed, and observed awake idle was zero. The receipt remains interrupted with exact coordinate restoration.

Comparing the same first five workload stages gives the following prefix measurements. Both runs began at page 46 with the same page-width scale and 20,095,344 B of native canvases. The new start was colder: 6,265,408 B of raw data and five previews, versus 33,528,384 B and 38 previews in the earlier attempt.

| First five stages | 6f2345e | b8920d6 |
| --- | --- | --- |
| Motion | 250.068 s | 250.066 s |
| Frame intervals/s | 59.580 | 59.610 |
| Maximum frame gap | 98 ms | 76 ms |
| Intervals over 50 ms | 34 | 24 |
| Observations without useful pixels | 3 / 914 | 0 / 920 |
| Tracked fetch-byte increase | 4,576,324,902 B | 4,806,014,278 B |

The newer prefix fetched 5.02% more bytes. These values come from the browser's first/last fetch counters for the five stages, including PDF and preview traffic. Whole-run native peaks above cover different motion durations, 278.608 and 358.707 seconds, and remain separate from this 250-second prefix comparison.

### Completed two-pass traverse

The [traverse fixture](../scripts/pdf-viewer-harness/safari/fixtures/traverse-2026-11-05-b8920d6.json) records the next operation on the same retained b8920d6 document and inspector connection after Safari returned to the foreground. It kept the existing caches and encounter ledger. Both 60→90→65 passes completed, with 11.036 seconds of motion against the selected 11-second route. All 130 visible page observations had useful displayed pixels, including all four detached-native observations. Motion intervals averaged 59.51 per second, with a 49 ms maximum gap.

The robots-on interval lasted 8.001 seconds and the robots-off interval 4.004 seconds; each recorded zero additional robot paints and quiet fleet state. Exact reader, panel and focus restoration passed. The final viewport was visible and displayed, with no missing pages, followed by 1,500 ms of continuously observed awake idle, a 28 ms maximum frame gap and zero added effect frames. Observers and the probe were removed, the owner stayed attached, and all 46 RPCs completed without validation, protocol or cleanup errors.

The native recorder collected 60 memory/CPU samples with no dropped rows or pressure event. Memory began at 471,825,920 B, peaked at 935,495,808 B and ended at 749,767,040 B. Weighted CPU was 42.92% across the full 29.739-second recording. Current raw residency peaked at 54,368,832 B with at most three active operations; the 160,930,368 B worker lifetime peak was unchanged from the preceding run. Preview retention stayed within eight MiB, native canvases within 20,095,344 B, and decoded page bitmaps within 4,734,208 B. The already-seen pages admitted no new robot episodes or cargo.

All 520 PDF bodies passed exact checks, totaling 301,544,576 body bytes, with no missing body evidence or completion-summary discrepancy. Five preview requests were canceled and all requests drained. Three scheduled workload screenshots clustered in robots-off idle at approximately 20.1, 20.5 and 20.9 seconds because the short route inherited unsorted capture thresholds. That interval's 106 ms maximum includes capture cost; motion and final awake-idle figures above are separate. A fourth screenshot recorded the finished restored state.
