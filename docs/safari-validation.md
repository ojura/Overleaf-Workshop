# Physical Safari validation

The tools in `scripts/pdf-viewer-harness/safari/` exercise the published reader in an existing Safari tab on a paired iPhone. They preserve the reader state and collect both browser measurements and native Web Inspector memory, CPU and network events. The [reader guide](spomenar.md) describes the application; [PDF prefetch](pdf-prefetch.md) describes its rendering and resource limits.

## Setup and ownership

The observed device was an iPhone17,1 running iOS 27.2. The host used Python with `pymobiledevice3` 11.20.2, pinned in [requirements-live.txt](../scripts/pdf-viewer-harness/safari/requirements-live.txt). The installed library matched the official wheel's Python source; no local Inspector patch was required. Use an existing isolated Python environment or install that requirement in one dedicated to the live tools. Offline fixtures use Python's standard library and Node, without attaching to a device.

Keep the pairing record and device selection in an external JSON file with `udid` and `pair_record`. Copy [document.example.json](../scripts/pdf-viewer-harness/safari/document.example.json) to an external file and update its `pageUrl`, `entryUrl`, `pdfUrl`, PDF SHA-256, byte length and page count for the exact publication. All three URLs must share the origin, and the reader URL ends in `/`. Generated receipts, screenshots and raw recordings belong in an output directory outside the repository. The maintained fixtures contain public document identity and selected numeric observations only.

Open the existing Spomenar tab on the phone, keep Safari in the foreground and leave the reader untouched during the agreed workload. A paired USB connection does not establish that the desired page is inspectable or foreground. The runner checks the exact origin and page path, requires one matching tab, and uses its existing Web Inspector target. It does not create a tab, browser profile, automation bridge or debug port.

One host process owns the inspector connection. Subsequent source checks, probes and result collection use that owner. A second inspector must not attach while the owner is active. If the page temporarily stops replying, preserve the owner and its identity while checking whether the same page has returned. The sustained probe retains its token-owned terminal report for recovery after reconnection. Short abort and watchdog cleanup restore the owned reader state, remove observers and delete the short probe; they leave no terminal-report accessor for `recover`. If that short result was not collected, retain the failed attempt and verify the returned reader state and owner closure separately. Repeating a workload before resolving the original attempt would lose the distinction between attempts.

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
| `short` | `--scenario short --pages 101 102` | Actual photo delivery, screenshot, refinement/retirement and finite Motion Lab drag/resize/dock checks. |
| `manual` | `--scenario manual --seconds 120` | Passive observations while the user performs actual pinch, fling, selection, rotation and toolbar/lab actions. |

For the short scenario, `--pages` selects exactly two distinct positive PDF page numbers within the configured document. Each must have photo regions in that edition's atlas. Omitting the option preserves the default pair, 99 and 100. Choose a pair that includes a page whose first delivery has not already been admitted in the current document. Cached pixels can supply a first delivery, but returning to a previously handled page does not replay it. The probe records the first qualifying photo payload from either target; it does not require both pages to admit an episode.

```sh
"$SAFARI_PYTHON" scripts/pdf-viewer-harness/safari/safari_owner.py command \
  --execute --work-dir "$SAFARI_WORK" --id short-1 run \
  --prefix short-1 --scenario short --pages 101 102
```

For a passive manual session on the same retained connection:

```sh
"$SAFARI_PYTHON" scripts/pdf-viewer-harness/safari/safari_owner.py command \
  --execute --work-dir "$SAFARI_WORK" --id manual-1 run \
  --prefix manual-1 --scenario manual --seconds 120
```

For a stale release, submit `activate` without `--source-only`, adding the new `--entry-file` if the owner was started against an earlier release. `recover --receipt-prefix <original-prefix>` collects the surviving original sustained probe. `restore-focus --receipt-prefix <original-short-prefix>` restores the original semantic focus after a short result has restored its reader coordinates and released its probes. `resume` explicitly asks the existing Safari application to resume without creating a tab. `transport-check` performs the maintained bounded Inspector transport diagnostic. `status`, `stop` and `close` report state, stop the owned workload, or close the owner respectively. Every command includes the same `--work-dir`, a fresh `--id`, and `--execute`.

