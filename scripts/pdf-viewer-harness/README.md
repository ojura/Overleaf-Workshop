# PDF viewer test harness

These scripts test the extension's two PDF viewers in `views/pdf-viewer/`, the pdfjs viewer and
the Overleaf viewer. The headless scripts run a viewer page against a local server that stands
in for Overleaf and VS Code. The Motion Lab scenarios reuse an existing Chromium connection.
The scripts in `ide/` drive the viewers in a test instance of Antigravity on a virtual display.

`safari/` preserves the physical iPhone Safari suite used on 4 and 5 November 2026. Its
[runbook](../../docs/safari-validation.md) covers the retained Inspector connection, source
verification, short delivery and reversal scenarios, real gesture observation, and a configurable
continuous-motion workload with native memory, CPU and network recording. Runtime receipts and
pairing material stay in an explicitly supplied folder outside the checkout.

Run the desktop harness's offline checks with `npm run test:pdf-harness` and the Safari checks
with `npm run test:safari:offline`. `npm run test:pdf-viewer` runs both groups alongside the PDF
source tests. Safari live commands remain inert without `--execute`.

## Spomenar delivery comparison

`delivery-scenes.mjs` measures a cold reader URL in a new regular background tab through the
existing CDP daemon. It records displayed content-canvas pixels, selectable text, native page
render events, frame intervals, reader cache/performance snapshots and actual network bytes.
It disables that tab's HTTP cache and service-worker interception, isolates the `pdfjs.history`
storage key, and closes its capture, preparation, session and target when it finishes. The
shared browser, daemon, saved reading position and other storage keys remain available.

```sh
node scripts/pdf-viewer-harness/delivery-scenes.mjs \
  --url https://cloud.larics.fer.hr/spomenar/ \
  --pages 99,100 --spread odd --zoom 75 \
  --width 1400 --height 1000 --dpr 1 \
  --download-kib 4096 --latency-ms 40 --budget-ms 60000 \
  --json /absolute/path/delivery.json \
  --screenshot /absolute/path/delivery.png
```

These are physical PDF page numbers. In the 460-page LARICS edition, pages 99 and 100 have
printed labels 88 and 89. The default turns off robot animation to measure loading and
rendering. `--robots on` includes the delivery effects; pixel observations then describe the
content canvases beneath any delivery covers. The default fixed duration measures total
transfer and subsequent prefetch as well as first content. `--finish-on-render` ends after
each selected page has completed a native pass. `--finish-on-final` instead waits for final
image quality. Progressive results record the first native page pass containing image data,
complete page image coverage after operator discovery, and final native quality separately.
These are page-wide composition milestones; an image may be outside the visible crop. Each
milestone records `pageFullyVisible`, so whole-spread image comparisons can require the entire
selected canvas to be visible. Visible content pixels and selectable text have separate timings.
The output keeps failed
and partially received transfers, with separate totals for original PDF bytes, reading layout,
reading images, reading manifest, raster previews and application assets. Completed transfer
totals include response headers; `bodyBytes` counts received body data.

The runner uses the same sparse native capture as the Motion Lab scenarios so an emulated
background viewport continues rendering normally. Its result records the actual CSS viewport,
DPR, frame cadence and capture acknowledgments. An optional PNG failure retains the timings
and network result and makes the command fail. An unexpected CSS viewport or DPR also fails.
For a local staging origin with remembered browser zoom, supply the existing helper's exact
`--zoom-helper-target` as described below; the runner changes and restores only its owned tab.
Use the same edition, viewport, network
conditions, robot setting and duration for before/after comparisons.

`--canvases /absolute/path/page-canvases` also saves the selected native page canvases as PNGs
at their actual backing resolution for final-pixel comparison. Each page must have completed
a native pass, and the combined capture is limited to 32 megapixels. A progressive page also
must have painted final quality with every image decoded successfully before capture is accepted.

`--repaint-canvases /absolute/path/repaint-canvases` requests one further native pass through
the existing page queue after the delivery measurement has finished. It saves the resulting
canvases separately and records any new network requests under `repaintNetwork`. This checks
final canvas reproducibility without adding repaint work to the reported delivery timings.
A native error or stalled completion fails the command while retaining the original measurement.

## Motion Lab checks in an existing Chromium session

`zoom-matrix.mjs` runs the recovered browser scenarios through one connection and one supplied
test target. It uses `scripts/lib/devtools.mjs` for an explicitly supplied isolated browser
profile, or `scenario-connection.mjs` for the existing CDP daemon. With the daemon, it prepares
the page for animation, releases its preparation and detaches its work session when the run
ends. The shared daemon keeps running.

