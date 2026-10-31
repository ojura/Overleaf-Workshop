# PDF viewer test harness

These scripts test the extension's two PDF viewers in `views/pdf-viewer/`, the pdfjs viewer and
the Overleaf viewer. The scripts in this folder and in `probes/` run a viewer page in headless
Chrome, against a local server that stands in for Overleaf and for VS Code. The scripts in `ide/`
drive the viewers in a test instance of Antigravity on a virtual display.

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
| `toolbar-shots.mjs` | the toolbar at pane widths from 1400 to 220 px, with the pdfjs viewer's find bar and tools menu, and what reaches past the edge |
| `live.mjs` | a real build from a saved compile response (see below) |

## Requirements

- Node 22.4 or later, for the global `fetch` and `WebSocket`.
- `google-chrome`; the environment variable `CHROME` can name another Chrome or Chromium binary.
- `python3`, which writes the test books.
- The checkout's dev dependencies (`npm install`), for esbuild.
- The viewer pages: `npm run build-pdf-viewer` writes `views/pdf-viewer/dist/`, and
  `npm run download-pdfjs` writes `views/pdf-viewer/vendor/pdfjs-5.1.91/` with the patch applied.

## Running

From the checkout:

```sh
node scripts/pdf-viewer-harness/drive.mjs --engine pdfjs --frame
node scripts/pdf-viewer-harness/compare.mjs
node scripts/pdf-viewer-harness/probes/theme-colors.mjs --engine overleaf
```

Every script takes `--ext DIR` for another `views/pdf-viewer` folder, such as another checkout's,
and `--port N` for the server; Chrome's debugging port follows from it. Scripts on different ports
can run at the same time. The usage of each script is in its first comment.

Each script starts its own server and Chrome, with a new Chrome profile and an empty piece cache,
and stops both when it ends, also after Ctrl+C or a timeout. Generated files go to the work
folder, `$PDF_VIEWER_HARNESS_WORK` or by default `pdf-viewer-harness` in the system's temporary
folder:

- `book/` (120 pages, two builds of 126 MB each) and `book-theme/` (one page), written on first use;
- `shots/`, the screenshots, and `compare/`, the results of `compare.mjs`;
- the Chrome profiles and piece caches of the scripts that are running.

The work folder can be deleted at any time.

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
`instance.json` in `$HIDDEN_IDE_HOME` (default `/tmp/hidden-ide-<uid>`), or in the folder that
`--instance` names, and check that the instance's main process holds its debugging port before
they connect. The settings they change are the instance's own (`profile/User/settings.json`), and
they restore them when they end.

An instance opens either a folder of PDFs, without a login (`--folder`), or the local replica of an
Overleaf project meant for tests (`--project`), whose `output.pdf` the viewer loads in ranges:

```sh
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
| `toolbar-shots.mjs` | screenshots of both toolbars at window widths from 1440 px down to a 220 px pane, and what reaches past the edge |
| `find-image-page.mjs` | lists pages with images, for the theme checks |
| `probe-page-colors.mjs` | page N in the default and the dark theme: changed colored pixels and drawing operators |
| `snap-page.mjs` | page N in the default and the dark theme as PNGs, for a look by eye |

`drive-local-pdf.mjs` and `toolbar-shots.mjs` associate `*.pdf` with the extension's viewer while
they run, because the viewer's own selector takes only PDFs of the extension's file system. The
scripts on `output.pdf` need it open in the instance, for example through Overleaf Workshop's View
PDF command. In a folder instance they also run on a local file named `output.pdf` while
`workbench.editorAssociations` maps `*.pdf` to `overleaf-workshop.pdfViewer`; the viewer then reads
the whole file, so their checks of loading in ranges fail.