An invocation without the execution flag is inert. Command receipts are consumed before mutation so repeating an ID cannot repeat a workload. Keep the owner attached through result collection and review; use `close` when finished. Host errors and an unavailable page are recorded without silently starting a different attempt.

Before a new workload, obtain a fresh owner status with no operation running. It reports `probes.sustained`, `probes.manual` and `probes.short`, plus their aggregate `probePresent`; all three must be false. Read the current page, scale, scroll and focus fields as the new restoration baseline. Earlier receipts whose `probePresent` checked only the sustained probe cannot establish short or manual probe absence.

The host prepares each browser initializer as an inert function and sends one no-op command to flush buffered source delivery. The initializer's own response supplies the function handle and controls completion. The no-op's reply is not a second completion barrier: its local waiter is released after the authoritative response, and that owned release is distinct from a failed RPC. A failed auxiliary send, missing authoritative response or source error still stops preparation under its existing deadline, before the initializer is invoked.

## Verify and activate the executed release

First read the entry script already loaded by the owned page. Native WebKit's `scriptParsed` event does not supply CDP's execution-context association, so the source check requires a single main frame without child frames and one exact entry URL. It reads that script's source with `Debugger.getScriptSource`, checks its byte length and SHA-256, and disables the temporary debugger on every outcome. Ambiguous script or frame identity stops the check.

If the executed source matches, keep the current document and skip reload. This branch is useful even when an automatic reload would be unsafe to restore.

For stale source, capture page, numeric scale and scale value, rotation, scroll/spread modes, scroll offsets, sidebar, robot toggle, Motion Lab visibility/geometry and actual focused control. Stop before navigation when pinch scale is not one, text selection or editing is active, focus cannot be recovered, the panel or column has pending movement, or a nonempty effective bookmark may navigate asynchronously. Numeric page/zoom bookmarks and an ordinary empty URL hash are supported. Named destinations, explicit destination arrays and search-driven hashes require a separate navigation-aware procedure.

The temporary native `Page.setBootstrapScript` guard spans the reload. One JavaScript call rechecks the current token, trusted input and saved view, marks the owned navigation, and calls `location.reload()` in the same turn. Context loss after that call is an attempted navigation; it must not trigger a second reload. The old document's expected pagehide/visibility events are recorded separately from user input. The new document must retain the exact origin and a fresh time origin.

Wait for `isInitialViewSet`, fulfillment of the captured same-document `pdfViewer.pagesPromise`, and two actual animation frames before restoration. Pinned PDF.js may apply its initial view twice when page dimensions differ. Restore the captured numeric view after those passes, then verify reader, sidebar, lab and focus state. For saved BODY focus, blur the current control and verify BODY became active; BODY.focus() is not a reliable restoration method. A saved element ID is valid only when it resolves to that exact light-DOM element.

Activation and short restoration share `reader-focus.mjs`. The pinned anonymous page text layer has a page-number focus descriptor only when it is exactly that page view's `textLayer.div`, inside its connected authoritative page root and reader. The short serializes that descriptor before changing the reader. After the saved numeric view is applied, restoration waits for the page view's current connected text layer under the same cancellation guard and restoration deadline, focuses it with `preventScroll`, and checks the semantic focus and reading coordinates. Lab handles have unique physical directions in `data-panel-resize`, so focused edge and corner controls can be reacquired exactly.

Saved Lab restoration first restores the measurements disclosure, waits for its queued native toggle event, then waits for its content-height change to settle. It then restores the dock and waits for both movement markers to clear and measured geometry to settle before applying direct gestures. Use the southeast handle for a floating panel, east for a left dock and west for a right dock. Floating geometry uses one synchronous move toward the saved position, resize, then final position correction, followed by one settling wait. Moving first allows anchored growth; the final correction handles a starting panel whose larger size initially limits its position. Applying the disclosure after these gestures would replace the restored height with the new content fit.

