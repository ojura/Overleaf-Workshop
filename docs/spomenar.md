# Spomenar website

The published reader at https://cloud.larics.fer.hr/spomenar/ uses the full pinned PDF.js viewer with the extension's shared scrolling predictor, page previews, rendering scheduler, diagnostics, and robot fleet. Its entry is `views/pdf-viewer/src/standalone/main.ts`. PDF.js provides the toolbar, search, outline, links, zoom, page modes, and view history.

## Reading

The first desktop visit opens at 150%. Phones and tablets fit the page to the reading column. PDF.js remembers the page, zoom, and scroll position by the document's fingerprint. A link containing a PDF-open hash, such as `#page=60&zoom=125,0,320`, opens that view. The header's share button uses PDF.js's current page, zoom, and coordinates; it opens the system share sheet when available and otherwise offers a copyable link.

The SVG robot button in the header controls deliveries on the document and starts on. On a page's first substantial visible encounter, the robots carry fragments of its rendered pixels into place, including pages already prepared by prefetch. A thin page strip at the edge waits for a useful view, and later visits or zoom changes do not repeat that page's performance. Large desktop reading areas use six to twelve larger couriers; phones, tablets and narrow panes keep a compact four-courier limit. Both presentations release their cargo and stop animation when the delivery ends.

Larger fragments sometimes travel with a pair or trio sharing one payload. Aerial-ground teams can rendezvous, hand the fragment to a ground carrier and finish the delivery together. These episodes share the same actor and memory limits as solo couriers, with a single copied fragment for the whole team.

A separate measurement button opens the optional LARICS Motion Lab. Its fleet can be summoned while pages are ready, and it becomes the departure point for document deliveries while open. The lab starts closed. Search and outline remain in the PDF.js toolbar and sidebar. Download sends the same-origin PDF URL directly to the browser's download manager, so it does not assemble the full book in a JavaScript buffer first.

The header and viewer fill the available viewport. PDF.js's page container owns scrolling, while the header keeps touch targets at least 44 pixels wide and high. The viewport permits browser zoom and accounts for device safe areas.

## Build and configure

From the repository root:

```sh
npm run build-spomenar
```

This writes `dist/spomenar/`. To choose another output directory:

```sh
node scripts/build-spomenar.mjs --out /tmp/spomenar-preview
```

The export contains `index.html`, `config.json`, the website bundle and stylesheet, the pinned PDF.js release under `assets/pdfjs/`, and a favicon. Every asset URL is relative, so the same export works below `/spomenar/` or another directory. The build derives the viewer body from the pinned upstream `web/viewer.html`, preserving its controls and accessibility markup. The book is served separately.

The build packages `views/pdf-viewer/src/standalone/config.json` as the seed for a standalone export. Production serves `/spomenar/config.json` and `/spomenar/status.json` from the publication service's root-owned catalog. Deploying viewer assets preserves that catalog and omits the build's seed configuration.

The published configuration identifies the immutable PDF and retains the reader's title, download filename and source link:

```json
{
  "pdfUrl": "/spomenar-versions/<source-sha256>/book.pdf",
  "title": "30 godina LARICS-a",
  "filename": "Kako je LARICS postao 30-godišnjak.pdf",
  "sourceUrl": "/nextcloud/s/spomenar-2026",
  "publicationGeneration": 1
}
```

`<source-sha256>` represents the PDF's full SHA-256 digest. `pdfUrl` must resolve to the website's HTTP origin. `title` names the book in the header and tab; `filename` names its download. The optional `sourceUrl` makes the book heading a link to the original publication. The public share is https://cloud.larics.fer.hr/nextcloud/s/spomenar-2026.

The catalog also binds the matching preview manifest at `/spomenar/previews/<source-sha256>/manifest.json` to the PDF's digest, byte length and observed HTTP validator. A publication generation identifies a committed configuration; a separate manifest revision lets a fuller atlas replace an earlier checkpoint while the same PDF stays open. See [automatic publication](spomenar-watch.md#publication-files-and-public-access) for the complete configuration and public progress fields. Configuration and status remain separate from the replaceable viewer files.

## PDF endpoint

Production serves each edition directly at `/spomenar-versions/<source-sha256>/book.pdf`. Static nginx delivery provides HEAD, ordinary byte ranges and If-Range against that immutable file. The PDF endpoint must:

- Return HTTP 206 with a valid `Content-Range: bytes start-end/total`.
- Serve uncompressed byte ranges. A compressed transfer changes the byte offsets PDF.js requests.
- Keep the total length consistent across one reading session.
- Supply a strong ETag or Last-Modified value so later requests can carry `If-Range`.
- Keep entry, configuration, and application assets revalidated together during deployment.

The publication service checks the stable Nextcloud share, waits for a changed source to settle, and snapshots its local PDF into an immutable edition. Nextcloud remains the authority for source discovery and public access. Renames and moves follow the shared node; reader byte requests use the published static file. A new edition and its matching preview identity become current through one atomic catalog update. Revocation removes the catalog's public link at the next service poll, withdrawing subsequent PDF, preview, configuration and status requests together.

The service prepares priority-page previews first, then completes the remaining atlas. A fuller atlas updates its manifest revision without replacing the PDF. Retained editions let an existing reader finish its current load while publication advances; their count and storage limits can eventually retire an old version, at which point that reader needs to reload the current edition. The [publication guide](spomenar-watch.md) defines recovery, retention and withdrawal behavior.

`http-range.ts` fetches the first 128 KiB, then only the ranges requested by PDF.js. It validates the response headers before reading the body and enforces the declared byte count while streaming. A full-file HTTP 200 response is cancelled before buffering. A changed length or validator ends the current load and shows a retry action. Retry uses the viewer's saved position.

PDF.js automatic streaming and automatic whole-document fetching are disabled. The shared predictor can still request nearby pages and their resources. Received bytes use the shared sparse worker cache, with a 32 MiB idle target on phones and tablets and 128 MiB on desktop. Old chunks can be evicted and fetched again. Fetch start, received bytes, elapsed time, and completion feed the same `PdfPerformance` collector used by the extension, so network backpressure and the robot delivery activity reflect actual requests.

Image decoding follows the displayed page and zoom on every device, with one image job on mobile and two on desktop. Plain RGB JPEGs can decode directly into resized native bitmaps. A later zoom requests more detail, while printing uses original resolution. Finished native canvases and distant retained previews release their decoded image tiers without starting another idle decode. Desktop keeps its larger native-canvas cache. The same shared policy and patched worker are used by both extension engines.

The website's scripts, PDF.js worker, fonts, locales, and WASM files come from the same origin. It uses external scripts, system fonts, and `isEvalSupported: false`. PDF.js needs WASM execution, worker/blob sources, data/blob images and fonts, and dynamically applied styles. The deployment's CSP must allow those resources.

See [Spomenar deployment](spomenar-deployment.md) for the viewer deployment command and [automatic publication](spomenar-watch.md#installation-and-initial-adoption) for catalog bootstrap and service installation.

## LARICS identity

The header uses the official white negative LARICS wordmark, served locally as `assets/larics-logo.svg`. The favicon uses the official orange positive wordmark. Both SVG files are copied unchanged from the [LARICS press materials](https://larics.fer.hr/larics/press#%23!p_rep_124351!_-151550), retrieved on 4 November 2026:

- [Negative SVG](https://larics.fer.hr/_download/repository/negative_SVG.svg)
- [Positive color SVG](https://larics.fer.hr/_download/repository/positive_color_SVG.svg)
- [LARICS book of standards](https://larics.fer.hr/_download/repository/LARICS_book_of_standards.pdf)

The supplied standards document shows the negative mark on dark backgrounds and specifies the orange as RGB 245, 130, 32. The header retains the supplied proportions and places the wordmark above the book title so the title and 44 px controls fit a phone. The press repository and standards document do not state a redistribution license. These files remain LARICS branding; the application's source-code license does not grant rights to the marks.

## Verification

The focused suite covers exact ranges, cancelling whole-file responses, invalid headers and body lengths, changed documents, cancellation accounting, validators, same-origin configuration, shared links, and the exported viewer controls and relative assets.

```sh
node node_modules/typescript/bin/tsc -p ./
node node_modules/mocha/bin/mocha.js out/test/pdfViewerStandalone.test.js
node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module ES2022 --moduleResolution bundler --lib ES2022,DOM,DOM.Iterable --skipLibCheck views/pdf-viewer/src/standalone/main.ts
```

See [PDF prefetching](pdf-prefetch.md) for the shared scheduler, measurements, and cache policies.
