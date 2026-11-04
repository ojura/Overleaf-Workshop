# Slipstream: predictive PDF loading

Slipstream is the shared viewer, predictive loading, and cache layer behind both extension engines and the standalone [Spomenar site](spomenar.md). They use the same controller, [pdf-prefetch.ts](../views/pdf-viewer/src/common/pdf-prefetch.ts), with PDF.js 5.1.91. Each passes its `PDFViewer` to `installPdfPrefetch` once during startup. Document replacement resets the controller through the page lifecycle events. [scroll-prefetch.ts](../views/pdf-viewer/src/common/scroll-prefetch.ts) owns the motion estimator and device cache policies.

## Scheduling and cache layers

The estimator follows CoS's `TimelineScrollDynamics`: react immediately to faster motion or a slower page, then decay the estimates gradually. Wheel events predict motion before the next scroll frame; the controller avoids counting that movement twice. Scroll events cover keyboard navigation and scrollbar movement. The selected policy's gesture gap clears velocity and acceleration, while the document's loading-time estimate remains available. The default is 250 ms; the estimator and controller settlement timer receive the same value. Acceleration is diagnostic; velocity, the latest displacement, and measured page latency determine the preload distance.

[Render timing](../views/pdf-viewer/src/common/pdf-render-timing.ts) excludes measurements made while the browser withholds rendering frames. While measurements are active, one probe requests a frame and starts a one-second timer. If the timer arrives within 100 ms of its deadline but the frame has not arrived, the active measurements are discarded. A late timer can reflect substantial foreground work, so that delay remains part of a valid render measurement. Cancellation, invalidation and disposal release the probe; it stops when the last measurement finishes.

The desired distance starts at two viewports, with a 480 px minimum. It grows with speed and page latency, up to twelve viewports or 12,000 px, whichever is smaller, while preserving the base distance for large viewports. Direction changes immediately on reversal.

The controller uses five cache layers:

1. The extension keeps verified content-addressed pieces and incremental range blobs on disk, under one budget across all builds.
2. PDF.js stores received bytes as sparse chunks within its active document.
3. Prepared PDF pages retain PDF.js display operators and decoded resources.
4. Small raster previews cover pages while full-resolution rendering catches up. Mobile retains nearby previews at up to 512 px and reduces older detached previews to 192 px before eviction.
5. PDF.js owns the full-resolution page canvases and their rendering queue.

The persistent [disk cache](../src/core/pdfDiskCache.ts) accepts complete GET requests to `/content/<contentId>/<SHA-256>` when the response bytes match the hash, and verified `output.pdf` ranges with stable validators. A build is represented by byte-interval metadata and received blobs. The host fills missing intervals gradually while every visible reader is idle. The configured `pieceCacheSizeMB` budget, 4096 MiB by default, includes old and new builds, reusable content pieces, range blobs, metadata, and bytes reserved for current writes. A new build does not create a full-size file. `0` disables disk caching and background fill.

The cache owns its operation queue and short writer leases. Network transfers run outside the writer lease and foreground read queue. Exact-build exports use the same cache admission and cancellation machinery.

Each cached single or multipart response captures one manifest, validator, segment list and complete set of ordered read plans before reading bytes. A concurrent host can publish a new representation without mixing it into that response. If any captured immutable blob disappears, the entire cache hit is rejected. `If-Range` requests use the origin path so its [HTTP conditional-range rules](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.5) decide whether the range applies; a whole-document `200` is canceled before its body is read.

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

### Host response ownership

The shared [bridge response helper](../views/pdf-viewer/src/common/bridge-response.ts) consumes bytes that have already arrived in a private host message. It transfers the owned buffer into a native byte stream instead of copying it into `Response`, then reads that one complete chunk directly. Full-span chunks reuse their transferred backing buffer; sliced views get one exact-range copy so neighbouring bytes cannot escape. Transfer accounting runs before enqueue detaches the original buffer.