The activation deadline reserves separate time for restoration, bootstrap/guard removal and inspector cleanup. If input or navigation transfers ownership to the user, stop applying saved state. Let the temporary token expire and remove reachable bookkeeping; do not navigate the user back to a page solely to clean up a token.

If a failed short has restored its coordinates and modes but failed focus restoration, use the retained owner with the exact release that produced the receipt:

```sh
"$SAFARI_PYTHON" scripts/pdf-viewer-harness/safari/safari_owner.py command \
  --execute --work-dir "$SAFARI_WORK" --id focus-1 restore-focus \
  --prefix focus-1 --receipt-prefix short-1
```

The command reads the short's original `focusRecovery` state. An older short that omitted this descriptor requires `--focus-receipt-prefix <original-activation-prefix>` naming its successful activation receipt; that receipt's preserved, restored and verified states must agree with the short's saved reader state. A fresh capture cannot replace the original baseline. The command verifies the executing release, document, URL, page, scale, scroll, modes, sidebar, robot/Lab settings and panel geometry, and requires all three probe globals to be absent. Trusted input, active selection/editing, changed reading state or an unavailable canonical focus target causes failure. It applies only focus with `preventScroll`, verifies again and releases its guard. It writes a separate recovery receipt and preserves the original failed result. An owner started with tooling that predates this command must close normally and restart with the corrected tooling on the same existing tab; this operation does not activate or reload the site.

## Coverage

| Check | Evidence collected |
| --- | --- |
| Executed release and publication | Entry SHA/bytes; exact PDF size, page count and preview manifest identity; actual HTTP range validator. |
| Useful page pixels | Connected preview or finished native canvas, positive backing and displayed dimensions, and computed visibility. A detached native canvas counts as covered only if a displayed preview covers it. |
| Queued photo protection | Each connected plan-owned arrival cover has a positive safe-integer `data-delivery-plan` and a nonnegative safe-integer `data-delivery-crop`. The unique pairs exactly match the queued, protected crops in `deliveryPlans` and the `queuedDeliveryCovers` total. |
| Photo delivery | Exact atlas source IDs, committed plan/crop identity, logical crop kind and target, stable payload/operation IDs and original deadline; cargo and arrival-cover ownership. |
| Retirement | A zero-sized payload has released every associated pixel artifact and cannot regain a raster or refinement. Helpers may finish their independent route. |
| Refinement | The same live payload keeps its target/deadline and increases or preserves raster dimensions. A natural retirement between samples is recorded separately from refinement. |
| Quality reaction | Separate source/plan/crop/actor identity, coarse and sharp backing dimensions, displayed layer geometry, fixed deadline and monotone wipe progress; an exact `completed` or `cancelled` terminal outcome. Cargo-to-page transfer preserves this owner after payload retirement. |
| Phone limits | Compact device policy, at most four actors, the selected cargo/sprite limits, eight MiB of retained previews and at most two preview-source requests. Record current values separately from lifetime maxima. |
| Reader input and controls | Hover/tap where applicable, scroll/zoom, sidebar, Motion Lab drag/resize/dock, shared page/actor/annotation coordinates and toolbar clipping. |
| Native workload | CPU and memory events, memory-pressure severity, each PDF range response/body, preview transfers and cancellations, and RPC completion/timing. |
| Final state | Exact saved reader/sidebar/lab/focus values, released queued covers, payload artifacts and independent quality scenes, finite observer/lease cleanup, useful visible pixels and an actual-frame idle interval with unchanged robot frame count. |

Short and passive manual observations include `surfaceObservation` from the shared [page-display observer](../scripts/pdf-viewer-harness/safari/surface-observation.mjs). It samples each animation frame and retains changed states, the first and final snapshots, and bounded mutation/render-event histories. The inventory includes visible pages, their neighbours and previously tracked roots; all connected canvases and wrappers; detached main/detail references; and the reader, page and layout ancestors. Stable node IDs, backing sizes, computed visibility, transforms, clipping, geometry, image revisions and intent IDs distinguish a removed raster from a stale public canvas reference. The observer reads geometry and state without requesting pixels, rendering, input or navigation.