The fixture server must already serve the generated book and the built viewer pages. Supply
its origin, the exact target created for testing, the book directory from `make_book.py`, and
a results folder outside the checkout. Before invoking the runner, navigate that target to
`<origin>/page?engine=pdfjs&doc=validation-bootstrap`. The target must have the supplied origin
and `/page` pathname; an `about:blank` target is rejected. The runner does not start a browser
or fixture server.

```sh
node scripts/pdf-viewer-harness/zoom-matrix.mjs \
  --execute --id controls-run --work /tmp/overleaf-browser-checks \
  --ext ./views/pdf-viewer --book /path/to/generated/book \
  --origin 'http://127.0.0.1:<fixture-port>' --target '<owned-page-id>' \
  --daemon-url http://127.0.0.1:7799 --scenario controls
```

Replace the book, origin and target placeholders with the current fixture values. Omit
`--execute` to print the selected cases. The default matrix contains 50 engine/zoom/DPR cells;
the mutually exclusive `--small-only`, `--representative-only` and `--compact-only` options
select matrix cases when rechecking a particular failure. `--engine` selects an engine for
every scenario. `--operations` requires operation snapshots and admission counters for the
matrix, text-strip and entry-strip scenarios; fields that are present are always checked.
The controls, content and DOM scenarios perform their own checks. `--profile-cpu` adds Chromium
call-tree sampling and before/after performance metrics around every selected scenario.

| Scenario | Checks |
|---|---|
| `matrix` | Both engines' zoom, DPR, document scale, actor density and operation decisions |
| `text-strip` | Text strips through the current document renderer |
| `entry-strip` | Delivery at a page's entering edge when its pixels are already cached |
| `controls` | Real shadow hit regions, trusted keys during a haul, coalesced column changes, viewport resize and idle counters |
| `content` | Disclosure persistence, delayed host initialization, intrinsic panel height and resizing with native input |
| `dom` | Browser paint order, scrolling ink, annotation isolation and native response-byte ownership |

`panel-probe.mjs` captures and restores panel state for these scenarios. It waits for the
disclosure event before restoring geometry and releases native input after failures.
Viewport and DPR changes use target-local emulation, leaving the shared browser window's
bounds intact. The caller closes the test target and stops its fixture server after the run.

An existing browser can retain zoom for the local fixture host. The runner requires the actual
CSS viewport and DPR to match each selected case before sampling. Supply
`--zoom-helper-target <existing-state-reader-bridge-target-id>` to normalize an owned test tab
through the already installed browser state reader. Obtain the exact target ID from the current
daemon target inventory; the helper must be its existing `chrome-extension://.../bridge.html`
target. This option does not install an extension or change its permissions.

The helper maps the supplied page target to its exact tab through `chrome.debugger.getTargets`,
saves its original zoom settings and factor, and uses automatic zoom with `scope: "per-tab"`
and factor 1. Browser navigation resets zoom settings, so the runner serializes normalization
after document commitment and awaits matching native metrics at each document initialization.
Helper context loss and zoom API errors fail the run. Cleanup restores the original settings
before detaching;
when the original scope was per-origin it reads the current inherited factor without writing
the saved factor over another user's change. The caller then closes the owned tab.

Daemon screenshots use one full-size native PNG screencast frame. The capture owner drains
and acknowledges a frame timestamped after that phase starts, checks its native viewport,
and restores sparse encoding in `finally`. This avoids concurrent video and still-image
requests on a fully quiet background view. Saved PNG dimensions must match the measured
CSS viewport, including compact high-DPR cases. Direct browser connections use a bounded native
`Page.captureScreenshot` request with an explicit viewport clip and inverse-DPR scale.

Runs through the daemon hold a native 1 × 1 JPEG screencast so Chromium keeps an emulated
background view rendering at its normal cadence. They encode only every 10,000th frame,
acknowledge the frames on the same work session, refresh capture after committed navigation,
and stop capture before detaching. This adds native capture overhead to CPU measurements;
the results record capture dimensions, frame and acknowledgment counts, managed readiness,
and observed native frame timestamps. The runner keeps the daemon's focus registration
throughout navigation and activates only its own newly committed renderer view.

## What the headless harness runs

`server.mjs` plays three parts:

- **Overleaf's download domain.** It serves two builds of a test book from `make_book.py`, with
  single and multipart `Range` responses as nginx sends them, and the image pieces of Overleaf's
  PDF caching under `/project/<project>/user/<user>/content/<contentId>/<hash>`. Each response
  waits `--latency` milliseconds.