The build adapts exactly two response-consumption sites in the pinned Overleaf loader, and stops if their source no longer matches. Both extension engines use this path. The original HTTP responses used by Spomenar follow native `arrayBuffer()` consumption. Cloned, locked and consumed responses also keep native handling; [Fetch's body-clone operation](https://fetch.spec.whatwg.org/#concept-body-clone) replaces the original stream with a tee branch, so neither clone branch is marked for direct consumption. Final PDF range reassembly still owns a separate buffer for transfer to the worker, preserving chunks retained by the incremental loader.

### Budgets and thresholds

The authoritative values are selected by `pdfCachePolicy()` in [scroll-prefetch.ts](../views/pdf-viewer/src/common/scroll-prefetch.ts). Phones and tablets use the mobile policy, including iPads with desktop-mode user agents. A touchscreen desktop keeps the desktop policy. Callers can provide an explicit `cachePolicy` to the shared controller.

The policy separately owns sidecar browser decoding through `sidecarDecode.concurrency` and `sidecarDecode.maxInputEdgeScale`, a multiplier of the retained preview edge. `pdfSidecarDecodeOptions()` derives those consumer limits in the same module. Legacy custom policies without the optional setting retain the previous named-profile fallback. Sidecar decoding and PDF worker image jobs remain independent consumers with explicit budgets.

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

The native Overleaf viewer can defer document installation through `startViewTransition`. Its [preview binding](../views/pdf-viewer/src/common/pdf-preview-binding.ts) waits for the actual installed proxy before attaching a preview source. Antigravity stores the host preview root as a `vscode-userdata` URI while local preview descriptors use `file:`. The webview resource permission converts that exact root to a file URI at the resource boundary.

The native [document manager](../views/pdf-viewer/src/overleaf/documents.ts) keeps the displayed document and its loading task alive while a candidate is validated. It waits for the real viewer setter and the wrapper's completion before announcing the new build, retiring the previous task and attaching the candidate's preview metadata. A cancelled delayed callback is rejected before it can assign either the viewer or the link service. The build's checked adaptation handles the transition's `updateCallbackDone` rejection, while the manager retains the candidate's success or failure outcome.

Range and inline replacements share one [temporary height owner](../views/pdf-viewer/src/common/document-height.ts) per viewer element. The hold starts at actual assignment and preserves the preceding page height until `pagesinit`. Abort or setter failure releases its listener and restores the previous style; a superseding hold releases the older owner first. The full PDF.js entry point announces the new build after `load` succeeds and closes a partially installed candidate if its viewer setter fails. Optional scene preparation can fail without preventing a ready document from opening.

The loader gives every uncovered visible page its smallest usable image before refining either half of a spread. At most two requests occupy the pipeline; cancelled requests retain their slots until cleanup finishes. Phone image decoding is serialized and capped at a 512-pixel longest edge. Desktop permits two decodes with an input edge of at most 1536 pixels, retaining its normal 768-pixel preview size. Encoded dimensions, declared byte counts and SHA-256 are checked before browser decoding; the decoded dimensions are checked again before publication. Hidden documents, replacements, incompatible themes or optional-content changes cancel the binding, and late bitmaps are closed.

## Document deliveries and diagnostics

The SVG robot button in every viewer header enables the document effect, which starts on. A page's first substantial visible encounter summons the fleet to carry real rendered fragments into place, including when prefetch has already prepared the page. The controller uses the finished native canvas or an available preview without starting another render for the effect. Thin strips at the viewport edge wait until enough of the page is visible. Offscreen prefetch completions do not start a delivery. A preview and its native replacement share one episode per page and document; revisiting, zooming or toggling a delivered page does not repeat it. The effect leaves text selection and document controls available.

Before pixels arrive, a visible duplex can receive one advance crew for its actual `.spread` membership. The crew enters and coordinates for a finite interval, then parks without scheduling animation frames. A real preparation-state change can trigger one further gesture. Staging reserves no cargo and does not mark a page as delivered. Once pixels arrive, the delivery reuses the staged actors and their positions. Hidden, removed, failed or replaced work releases those reservations; reduced-motion mode shows static status.

### Photo arrivals and refinement

When matching placement metadata is available, couriers select actual image rectangles from the rendered page pixels and deposit them at those images' real locations. Normalized coordinates follow the page's intrinsic rotation and the viewer's additional rotation. A selected rectangle must have at least 32 CSS pixels visible in each dimension. The crop preserves the PDF's clipping and colour treatment. Payload snapshots include the image ID; a large photo can receive a shared crew while keeping that exact rectangle.

Admission places a paper-coloured cover over the selected atlas photograph, and deposit removes it to reveal the page's real pixels. The cover belongs to the page, so it follows scrolling and column translation without another bitmap allocation. Sampled fallback fragments remain unmasked. Wheel, pointer-down, touch-start or key input reveals all covered photographs immediately. Offscreen or removed pages, changed geometry or layout, hiding, disabling the effect, document replacement and disposal also release the covers.

New native pixels or a sharper retained preview can refine a still-active visible payload. Refinement requires the same page element, the same crop and a source with nondecreasing raster dimensions and at least one larger dimension. It preserves the payload and courier identities, displayed position, route and original deadline. Old and new rasters must fit the cargo budget together during replacement.

When spare actor and vehicle-backing capacity permit, [ASAP](../views/pdf-viewer/src/common/robot-cleaner-artwork.ts) wipes across the carried photograph. The coarse raster remains underneath while a directional clip progressively exposes the sharper pixels along the cleaner's pass. One cleaner can run at a time, at most once per payload, for 260 to 600 ms within that delivery's remaining lifetime. If a cleaner cannot be admitted, the sharper raster replaces the coarse one directly. Completion or cancellation releases the coarse bitmap, removes the clip and releases the cleaner's actor and backing storage. Refinement keeps the existing cargo-release deadline.

When the page base is visible, Navines preferentially takes a lower photograph or an ink-bearing lower fragment. It drives along the actual lower edge, raises that same raster on a visible mast, and deposits it at its original rectangle. A larger desktop crew can deliver an upper photograph cooperatively at the same time. Ground work uses the existing actor and cargo budgets; a base outside the viewport is not a forklift route. The payload snapshot reports `ground: true` and the `lift` stage, and cancellation removes both the mast and its single cargo raster.

### Scene limits and scheduling

[The document robot module](../views/pdf-viewer/src/common/pdf-document-robots.ts) varies the vehicles, entry sides, paths and ink-bearing fragment targets. It copies small fragments synchronously and never retains the source page canvas. The shared device policy keeps phones, tablets and narrow desktop panes at four couriers, 512 KiB of cargo and 200 KiB of vehicle backing storage. A desktop reading area with compensated available dimensions of at least 700 × 480 uses six to twelve couriers under a 3 MiB cargo limit and 24 MiB vehicle-backing limit. Its actor count still follows the raw CSS area. Vehicle artwork is redrawn for the actual displayed scale and pixel density, with backing resolution capped at DPR 3.

[Screen sizing](../views/pdf-viewer/src/common/robot-screen-scale.ts) applies a CSS scale of `1 / sqrt(DPR)` to robot bodies, using an effective DPR between 0.5 and 4. This gives a fixed base sprite partial density scaling: its physical pixel size grows with the square root of DPR. Available dimensions divide the CSS viewport dimensions by that factor for desktop eligibility. The existing CSS-derived base size receives the factor once. Device classification and actor, cargo and backing-store limits remain separate from that presentation calculation.

Only visible page IDs wait for capacity; queued work retains no canvas. The first busy offer suspends admission until an active delivery releases capacity. Pages deferred for insufficient visible area retry when container or visual-viewport geometry changes. No retry timer runs at rest. Per-document handled history lives in the renderer and resets only for a replacement document. The pointer-transparent layer follows current page geometry and clips to the visible reading area, keeping the toolbar clear. Finished deliveries stop requesting animation frames; hidden or removed pages, layout invalidation, disabling, document replacement and disposal release active cargo. Reduced-motion mode cancels moving cargo, and a blocked visible offer can resume when that preference is disabled again.

The transit layer lives inside the existing PDF scroll container, so the browser carries couriers, cargo and parked crews with the document between scripted paints. Its zero-size origin uses layout and size containment with visible ink overflow; extreme sprite coordinates therefore cannot enlarge PDF scrollbars. PDF.js page offset parents remain unchanged. Direct work updates and animation callbacks share one finite 30 Hz gate that retains fractional frame time. A parked status or geometry change receives a deferred paint, then returns to zero animation callbacks; reduced-motion status remains immediate. Page/dispatch geometry is read before sprite styles are written.

The lab stays fixed under `document.body`, preserving its control and wheel-event ancestry. Shared styles move the page-content stacking boundary to the inner `.pdfViewer` with `isolation: isolate`, leaving page positioning intact. This lets document couriers pass above the lab while keeping page annotations below the viewer's toolbar and sidebar.

One scene-node initializer supplies absolute origin, hidden initial state, noninteractive styling and decorative accessibility attributes before courier canvases, labels and masts attach. Each becomes visible only after its first position is written. Forklift mast, fork and cargo attachment coordinates belong to the shared procedural artwork definition in [prefetch-robots.ts](../views/pdf-viewer/src/common/prefetch-robots.ts); the document renderer derives display geometry from its documented artwork scale and rounding rule. Route timing and page placement remain renderer policy.

### Transport

Substantial content-bearing fragments can receive a cooperative crew. A shuffled mix chooses solo, paired, three-vehicle, handoff and airlift deliveries. Each payload owns one cargo crop, one route and one clock; helpers share it with formation offsets. Every helper counts against the actor and vehicle-backing limits, and deposit increments the fragment counter once. Partial crew admission rolls back its sprites, cargo and lab reservations before trying ordinary deliveries.

The UAV-UGV sequence draws on the complementary roles in [Arbanas et al., *Decentralized planning and control for UAV-UGV cooperative teams* (2018)](https://doi.org/10.1007/s10514-018-9712-y). The aerial vehicle approaches with the fragment, meets a ground vehicle, pauses for a visible handoff and landing, then rides or accompanies the ground carrier to the deposit. The shared clock makes that order explicit. Crews return individually to their actual lab origins, or leave the viewport when the lab is closed. The snapshot exposes payload IDs, helper IDs, mode, stage, progress and carrier so these transitions can be inspected.

The [airlift route](../views/pdf-viewer/src/common/robot-cargo-routes.ts) keeps the ground robot with its same photograph while an eligible aircraft helps it across a steep leg. The sequence is drive, recruit, rendezvous, lift, carry, set-down and final drive, all on the existing delivery clock. The route supplies positions for both bodies and the one cargo owner; a sling appears during the carried phase. A shallow leg stays on the ground. Admission can reuse an eligible staged ground robot; a new ground member defaults to L-UGV, and its aircraft must meet the scene's relative carrying requirement. Return can use the same route when reaching the ground dock requires air transport.

Ordinary ground launch and return legs have a vertical-to-horizontal slope no greater than 0.25. Ground formations use shallow straight paths, and a handoff's final ground leg is horizontal. The cargo, any coarse refinement underlay, mast and sling follow the same payload coordinates.

### Fleet encounters

Delivery owns the cargo, destination and deadline while locomotion, expressions, conversation and reader interaction can run alongside it. [Traffic spacing](../views/pdf-viewer/src/common/robot-traffic.ts) operates on complete carrying groups, independently of random comic encounters. Each group supplies its center, radius, ground or fixed status, priority and remaining lifetime. One shared displacement moves its bodies, photograph, refinement underlay, mast, sling and cleaner together. Rescue participants also move as one group. Ground groups yield horizontally; a ground robot being carried can follow its aircraft.

Fixed deposits and handoffs keep their anchor positions and retain ordinary weight and identifier priority. They can still yield visually when another group occupies the same space. Fixed anchors that cannot fade, including parked actors, column work and retiring fragments, take priority over movable or fadeable groups. The helper applies the caller's endpoint scale once to the returned displacement, and checks clearance using those displayed positions. Returned displacement stays within 96 CSS pixels; the 0.8-pixel-per-millisecond steering cap applies before that endpoint scale.

If bounded spacing cannot resolve an overlap, the yielding group fades out over 160 ms. It recovers over 240 ms after both its planned and displayed positions clear higher-priority obstacles by an additional 12 CSS pixels. Hidden groups remain solver inputs, preventing repeated disappearance and reappearance at the same obstruction. A payload can preserve this visibility state as it becomes fixed at deposit. The first such fade permanently releases its destination cover so the page's real photograph is visible. Spacing and fading preserve the cargo owner, helper leases, route and original delivery deadline.

[The encounter controller](../views/pdf-viewer/src/common/robot-encounters.ts) can stage one brief traffic, successful-delivery or rescue incident at a time. Advancing, carrying and returning actors can participate; members of the same payload are excluded as traffic pairs. A near miss, bump or reunion changes the participants' gesture within their remaining scene lifetime. An actual or swept contact confirms a bump. Each pair must separate before it can participate again, and cooldowns bound repeated comic reactions. Successful-delivery gestures begin at an actual deposit. Carrying actors keep their handling pose while the accompanying expression or speech runs.

Captions group an exchange with its speaker names. They use measured, wrapped text and the shared [label-placement solver](../views/pdf-viewer/src/common/label-placement.ts) to avoid actor bodies, cargo and other labels while staying inside the visible reading area. Document speech uses an 18 CSS pixel target with a 16-pixel floor, weight 600, dark text and an opaque light background. During traffic fallback, an active speaker remains eligible while its displayed opacity exceeds 0.2, and its caption stays opaque during that interval. An entirely hidden traffic group loses its attached caption and leader lines. Ordinary incident captions allow 1,200 ms plus 45 ms per character for reading, bounded between 1.8 and 4 seconds. A contact response starts that interval at contact.

When a gesture ends, its leader lines disappear and the caption can remain until its reading deadline. That static caption uses one expiry timeout and does not retain actors, cargo or an animation loop. Interruption, removal of all associated visible pages, hiding, document replacement, disabling or disposal clears the affected caption. Encounters share the normal actor budget and scene clock.

### Reader interaction and rescue

[Reader interaction](../views/pdf-viewer/src/common/robot-interaction.ts) observes passive events on the existing document container. Mouse or pen hover gives a brief carrying, preparing, returning or waiting line. A primary unmodified click on the same robot, within 8 CSS pixels of its press and within 800 ms after release, produces a greeting; touch supports a tap. The greeting gesture lasts 850 ms and its caption lasts 2.8 seconds. Hover text lasts 2.2 seconds and requests one visible paint; a parked crew then sleeps until another input or finite gesture. Static hover labels appear only when the placement solver finds room for them. Hit boxes account for native scrolling and column movement since the last paint.

The observer leaves PDF input ownership intact: it does not capture the pointer, prevent default actions, stop propagation or move focus. Links, annotations, editors, form controls, modified clicks, text selection, dragging and multiple pointers exclude or cancel a gesture. Scroll, wheel, context menus, blur and hiding cancel it as well. A carrying robot retains its cargo pose, and click speech takes caption priority.

A rare field malfunction can occur during advance or cargo work. Admission has a 6% chance per viable attempt, with at least 12 seconds between attempts and the existing incident cooldown. The [rescue planner](../views/pdf-viewer/src/common/robot-rescue.ts) considers the complete rigid carrying group, sums its relative scene masses and selects a qualified aircraft, one or two ground tow helpers, or repair in place. VIV and EKO-KOMVOZ occupy the bulky end of that scene hierarchy. A small L-UGV member cannot authorize an airlift of a heavier companion. Members of the casualty group and other multi-member carrying teams are excluded from helper selection.

The finite rescue sequence is sputter, rendezvous, assist and rejoin. Bounded sparks and smoke identify the disabled robot; helpers lift, tow or repair the group, then ease it back to its original route. Additional carried members keep their relative offsets. The scene lasts 900 to 2,400 ms within the shortest participant lifetime, preserving a 40 ms ownership margin. Losing a required actor or entering an incompatible phase ends it. Rescue uses the existing actors, cargo owner and delivery deadline.

### Document replacement

Each viewer engine arms replacement clearing only for its ready candidate. The controller records the document identity, generation and abort signal, then captures current visible pixels at the matching `pagesdestroy` event. Old document, preparation and preview state can be released while the retiring scene continues with bounded copied fragments and numeric viewport-relative geometry.

Desktop can capture up to three fragments per visible page and compact presentation one, within the shared actor, cargo and vehicle-backing limits. Each fragment has a 2.1-second lifetime with at most 200 ms stagger. Actors approach, pick up and carry it out; Navines can lower a bottom photograph to its carrying height. Cargo is released at 76% of that clock, and bodies complete their return by its end. Ground exits are horizontal, with a lab return only when its route is shallow enough.

Useful new deliveries can reclaim retiring fragments, the cleaner and the column-pull actor until they have capacity. Abort, supersession, trusted reader input, a new column transition, disabling, hiding and disposal cancel the corresponding retiring work. Completion removes the identity-matched abort listener. Release removes owned bitmaps, covers, masts, slings and borrowed actors; full scene cleanup also clears traffic, encounters, hit boxes, interaction state, caption expiry and scheduled frames. Parked crews and static captions keep no animation loop running.

### Motion Lab controls

A separate measurement button opens **LARICS Motion Lab**, initially closed. Its fleet dispatch area shows the crew while the document is ready. If the panel is open when a document delivery starts, actors leave from their actual positions in that area and return there afterward. Each dispatched actor is hidden in the panel until it returns. Each crew releases its reservation through the dispatch port that granted it. Closing the panel lets an active courier depart from the viewport instead.

The lab measures its actual fitted canvas, including object-fit and object-position. Body scaling is applied around each actor's center, and a borrowed actor's dispatch scale includes the fitted stage and body compensation so its visible size matches at departure and return. Actor names and notices use a separate measured label pass with the shared 18 CSS pixel target, 16-pixel floor, opaque bubbles, body obstacles and label solver. Those readable labels are outside the small vehicle artwork transform. A static lab admits only labels that fit on its one requested paint and keeps no animation loop running after finite work ends.

[The panel controls](../views/pdf-viewer/src/common/motion-lab-panel.ts) support floating, left-docked and right-docked positions. Docking keeps the displayed width and uses the available viewport height. Returning to **Float** restores the remembered floating position and size. The panel stays inside the visible viewport, including when the browser changes its visual viewport for zoom or an on-screen keyboard; a temporary contraction preserves the remembered floating rectangle for when space returns.

| Action | Pointer control | Keyboard control |
|---|---|---|
| Move | Drag the title; dragging a docked panel makes it float at the grabbed point. | Focus the title and use the arrow keys. |
| Resize | Drag the corner grip while floating, or the inner edge grip while docked. | Focus the grip and use the arrow keys. |
| Dock or float | Select **Dock left**, **Dock right** or **Float**. | Tab to the button and activate it with Enter or Space. |
| Close | Select the close button. | Press Escape while focus is inside the panel, or activate its close button. |

Arrow keys move or resize by 10 CSS pixels, or 40 with Shift. Closing the panel preserves its geometry for the next opening in the same viewer. Pointer capture ends on release, cancellation, lost capture, window blur, close, document hiding or disposal. Panel resize and visual-viewport observers run while it is open and the document is visible. Panel controls schedule work in response to input and observed geometry changes; they do not add a timer or animation loop.

The full PDF.js extension keeps the lab entry in its existing tools menu and the robot button directly in the header. Overleaf's compact viewer moves secondary actions into a More menu below 601 px. Both layouts keep the robot and tools launcher reachable in a 220 px editor pane. Spomenar has enough room for both controls in its phone header.

On mobile, detailed measurements start collapsed behind **Motion and buffer measurements**. The document toggle exposes `aria-pressed`; the lab control exposes `aria-expanded`; docking buttons expose their selected state with `aria-pressed`. Keyboard movement and resizing work when their panel controls have focus. **Copy measurements** copies a JSON snapshot. In the viewer's developer console:

```js
window.pdfPrefetch.snapshot()
window.pdfPrefetch.setRobotsEnabled(false)
window.pdfPrefetch.robotsEnabled
window.pdfPrefetch.toggleDiagnostics()
window.pdfPrefetch.setDiagnosticsEnabled(false)
window.pdfPrefetch.diagnosticsEnabled
```

### Document position while docked

The panel reports changes through `onPanelLayout`, including visibility, dock side, rectangle and the reason for the change. Rectangles use CSS pixels in the same coordinate system as `getBoundingClientRect()`. The callback receives its own rectangle copy, and closing or disposing the panel reports `visible: false`.

[The document-column helper](../views/pdf-viewer/src/common/pdf-document-column.ts) measures visible page containers, including both pages of a spread. A right dock moves the document left to avoid the panel with a 16-pixel gap, limited by the blank margin on the left. A left dock uses the corresponding blank margin on the right. If the pages fill the reading width, they stay in place. Floating or closing the panel returns the document to its original horizontal position.

Pages and registered robot layers receive the same horizontal CSS translation. Page width, zoom and scroll offsets stay unchanged. The helper subtracts its current offset from measured page bounds before calculating the available margin, so repeated measurements cannot accumulate an offset. Robot layers must be disjoint roots, such as the transit container; the renderer accounts for the offset once in its screen coordinates.

Opening, docking and closing can move the column over 400 ms. Dragging, resizing and viewport changes apply their new positions directly. Reduced-motion preference and a hidden document settle the column immediately. The translation stops requesting frames when it reaches its destination, and disposal restores the previous styles and removes its listeners.

An actual finite shift can summon one available Navines to the relevant document edge. It approaches during the first fifth of the transition, keeps its pull attachment on the moving edge, then returns for at most 650 ms. A reachable lab dock is used when the ground route is shallow enough; otherwise it leaves horizontally. The scene shares the actor budget and skips admission when a forklift is already busy. The column can still move when no forklift is available. Retargeting, early cancellation, new delivery work, trusted reader input, hidden or empty pages and teardown release the temporary actor.

### Measurements

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
| Document fleet paint | The measurements panel reports the document renderer's last, mean and maximum paint duration, paint count and active actors. `robots.paintLastMs`, `paintTotalMs`, `paintMaxMs` and `frames` supply these values. These measurements cover document couriers; the optional lab canvas has its own renderer counters. No additional sampling timer is created. |
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

The [prefetch probe](../scripts/pdf-viewer-harness/probes/prefetch.mjs) compares native scheduling with the shared controller for both engines:

```sh
npm run build-pdf-viewer
node scripts/pdf-viewer-harness/probes/prefetch.mjs --headless yes --latency 60 --port 8786
```

See [harness requirements](../scripts/pdf-viewer-harness/README.md#requirements). The probe uses an owned browser and test server, writes `prefetch-results.json` and `prefetch-dashboard.png` under `$PDF_VIEWER_HARNESS_WORK` or `/tmp/pdf-viewer-harness`, then closes its browser and server.

The probe reports visible-content missing time as the fraction of sampled elapsed time when at least one visible page has neither a finished native render nor an attached preview. Samples are weighted by frame duration. Compare runs with the same document identity, cache state, viewport, motion pattern and network conditions; record transferred bytes alongside frame and paint timings.
