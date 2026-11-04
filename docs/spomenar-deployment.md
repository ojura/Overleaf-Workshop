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

`--check` is the default. It resolves only the named public share with a read-only database
query, verifies that nginx's worker can read the unencrypted local PDF, and runs `nginx -t`
against temporary copies of the proposed configuration. It does not change live nginx files,
publish assets, or reload the server. This check can run before the viewer build is ready.

`--deploy` uploads only the small static build. It installs one location snippet into the
existing TLS server, validates the live configuration with `nginx -t`, publishes the assets,
and gracefully reloads nginx. Existing assets and configuration are retained during this
operation and restored if publication fails. Successful deployments remove their old assets
and local and remote staging files.

## PDF delivery and updates

The deployment resolves the public share's current file through Nextcloud's share and file
tables. The result must be an active, readable public link without a password, backed by an
unencrypted local PDF. The database credentials stay inside the server-side PHP process.

Nginx serves that exact existing file through an `alias`. It does not expose the containing
Nextcloud directory, send PDF bytes through PHP, or create another copy of the 1.61 GB book.
Native nginx byte ranges, content length, ETag, and Last-Modified support the viewer's range
transport and document-change checks. Gzip and the open-file cache are disabled for this
endpoint so its byte offsets and current file identity remain accurate.

Replacing the book at the same filesystem path makes the new file available through the alias.
If the shared file moves, deploy again to resolve its new path. The published site is a separate
public entry point: removing the Nextcloud share alone does not remove an already installed
nginx alias. To unpublish the site, remove its snippet include from the TLS server, validate
nginx, and reload it. Leave the other locations in that server unchanged.

The bare `/spomenar` URL redirects to `/spomenar/`. Page links use a hash, so reloading or sharing
a page link still requests the same entry document from nginx.

## Browser assets and headers

Entry HTML, configuration, styles, modules, and runtime assets use `Cache-Control: no-cache` so
the browser revalidates them across deployments. The PDF uses public revalidation caching.

The site's CSP permits only same-origin connections and scripts. It also permits PDF.js worker
blobs, data/blob images and fonts, inline styles used by the viewer and robot panel, and WebAssembly
compilation. JavaScript eval remains disabled in the viewer. CMaps, standard fonts, image decoders,
and the pinned PDF.js worker are included under the site's relative asset directory.

After publication, verify a small beginning and end range against `/spomenar/book.pdf`: each
must return `206`, the requested byte count, and a `Content-Range` total matching the public PDF.
The browser pass should use the served site to check workers, CSP, page links, touch controls,
and visible page readiness.