- **The extension host.** `POST /bridge` runs the extension's own `PdfFetchBridge` and
  `PieceCache` from `src/core/pdfFetchBridge.ts`, bundled for Node with esbuild. The viewers
  therefore fetch through the same code as in VS Code, and a second build takes its images from
  the piece cache.
- **The webview.** `/page?engine=pdfjs|overleaf` serves `views/pdf-viewer/dist/<engine>.html` and
  replaces its `<!--viewer-config-->` placeholder as the provider does. It adds VS Code's default
  styles for webviews (`vscode-default-styles.css`, copied from Antigravity IDE 1.107.0) and
  `stub.js`, which provides `acquireVsCodeApi` and answers the page's messages as the host does:
  `initState` and `load` at start, `fetch` through the bridge, and `update` and `syncCode` on
  request. `/frame` puts the page in an iframe with the sandbox and allow lists of VS Code's
  webview frame.

`drive.mjs` runs one viewer on the 120-page book and prints what it measured and checked:

- the first page loads in ranges, without a request for the whole file;
- page 60 draws after a jump;
- a new build (B) keeps the old pages on screen until it is ready, shows the same page at the
  same offset, takes every image from the piece cache, and destroys the old document;
- a PDF that the host sends whole (`update`) is shown;
- forward SyncTeX draws and scrolls to the highlight, and a double-click sends `syncPdf`;
- the outline lists the chapters and opens them (Overleaf viewer);
- Ctrl+=, Ctrl+9 and Ctrl+0 zoom the PDF;
- Ctrl+P, Ctrl+Shift+P and Ctrl+S reach VS Code's key listener, Ctrl+= stays with the viewer, and
  Ctrl+S does not download the PDF through the bridge;
- in the pdfjs viewer, find asks before a search downloads the PDF, and the run reports what a
  search downloads in 10 s;
- the zoom and the position reach the host as saved state.

`compare.mjs` runs `drive.mjs` for both viewers, by default in the frame at 40 and 150 ms per
request and as a plain page at 40 ms, and writes a table of the results.

`probes/` holds smaller scripts, each for one behavior:

| script | what it shows |
|---|---|
| `debug-load.mjs` | the viewer's state, the stub's events and the console after loading a book |
| `errors.mjs` | Overleaf viewer: five quick reloads, the banner for a build that is gone, the Recompile button |
| `highlight.mjs` | Overleaf viewer: where a forward SyncTeX highlight lands |
| `pending-highlight.mjs` | Overleaf viewer: a forward search before the first document and during a reload |
| `stall.mjs` | Overleaf viewer: page states after `update`, a reload and a SyncTeX jump |
| `pdfjs-same-build-zoom.mjs` | pdfjs viewer: the build in view stays when the host sends it again; zoom steps of 1.25 |
| `switch-button.mjs` | the button to the other viewer, and the message it sends the host |
| `theme-colors.mjs` | the pixel colors of each color theme on the page of `theme_book.py` |
| `toolbar-shots.mjs` | the toolbar at requested widths from 1400 to 220 px, reporting measured pane width and overflow, with the pdfjs viewer's find bar and tools menu |
| `live.mjs` | a real build from a saved compile response (see below) |

What the scripts know about the two viewer pages is in `viewers.mjs`, for the headless scripts and
the IDE scripts alike: where a page keeps its viewer object, when a page counts as drawn, the ids
of the buttons and toolbars, the SyncTeX highlight, and the functions that run in a page to show a
page, to switch the color theme and wait until pdf.js reports the page drawn again, and to read a
page's pixels with those that count as an image's.

## Requirements

- Node 22.4 or later, for the global `fetch` and `WebSocket`.
- `google-chrome`; the environment variable `CHROME` can name another Chrome or Chromium binary.
- `python3`, which writes the test books.
- The checkout's dev dependencies (`npm install`), for esbuild.
- The viewer pages: `npm run build-pdf-viewer` writes `views/pdf-viewer/dist/`, and
  `npm run download-pdfjs` writes pdf.js's release, the version that package.json pins as
  `pdfjs-dist`, to `views/pdf-viewer/vendor/pdfjs-<version>/` with the patch applied.

## Running

From the checkout:

```sh
node scripts/pdf-viewer-harness/drive.mjs --engine pdfjs --frame
node scripts/pdf-viewer-harness/compare.mjs
node scripts/pdf-viewer-harness/probes/theme-colors.mjs --engine overleaf
```

The headless scripts take `--ext DIR` for another `views/pdf-viewer` folder, such as another checkout's,
and `--port N` for the server, which otherwise takes a port that is free when the script starts,
so that scripts can run at the same time, also two runs of one script. The usage of each script is
in its first comment.