The same timeline records each page's semantic loading value, its `loadingIcon`/`loading` classes and `hasUsefulPresentation`, plus the actual `#pageNumber` loading class. An unmanaged semantic value is recorded as null. Native render events and `pageloadingstatechanged` retain both the semantic value and current indicator class. Class mutations on the indicator are observed even when it sits outside the reader; old values retain toggles that occur between animation frames. Raster, wrapper, page, ancestor and indicator changes are filtered before mutation limits are applied, while `ignoredMutations` counts unrelated records.

The short capture begins before navigation and continues through delivery, panel movement, restoration, restored readiness and the final idle check. Its phase labels identify those boundaries; a quiet final viewport cannot substitute for the preceding transition. For a return from eviction, inspect the connected preview and native nodes through each rejected and accepted pass. An accepted preview should remain usable until a successful native replacement commits. Correlate frame snapshots with node mutations and render events: a public `view.canvas` reference can be null while an earlier connected canvas remains displayed, and callbacks within one animation frame can observe different intermediate DOM states.

Capture exceptions stop this observer and propagate into the workload's existing error list during cleanup. A transition review requires `stopped: true`, an empty observer error list, and first/final coverage spanning the relevant phases. Check `droppedChanges`, `droppedEvents`, `droppedNodes`, `droppedPages`, per-snapshot omissions and omitted added/removed nodes before treating the recorded interval as complete. Unrelated ignored mutations are recorded separately. Cleanup captures the final state, drains pending mutations and removes the animation-frame callback and listeners.

The shared artifact observer distinguishes queued protection from admitted payload work. A queued arrival cover belongs to its plan and crop before cargo or actors are allocated, so it carries the two plan markers without `data-payload`. Missing, malformed, duplicate, stale or mixed ownership fails the observation. A queued marker on cargo, a refinement underlay or a cleaner also fails. Admission keeps the same cover node, removes both plan markers and assigns its positive payload ID. The actual-renderer regression verifies this handoff, and the observer continues checking payload identity, refinement and retirement after it. A retired payload cannot regain any pixel artifact.

Historical recordings can still contain payload-owned `CargoUnderlay` and `Cleaner` artifacts. The portable observer keeps their strict ownership and zero-after-retirement checks so those recordings remain reviewable. Current production quality reactions use the single independent owner below; the historical fixture is preserved as recorded rather than rewritten with current fields.

Independent ASAP quality work uses `pdfDocumentRobotQualityCoarse`, `pdfDocumentRobotQualitySharp` and `pdfDocumentRobotQualityCleaner`, each with a positive safe-integer `data-quality`, page number and opaque logical image ID. These layers carry neither payload nor queued-plan ownership markers. `payloadArtifacts.quality` inventories their actual backing sizes, displayed rectangles, computed clipping and effective ancestor visibility. With `sharpKind: 'cargo-copy'`, the scene owns all three layers. With `sharpKind: 'native-page'`, it owns only coarse and cleaner, with zero sharp-copy dimensions/bytes; the coarse overlay clips away to expose the accepted native raster recorded by the page-display timeline. The shared observer binds the exact layer set to one committed `qualityReactions` scene and its frozen delivery-plan crop. It checks source aliases, target, actor, byte charges, fixed deadline and monotone progress. A cargo association must name its still-live payload; transfer to the page preserves that borrowed identity, releases the sharp copy and leaves the payload's terminal pixel rule intact. The cleaner cannot also own delivery cargo.

`qualityOutcomes` records completed and cancelled scene identities separately. A disappearing observed scene requires its own terminal outcome, and terminal scenes or their pixels cannot reappear. The observer retains that history throughout the bounded run. For wipe acceptance, inspect actually displayed clipping changes, increasing wipe progress and its matching completed outcome, including a final source upgrade that arrives after deposit. In page mode, correlate the shrinking coarse overlay with the connected final native raster behind it. Direct-sharp fallbacks retain their explicit reason. Refinement counts and a cleaner allocation alone do not establish the visible pass. `payloadArtifacts.captions` records actual caption text, geometry and effective visibility; correlate it with `encounters.dialogue.coverage` meaning IDs during ordinary work or repeated attention. The existing continuous surface recorder also inventories quality layers and caption text through the host screenshot interval between short-phase samples, preserving node/quality identities, clipping and ancestor visibility until removal. This inventory shares the recorder's node, change and event caps; omitted nodes, dropped entries and truncated text remain explicit when assessing capture completeness. The authored opportunities and source references live in [the canonical catalogue](../views/pdf-viewer/src/common/robot-dialogue.ts).

