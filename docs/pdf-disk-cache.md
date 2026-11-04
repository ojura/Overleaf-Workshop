# Desktop PDF accumulation

Slipstream uses one persistent disk store for the extension's PDF.js viewer and its Overleaf viewer. It keeps ranges that the reader needed and gradually fills missing bytes while the visible document is quiet. Reopening the same build reuses its received bytes. A complete cached build can be saved through the normal Download button without fetching the PDF again.

## One total budget

The machine setting `overleaf-workshop.pdfViewer.pieceCacheSizeMB` is the total file-byte budget for all stored PDF data and manifests. Its default is 4096 MiB (4 GiB). The setting covers both the existing content-addressed piece cache and the new range maps, across every project and build. It is read when the extension host starts. Filesystem bookkeeping and the small lease records are outside the PDF file-byte accounting.

No build reserves its advertised PDF size. Opening a 1,608,644,855-byte PDF creates no PDF data file. Each completed background transfer admits at most 256 KiB plus its small map update. Twenty-five replacement builds still allocate only the bytes actually received.

Admission is serialized across extension hosts and reserves space before writing. Every transaction refreshes disk accounting and manifests after acquiring its short writer lease, so two windows cannot spend the same available bytes or overwrite each other's range-map updates. Temporary data and replacement manifests count against the same budget. The least recently used unprotected files are removed before a write that would exceed it. Files needed by the build being admitted are protected during that operation. Older build maps can remain after a blob is evicted; an absent blob is a cache miss and is fetched again.

A zero limit disables cache reuse and filling. Its next admission attempt removes previous PDF data and maps under a short writer lease, then declines the incoming bytes. Ordinary reads and progress snapshots remain read-only. A disabled cache does not create a new storage directory. A file larger than the configured budget is still readable, but the background collector does not attempt to accumulate it in full.

Each host applies its startup budget to the entire directory before admitting data. Reload all extension windows after changing this setting so they use the same value. If windows temporarily have different startup values, each admission enforces the value of the host performing it.

The store remains in the extension's existing global-storage `pdf-pieces` directory. Previous SHA-256 piece files are reused and included in the budget.

## When filling runs

The two viewer engines report whether their shown build is idle. The shared viewer controller withdraws the idle signal during input, scrolling, rendering, outstanding PDF fetches, hidden state, and document replacement.

All visible viewers in the extension host must be idle before filling begins. After 1.5 seconds of quiet, the host requests one missing range of at most 256 KiB. It waits 250 milliseconds after that range finishes before starting another. A separate `.background` lease permits only one background transfer across hosts sharing this store. A host checks for missing bytes before requesting that lease and checks again after acquiring it, so an already-completed gap is not downloaded twice.

Foreground demand in a host aborts that host's background request synchronously, before the foreground cache lookup or fetch. A cancelled background transfer retains its global slot until its promise settles. A server or transport that responds late therefore cannot create a succession of abandoned jobs. Hiding a panel, changing its build, switching engines, and disposing the panel also revoke its fill lease. Network transfers hold no disk-admission mutex, so another window can still admit foreground bytes while a background response is pending.

The engines keep the old rendered document visible while loading a replacement. Its existing foreground requests remain valid until the loader aborts them or its page is disposed. Each request retains the output identity it started with. A build change immediately cancels the background collector for the old build.

A failed or invalid background response pauses that lease. A later idle transition or a new build can resume it. The cache never starts a compile.

## Byte identity and validation

A build key includes the normalized complete output URL, project, editor, build ID, exact size, and the compile response's content-range metadata. Query order is normalized, while query values remain part of the identity. The existing cached-build fallback URL is recognized explicitly.

A range enters a build map only when all of these agree:

- HTTP status is 206.
- `Content-Range` exactly matches the requested start, exclusive end, and total build size.
- The body has exactly the requested length and has identity encoding.
- The response supplies a strong ETag or a valid Last-Modified value.

Later background requests send that validator as `If-Range`. A changed validator clears the previous range map before any bytes from the new representation are admitted. A server that ignores Range and answers 200 is cancelled before its book-sized body is buffered.

Overleaf's content pieces are verified against their SHA-256. Its metadata uses exclusive range ends and stores the object-ID prefix separately from the hashed bytes. The store preserves that distinction. Once small received ranges cover a whole known piece, it streams the piece through SHA-256 and publishes a reusable map of those blobs. A later build can reuse that piece at another offset and with a different object-ID prefix.