Each headless script starts its own server and Chrome, with a new Chrome profile and an empty piece cache,
and stops both when it ends, also after Ctrl+C or a timeout. When a SIGKILL ends the script, the
kernel kills the server and Chrome, which run under `setpriv --pdeathsig KILL`; their profile and
piece cache then stay in the work folder. Chrome picks a free DevTools port
itself and writes it into its profile, and the script connects through what Chrome wrote there
(`scripts/lib/devtools.mjs`), so it drives only the Chrome it started. Chrome's own messages go to
the script's stderr, after `chrome: `. Generated files go to the work
folder, `$PDF_VIEWER_HARNESS_WORK` or by default `pdf-viewer-harness` in the system's temporary
folder:

- `book/` (120 pages, two builds of 126 MB each) and `book-theme/` (one page), written on first use,
  each with `book.json`, which its writer writes last: the number of pages, a text that every page
  holds, and the outline's chapters (`make_book.py`) or the boxes of the things on the page
  (`theme_book.py`), which the scripts check against;
- `shots/`, the screenshots, and `compare/`, the results of `compare.mjs`;
- the Chrome profiles and piece caches of the scripts that are running.

Delete a work folder after every script using it has stopped.

### A real build

`probes/live.mjs` loads the `output.pdf` of a real compile through the extension's bridge from
Overleaf's download domain. The download domain serves a build by its URL, so this needs a saved
compile response but not a login:

```sh
node scripts/pdf-viewer-harness/probes/live.mjs --response compile-response.json --project <project id>
```

The compile response is the JSON that Overleaf's compile endpoint returns. Save it from a compile
of a project meant for tests, and run the probe soon after: Overleaf removes old builds, after
which the download fails. Compile responses name a project's builds, so keep them out of the
repository.

## The IDE scripts

The scripts in `ide/` drive the viewers in Antigravity itself, in the window of an instance that
`scripts/hidden-ide.sh` started on a virtual display, and only there. They read the instance's
`instance.json` in the folder that `--instance` names, or else in `$HIDDEN_IDE_HOME` (they require
one of the two), connect to the DevTools endpoint that the instance's start recorded there, and
go on only when the instance's IDE answers as itself (`scripts/lib/test-instance.mjs`). The
settings they change are the instance's own (`profile/User/settings.json`), and they restore them
when they end.

An instance opens either a folder of PDFs, without a login (`--folder`), or the local replica of an
Overleaf project meant for tests (`--project`); the viewer loads that project's `output.pdf` in ranges:

```sh
export HIDDEN_IDE_HOME=<a folder of your own> HIDDEN_IDE_BINARY=<the Antigravity binary>
scripts/hidden-ide.sh start --folder /tmp/pdf-viewer-harness/book-theme
node scripts/pdf-viewer-harness/ide/drive-local-pdf.mjs --pdf /tmp/pdf-viewer-harness/book-theme/build-a.pdf --pages 1 --theme-book
scripts/hidden-ide.sh stop
```

| script | what it does |
|---|---|
| `drive-local-pdf.mjs` | opens a local PDF with Quick Open; drawing, pdf.js's worker, zoom keys, Ctrl+P, find, and the dark theme on the page of `theme_book.py` |
| `drive-build.mjs` | reopens `output.pdf`; loading in ranges, jumps, and with `--theme-page N` the dark theme on page N |
| `drive-switch.mjs` | on the open `output.pdf`: the viewer setting and each viewer's switch button |
| `timeline.mjs` | reopens `output.pdf` and records the host's messages, pdf.js's events and the page's state |
| `toolbar-shots.mjs` | screenshots of both toolbars at requested window widths, reporting the measured pane width and elements past its edge |
| `find-image-page.mjs` | lists pages with images, for the theme checks |
| `probe-page-colors.mjs` | page N in the default and the dark theme: changed colored pixels and drawing operators |
| `snap-page.mjs` | page N in the default and the dark theme as PNGs, for a look by eye |

`drive-local-pdf.mjs` and `toolbar-shots.mjs` associate `*.pdf` with the extension's viewer while
they run, because the viewer's own selector takes only PDFs of the extension's file system. The
scripts on `output.pdf` need it open in the instance, for example through Overleaf Workshop's View
PDF command. In a folder instance they also run on a local file named `output.pdf` while
`workbench.editorAssociations` maps `*.pdf` to `overleaf-workshop.pdfViewer`; the viewer then reads
the whole file, so their checks of loading in ranges fail.