The short photo check treats `imageId` as an opaque logical crop key. It resolves the separate `imageIds` in the exact page of the verified atlas and binds the payload to one committed `deliveryPlans` crop. The plan and payload must agree exactly on logical key, source IDs, crop kind and normalized target. Whole-image cargo matches one source rectangle; a collage matches the bounding rectangle of its distinct, nonoverlapping source placements; a portion matches one cell of its source photograph's fixed grid. Source coordinates include the atlas's intrinsic page orientation, so validation applies only the viewer's additional rotation. Independent atlas arithmetic permits a normalized tolerance of `1e-12`; comparison with the committed target remains exact. Identical-rectangle aliases omitted by selection do not become additional required members. The result records every selected source region and its plan/crop IDs.

Only a live, pre-deposit atlas-backed crop can satisfy the positive photo criterion. Deposited or returning helpers, zero-sized cargo and generic fallback fragments are skipped while the probe inspects later candidates. Fallback fragments have an empty source-ID list. Unknown or duplicate source IDs, ambiguous atlas mappings, changed plan ownership or invalid geometry fail validation. The original operation key and member IDs, source IDs, crop kind, target and deadline remain stable through refinement and retirement. Carry helpers must match the committed members. After deposit, an empty return can recruit an additional helper while retaining those members, with zero cargo dimensions and the arrival cover released. Numeric body IDs remain bound to their payload throughout the observation; using the same vehicle for another job creates a new body ID.

Both short and sustained completion require the queued-cover DOM inventory and `queuedDeliveryCovers` to reach zero along with admitted cargo, covers, helpers and retained bytes. The separate quality-scene count, live scene list and quality DOM inventory must also be empty, even after all payloads have retired. A stationary queued cover or a waiting quality scene still owns work and prevents navigation, panel movement or a quiet completion. Terminal selection, exposure and quality outcomes remain available as history; they retain no active protection or copied pixels. The validation checks released resources without discarding that document history.

The short scenario waits for the saved visible scene to finish before its first navigation. Its current view must display useful pixels, drain native/source work and release queued protection and admitted effects, with panel and column movement finished. After entering a target, it samples eligible cargo immediately. Without a qualifying photo, it advances to the second target only when that target belongs to the current visible view, has displayed canvas evidence and passes the same readiness check. A spread's current-page indicator may name its other visible member. A settled scene without photo delivery can advance; pending work stays in view until readiness or the existing active deadline. Once cargo is observed, finish keeps that scene visible until it passes the same check and the exact selected plan/crop/page/payload binding records `delivered`. Cancelled, skipped, missing or changed ownership fails even when resource counts have reached zero. Only then does the probe move the panel or restore the reader. Expiry records the incomplete phase and restores normally. These steps preserve valid queued protection and the document's encounter history.

Keep the short and manual scenarios separately named: two page 60 to 90 to 65 traversals for reversal/recovery, robots enabled/disabled and natural idle; a first-delivery/refinement/retirement check; and actual trusted pinch, fling, text selection, orientation, toolbar and lab manipulation. Programmatic scrollTop and viewer scale changes do not exercise those trusted gesture paths.

