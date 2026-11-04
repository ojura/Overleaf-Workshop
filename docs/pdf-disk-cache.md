# Desktop PDF accumulation

Slipstream uses one persistent disk store for the extension's PDF.js viewer and its Overleaf viewer. It keeps ranges that the reader needed and gradually fills missing bytes while the visible document is quiet. Reopening the same build reuses its received bytes. A complete cached build can be saved through the normal Download button without fetching the PDF again.

## One total budget

The machine setting `overleaf-workshop.pdfViewer.pieceCacheSizeMB` is the total file-byte budget for all stored PDF data and manifests. Its default is 4096 MiB (4 GiB). The setting covers both the existing content-addressed piece cache and the new range maps, across every project and build. It is read when the extension host starts. Filesystem bookkeeping and the small writer-lock records are outside the PDF file-byte accounting.

No build reserves its advertised PDF size. Opening a 1,608,644,855-byte PDF creates no PDF data file. Each completed background transfer admits at most 256 KiB plus its small map update. Twenty-five replacement builds still allocate only the bytes actually received.

Admission is serialized and reserves space before writing. Temporary data and replacement manifests count against the same budget. The least recently used unprotected files are removed before a write that would exceed it. Files needed by the build being admitted are protected during that operation. Older build maps can remain after a blob is evicted; an absent blob is a cache miss and is fetched again.

A zero limit disables caching and filling. When this host owns the store, it removes the previous cache's data and maps. A disabled cache does not create a new storage directory. A file larger than the configured budget is still readable, but the background collector does not attempt to accumulate it in full.

The store remains in the extension's existing global-storage `pdf-pieces` directory. Previous SHA-256 piece files are reused and included in the budget.

## When filling runs

The two viewer engines report whether their shown build is idle. The shared viewer controller withdraws the idle signal during input, scrolling, rendering, outstanding PDF fetches, hidden state, and document replacement.

All visible viewers in the extension host must be idle before filling begins. After 1.5 seconds of quiet, the host requests one missing range of at most 256 KiB. It waits 250 milliseconds after that range finishes before starting another. There is one background request for the host, shared by all its panels.

Foreground demand aborts that request synchronously, before the foreground cache lookup or fetch. A cancelled background transfer retains its slot until its promise settles. A server or transport that responds late therefore cannot create a succession of abandoned jobs. Hiding a panel, changing its build, switching engines, and disposing the panel also revoke its fill lease.

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

Existing large piece files are hashed with 256 KiB buffers on their first use in a host. Subsequent range reads seek directly into the verified file. A corrupt file with the right name and length is repaired when verified replacement bytes arrive.

Both loaders can receive cached single ranges, multipart dynamic ranges, or whole content pieces through the existing bridge. Exporting a complete cached PDF writes a temporary destination file with bounded buffers and renames it only after the complete copy succeeds. An incomplete cached build uses the existing download path.

## Multiple extension hosts and restart

One live extension host owns admission to the shared directory. The other hosts can read it. Directory events invalidate their cached directory view; on-demand checks refresh entries and observe a departing writer. A later host can then acquire the writer role and resume filling.

Dead-owner recovery is coordinated by an atomic reaper claim. On Linux the owner record also includes the process start tick, so a recycled PID does not identify the old owner. A deterministic test forces two processes to attempt stale-lock recovery and delays the second unlink until after new ownership; only one writer is allowed to succeed.

An interrupted write leaves a temporary file, which the next writer removes. Invalid metadata is discarded when read. Build and object manifest caches in memory each have a 128-entry bound, and absent object maps are not retained. Rapid build churn therefore cannot grow an unbounded collection of empty manifests.

## Progress and checks

The host sends `cacheProgress` events at most once per second, keyed by webview page and shown build. They report readable cached bytes, PDF size, total stored file bytes, configured budget, whether this build is filling, and whether its byte coverage is complete. Motion Lab displays the current build's report. Progress comes from cache events, not a polling loop.

The focused tests cover actual disk persistence and streaming export, the 1.6 GB advertised size, simultaneous admission, old piece files, corrupt data, validator changes, full-URL identity, moved object prefixes, 25 rapid replacements, multiple viewers, an abort-ignoring transfer, readonly takeover, and two-process stale-lock recovery. They also exercise the existing build-in-use and viewer-switch integration behavior.

### Installed book check, 4 November 2026

The running Antigravity book host acquired the writer role with a live PID and matching process-start identity. Its installed budget was 4096 MiB, with no user or book-workspace override. The active 460-page build advertised 1,608,163,850 bytes.

A metadata-only observation over 52.714 seconds saw stored file bytes grow from 962,302,442 to 988,118,341. Blob data grew by 25,786,704 bytes and manifests by 29,195 bytes. The 116 added blobs included 84 complete 256 KiB blocks and 32 smaller range or piece tails. Explicit build-map coverage grew from 42,579,713 to 68,366,417 bytes; the viewer's cache-progress report also includes reusable content pieces already in the store.

The final store held 1,166 blobs, one build map and 57 complete reusable object maps, using 23.01% of the configured file-byte budget. The largest individual file was 18,859,867 bytes. Every persisted map reference resolved to a present blob, and there were no temporary writes, stale reaper claims or invalid maps. The observation used file metadata and small manifests without instantiating another cache writer.
