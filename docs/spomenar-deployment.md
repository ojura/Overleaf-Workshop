# Standalone Spomenar deployment

The public reader is served at [cloud.larics.fer.hr/spomenar/](https://cloud.larics.fer.hr/spomenar/).
Its PDF endpoint is the same origin, at `/spomenar/book.pdf`. The source is the existing
[Nextcloud public share](https://cloud.larics.fer.hr/nextcloud/s/spomenar-2026).

## Build and deploy

Run these commands from the repository:

```sh
npm run build-spomenar
node scripts/deploy-spomenar.mjs --check
node scripts/deploy-spomenar.mjs --deploy
```

The build produces `dist/spomenar/`. A different existing build directory can be supplied with
`--build-dir DIRECTORY`. The deployment script does not compile the book or run the extension.

The machine-specific settings are grouped in `target` at the beginning of
`scripts/deploy-spomenar.mjs`. It uses the existing SSH alias and the sudo-listener root channel
on Steffy. That listener must already be running, with its key readable only by the invoking
user. The script does not read the key into logs or change its permissions.

`--check` is the default. It requests metadata from the named public share's native Nextcloud
DAV endpoint, then verifies a conditional range of at most sixteen PDF bytes. It checks status,
encoding, length, content range and the observed validator before reading that small body.
It also runs `nginx -t` against temporary copies of the proposed configuration. It does not
change live nginx files, publish assets, or reload the server. This check can run before the
viewer build is ready.

`--deploy` uploads only the small static build. It installs one location snippet into the
existing TLS server, validates the live configuration with `nginx -t`, publishes the assets,
and gracefully reloads nginx. Existing assets and configuration are retained during this
operation and restored if publication fails. Successful deployments remove their old assets
and local and remote staging files.

## PDF delivery and updates

Every request to `/spomenar/book.pdf` is internally routed to
`/nextcloud/public.php/dav/files/spomenar-2026`. Nextcloud resolves the stable share token to
its current node and applies its own access checks on each request. Renaming or moving the
shared file therefore requires no viewer deployment. Replacing its contents changes the
representation validator; revoking the share makes the PDF unavailable through Spomenar too.
The installer retains no filesystem filename, inode, database credential or resolved private
storage path.

The exact book location accepts GET and HEAD, strips caller query arguments, and forwards
Range and If-Range through the existing Nextcloud PHP handler. A scoped FastCGI `REQUEST_URI`
adapter supplies the canonical DAV URI after the internal rewrite. All other requests retain
their original encoded URI and arguments. The native handler streams the existing PDF and
supplies its content length, strong ETag, Last-Modified and range semantics. No PDF copy or
additional service is created. The `/s/TOKEN/download` URL is intentionally not used here:
it redirects, whereas the viewer requires a direct ranged response.

Preview manifests remain bound to a particular SHA-256, byte length and validator. After a
content replacement, the reader uses normal PDF rendering until a matching atlas is generated
and its configuration is published. A filename-only change leaves the existing atlas usable.

To remove the viewer, remove its snippet include and the adjacent Spomenar `REQUEST_URI`
adapter from the TLS server, validate nginx, and reload it. Leave the other locations unchanged.

The bare `/spomenar` URL redirects to `/spomenar/`. Page links use a hash, so reloading or sharing
a page link still requests the same entry document from nginx.

## Browser assets and headers

Entry HTML, configuration, styles, modules, and runtime assets use `Cache-Control: no-cache` so
the browser revalidates them across deployments. PDF headers come from the native share handler.

The site's CSP permits only same-origin connections and scripts. It also permits PDF.js worker
blobs, data/blob images and fonts, inline styles used by the viewer and robot panel, and WebAssembly
compilation. JavaScript eval remains disabled in the viewer. CMaps, standard fonts, image decoders,
and the pinned PDF.js worker are included under the site's relative asset directory.

After publication, verify a small beginning and end range against `/spomenar/book.pdf`: each
must return `206`, the requested byte count, and a `Content-Range` total matching the public PDF.
The browser pass should use the served site to check workers, CSP, page links, touch controls,
and visible page readiness.

The focused deployment suite is `python3 scripts/test_spomenar_install.py`. Its isolated
nginx/FastCGI fixture exercises rename, replacement, revocation, encoded unrelated requests,
HEAD, conditional ranges, query stripping and method restrictions without reloading a live
server. The preflight tests also reject redirects, encoded or inconsistent ranges and verify
that a full-file response is closed before any body read. Run on a machine with nginx to include
the three real-routing cases.