The short scenario waits for the panel and column movement flags to clear, then checks stable measured geometry on consecutive animation frames. This includes the quiet period for a pending destination, stationary approach, parked continuation and the panel's wait for the column. Floating placement may shift the column in either direction: a feasible placement must preserve the whole visible page/spread and a 16 px panel gap; an already-clear column or a layout with no feasible side keeps zero displacement. Each panel settle has a six-second failure limit. The host defines one shared budget of 35 seconds for delivery observation, five seconds for capture and 60 seconds for finish, totaling a 100-second work watchdog, with 15 seconds reserved for recovery. Metadata loading, initial-scene readiness and both target entries share one absolute active deadline. The browser cancels unfinished metadata requests and removes its active-phase timer when that phase ends. Selected-scene settlement, panel checks, restoration, final readiness and its 1,500 ms continuous awake-idle interval share the finish deadline. Preview requests, native decodes and external-image work must drain while useful pixels remain displayed; resumed rendering or a frame gap over 100 ms restarts the idle interval. Both active and finish terminal replies are collected within the remaining host work budget, keeping the later restoration and recorder-cleanup allowances available. These are limits, not inserted delays. Normal finish, abort and watchdog share awaited panel restoration before reader/focus cleanup; trusted input ends that restoration without overwriting the user's state.

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

Successful automated completion requires exact reading, panel and active-element restoration; a visible viewport with useful displayed pixels; drained native/preview work; released fleet resources, including queued plan-owned covers; and at least 1,500 ms continuously observed through actual animation frames with zero additional robot paints. A frame gap over 100 ms restarts that idle interval. `document.hasFocus()` is recorded but is not an awake-success predicate: this phone returned false during visible 60 fps work. Hidden samples retain their numeric state but do not contribute to visible-coverage totals or claim displayed pixels. A hidden interruption can verify coordinates without being labeled an awake completion.

Keep native recording active through the workload and final restoration. Record screenshot intervals so CPU/frame analysis can identify their cost. A terminal failure is still a useful capture: retain its first failure, last acknowledged state, native event tail and cleanup outcomes.

## Interpret the measurements

Native process CPU can exceed 100% when several cores work. Calculate its weighted mean from timestamp intervals. Native memory categories such as `page` cover more than the explicitly counted PDF canvases; keep those measurements separate from the application's raster, decoded-image and raw-byte budgets.

For a completed PDF range, compare actual `Network.dataReceived` body lengths with the requested range, `Content-Range` and `Content-Length`. Preserve encoded bytes, decoded bytes, completion summaries and advertised lengths as separate counters. WebKit's completion `responseBodyDecodedSize` can disagree with its data events; record that discrepancy rather than replacing valid body evidence. Short actual data still fails even if a completion summary claims the expected length.

The native recorder accumulates counters over the full observed interval. Its detailed tails hold the newest 512 memory samples, 512 CPU samples, 1,024 requests, 32 pressure events and 64 errors. The dropped-tail counters describe detail removed from those arrays; the accumulated native totals remain. Report which client aggregates were actually recovered when the page or inspection channel becomes unavailable.

Compare fresh runs with the same initial document, page, zoom, viewport, cache state and power conditions. Preserve the exact executed entry identity in the receipt. Differences in those conditions belong beside the comparison. Readiness from an available low-resolution preview and readiness of the final native canvas are separate observations.

## Completed short check, 10 November 2026

The retained USB owner completed `final-short-2` with status `passed` in 23.168 seconds. The preceding `source-readiness-2` check verified the executing entry at `/spomenar/assets/spomenar.mjs`: 339,059 bytes, SHA-256 `77d5bd3981a323ad65b6a2c1e9cfce230fd2fabeca078183b80f9fff55431221`. Its binding was `single-main-frame-unique-entry`, its source matched, and source inspection finished in 92.5 ms without navigation. Source-check cleanup succeeded, the target stayed unchanged, and all nine source-check RPCs completed, including domain disable and object-group release.

The public book was 1,608,358,464 bytes and 460 pages, SHA-256 `6abb3d0b13d2970bca0f613287a6ea5d30280be14435b5c681b8ca8bd61d24d0`. The configured pair was PDF pages 101/102. The first target, PDF page 101, supplied the active delivery, so this short scenario completed there. The owner inspected the saved screenshot: printed page 90 / PDF page 101 showed the sharp photograph grid and the complete drone-and-lynx crop being carried with the robot. The screenshot was `short-9072edf826361bc6d74f5e0b.png`, 2,044,738 bytes.