Existing large piece files are hashed with 256 KiB buffers on their first use in a host. Subsequent range reads seek directly into the verified file. A read that detects corruption excludes those bytes from usable coverage without acquiring the writer lease. A rejected aggregate object map is also removed from the in-memory map cache and cannot supply ranges. The next mutation revalidates that suspicion under fresh ownership, including the aggregate content hash for an object map, then repairs or removes the bad file. Another host's intervening verified replacement is preserved. Corrupt physical files still count against disk usage until that cleanup runs.

Both loaders can receive cached single ranges, multipart dynamic ranges, or whole content pieces through the existing bridge. Exporting a complete cached PDF writes a temporary destination file with bounded buffers and renames it only after the complete copy succeeds. An incomplete cached build uses the existing download path.

## Multiple extension hosts and restart

The `.writer` lease belongs to one admission transaction, not to an extension host's lifetime. A completed small document therefore cannot keep a restarted book from accumulating. Reads, progress snapshots and complete-file exports never acquire that lease. A mutation waiting for another host also stays outside its own host's read queue, allowing cached pages to remain readable during contention. A canceled queued admission drops its retained payload and settles immediately even while an earlier admission remains blocked. Both content-piece and range requests pass their abort signal into this queue. The owner releases the lease in `finally` after publication or cancellation.

Filesystem events wake pending lease requests on ordinary release. One one-second watchdog per cache instance exists only while an actual operation is waiting; it detects an owner that dies without unlinking its record. It stops when no waiter remains, including acquisition, abort and disposal. Idle readers and completed documents perform no ownership polling. Data publication and eviction invalidate cached directory metadata; LRU timestamp updates and lock-candidate traffic do not make every cache hit rescan the store.

Dead-owner recovery is coordinated by an atomic reaper claim. On Linux the owner record also includes the process start tick, so a recycled PID does not identify the old owner. A deterministic test makes two processes observe the same stale record, holds the first new transaction open, and verifies that delayed stale recovery cannot remove its lease or admit the other process concurrently.

An interrupted data write leaves a temporary file, which the next mutation removes. Lock candidates use a separate namespace; cleanup preserves live contenders and removes stale candidates only after checking owner identity. Invalid metadata is excluded on read and revalidated before later cleanup. Build and object manifest caches in memory each have a 128-entry bound, and absent object maps are not retained. Rapid build churn therefore cannot grow an unbounded collection of empty manifests. Reload all extension hosts when updating from the earlier lifetime-writer implementation, so an older live host does not retain its old lease indefinitely.

## Progress and checks

The host sends `cacheProgress` events at most once per second, keyed by webview page and shown build. They report readable cached bytes, PDF size, total stored file bytes, configured budget, whether this build is filling, and whether its byte coverage is complete. Motion Lab displays the current build's report. Progress comes from cache events, not a polling loop.

The focused tests cover actual disk persistence and streaming export, the 1.6 GB advertised size, cross-host budget reservation and manifest merging, old piece files, read-detected corruption and repair, validator changes, full-URL identity, moved object prefixes, 25 rapid replacements, multiple viewers, and an abort-ignoring transfer. They reproduce a restarted book beside a still-live completed tiny document, canceled foreground admission, available reads during lock contention, owner death after waiter registration, idle no-lock behavior, and two-process stale recovery.

### Installed book check, 4 November 2026

Before the operation-scoped lease change, the running Antigravity book host acquired the lifetime writer role with a live PID and matching process-start identity. Its installed budget was 4096 MiB, with no user or book-workspace override. The active 460-page build advertised 1,608,163,850 bytes.

A metadata-only observation over 52.714 seconds saw stored file bytes grow from 962,302,442 to 988,118,341. Blob data grew by 25,786,704 bytes and manifests by 29,195 bytes. The 116 added blobs included 84 complete 256 KiB blocks; the other 32 blobs totaled 3,766,608 bytes. Explicit build-map coverage grew from 42,579,713 to 68,366,417 bytes; the viewer's cache-progress report also includes reusable content pieces already in the store.

The final store held 1,166 blobs, one build map and 57 complete reusable object maps, using 23.01% of the configured file-byte budget. The largest individual file was 18,859,867 bytes. Every persisted map reference resolved to a present blob, and there were no temporary writes, stale reaper claims or invalid maps. The observation used file metadata and small manifests without instantiating another cache writer.

A later two-window reload reproduced lifetime-owner starvation: the restarted book host was active, but the still-live TurtleSim host retained `.writer`. At that observation the store contained 1,807,208,242 accounted bytes in 4,713 data/metadata files, with no temporary writes. This is the live failure that the operation-scoped lease regressions address.