### Delivery and refinement

Useful displayed native pixels appeared 438 ms after navigation. Four initial samples reported page 101 missing, at 203, 296, 377 and 464 ms after browser observation started. All 84 samples recorded a visible document. The final restored viewport had useful displayed pixels and an empty missing-page list.

The active delivery was payload 8, image `p101-i7`, using L-UGV 12 and heavy quad 13 as an airlift team. The cargo raster was 240 by 136 pixels, 130,560 bytes, with pointer events disabled. Six directly observed, stable refinement comparisons followed the payload counter through 0, 1, 2, 3, 5, 6 and 8. Every comparison preserved the payload deadline, helper IDs and target. Those six comparisons captured eight counter increments because two comparisons spanned more than one refinement. A stable `retired-between-samples` observation then recorded the same payload deposited, its operation fulfilled, its raster reduced to zero by zero and its arrival cover removed. Delivery settling completed 1,358 ms into the finish wait.

The following changes compare the first recorded sample, taken after navigation, with final idle. They are sampled changes within this run; the final values also include activity before this capture.

| Counter | First sample | Final idle | Sampled change |
| --- | ---: | ---: | ---: |
| Episodes | 2 | 3 | 1 |
| Delivered fragments | 4 | 5 | 1 |
| Refinements | 8 | 16 | 8 |
| Operation admissions | 4 | 5 | 1 |
| Operation candidates | 181 | 247 | 66 |
| Commit checks | 10 | 13 | 3 |
| Narrative records | 4 | 5 | 1 |
| Admission time | 7 ms | 12 ms | 5 ms |
| Renderer frames | 452 | 834 | 382 |
| Renderer paint time | 159 ms | 282 ms | 123 ms |

Maximum paint time was 6 ms. Recorded samples peaked at two actors against the four-actor limit, 130,560 cargo bytes against 524,288, and 202,920 sprite bytes against 204,800. Combined retained robot bytes peaked at 333,480, with one active payload and one arrival cover. The snapshot's cumulative cargo peak was 273,920 bytes; this capture's sampled cargo maximum was 130,560 bytes.

### Panel checks and restoration

All five panel trials preserved PDF page 101, scale 0.6, scroll top 57,600, scroll left zero, rotation zero, scroll mode zero, spread mode zero and sidebar zero. Each completed with panel and column motion stopped. The viewport was 402 by 654 pixels; the reader was 402 by 548; scroll dimensions stayed 402 by 264,960.

| Trial | Panel rectangle: x, y, width, height | Column translation | Settle time |
| --- | --- | ---: | ---: |
| Drag | 54, 80, 340, 554 | 0 px | 22 ms |
| Resize | 54, 80, 320, 534 | 0 px | 14 ms |
| Dock left | 8, 8, 320, 638 | 1.5 px | 3,726 ms |
| Dock right | 74, 8, 320, 638 | -1.5 px | 3,715 ms |
| Float | 54, 80, 320, 534 | 0 px | 3,715 ms |

Panel opening settled in 2 ms, floating geometry restoration in 12 ms, and panel restoration in 16 ms. The restored floating rectangle, 54, 92, 340, 554, exactly matched the panel's geometry before the trials. Motion Lab was initially disabled with `savedPanel: null`, and was disabled again after restoration.

The final reading state exactly matched the saved state: page 100, scale value `"0.6"` and numeric scale 0.6, rotation zero, scroll mode zero, spread mode zero, sidebar zero, scroll top 56,874, scroll left zero, robots enabled and Motion Lab disabled. Document focus was false before and after; active-element restoration succeeded. `restored`, `focusRestored`, `restorationExact`, `probeRemoved` and `observersRemoved` were true. The restored viewport was visible and displayed.

### Awake idle and resource release

Readiness observation lasted 8,350 ms and included 1,501 ms of continuous awake idle, with a 23 ms maximum frame gap and zero added robot frames. `awake` and `quiet` were true. At completion the robot renderer was unscheduled at frame 834. Active episodes, actors, payloads, arrival covers and refinements were zero, as were cargo, sprite and retained robot bytes. Arrival, cargo, underlay, vehicle and cleaner DOM node counts were zero. Prefetch was idle with empty pending work and zero pending fetches.

The preview source was ready with zero pending requests, decodes or queued decodes. Preview memory was 2,217,984 bytes against its 8,388,608-byte limit. The visible restored native canvases on pages 99/100 were each 1197 by 1698 pixels, giving 16,260,048 bytes of visible native raster storage at four bytes per pixel. Those visible pages had no preview canvases.

External image jobs finished with zero active, queued or paused jobs. Encoded, coefficient, reserved, partial-raster, native-raster and native-input byte counts were zero. Native decode active and queued counts were zero; concurrency and its cumulative peak were one. The cumulative external reservation peak was 66,118,208 bytes against 67,108,864, and cumulative native input peak was 11,358,968 against 67,108,864.

From the first sample to final idle, native decode completions increased from 54 to 89; external image bytes from 217,758,928 to 332,950,872; first scans from 28 to 50; image revisions from 82 to 139; and final decode time from 9,745 to 14,746 ms. Fallbacks increased from 34 to 51: 13 additional shared-state-budget fallbacks and four state-budget fallbacks. These sampled changes include loading the restored reader. Image failed and cancelled totals stayed zero.

### Native recording and reporting differences

Recording covered initialization through collection of the terminal result, with 46 memory and 46 CPU samples. Every dropped-detail counter was zero. Pressure and error lists were empty. Network, CPU tracking, memory and memory tracking each had their corresponding stop or disable acknowledgement. The run was uninterrupted, with empty browser error, validation failure, cleanup error and RPC error lists. The owner retained the attachment through result and image review.

| Native measurement | Value |
| --- | ---: |
| Elapsed host operation | 23.167539 seconds |
| Elapsed short workload | 23.159298 seconds |
| Memory first / peak / last | 141,113,344 / 553,993,216 / 455,145,472 bytes |
| JavaScript category peak | 166,399,219 bytes |
| JIT category peak | 8,732,672 bytes |
| Image category peak | 60,817,408 bytes |
| Page category peak | 404,638,025 bytes |
| Other category peak | 16,678,912 bytes |
| Layer category peak | 0 bytes |
| CPU peak | 102.399986% |
| Weighted CPU time | 13.490017 CPU-seconds |
| CPU sample span | 22.661765 seconds |
| Last CPU sample | 7.4% |
| Maximum native sample gap | 505.207 ms |
| Maximum host sample gap | 527.305 ms |

Category peaks occurred at different times and are separate from total memory peak. Native CPU can exceed 100% across cores.

The recorder observed 60 configuration/preview requests: two configuration and 58 preview requests, all completed. Peak pending was one and final active requests were zero. Status counts were three 200 responses, sixteen 206 responses and forty-one 304 responses. Raw request records reported zero failed or cancelled requests; range validation failures were zero. The existing PDF data was cached, so this request count describes configuration and preview traffic.

| Network reporting path | Bytes |
| --- | ---: |
| Encoded `dataReceived` | 6,930,327 |
| Decoded `dataReceived` | 115,802,078 |
| Completion `responseBodyBytesReceived` | 6,930,327 |
| Completion `responseBodyDecodedSize` | 6,922,614 |
| Advertised body lengths | 6,922,614 |
| Completion response headers | 2,724 |

The decoded data-event total differed from the completion decoded-size and advertised-length totals. The recorder also retained 35 unattributed data events. These reporting paths remain separate; they are not added together or substituted for one another. The application's sampled external-image byte increase, 115,191,944 bytes, has a different interval and accounting scope from the native network totals.

This completed short check closes the outstanding acceptance item. After result and image review, the owner closed through the maintained command with process exit zero, `attached: false` and an empty `closeErrors` list; PID 1235665 exited. The result and recording remain outside Git as `final-short-2-result.json` and `final-short-2-recording.json`, the source-check receipt as `source-readiness-2-result.json`, and the screenshot as `short-9072edf826361bc6d74f5e0b.png`.

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
