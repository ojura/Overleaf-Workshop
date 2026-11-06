# Standalone Spomenar deployment

The public reader is served at [cloud.larics.fer.hr/spomenar/](https://cloud.larics.fer.hr/spomenar/).
Viewer assets and published books have separate lifetimes. The publication service turns the
existing [Nextcloud public share](https://cloud.larics.fer.hr/nextcloud/s/spomenar-2026) into immutable
PDF editions at `/spomenar-versions/<SHA>/book.pdf`, with matching preview atlases
and independent text/layout plus encoded-image reading representations. Its root-owned
catalog supplies the live configuration and remains outside the replaceable viewer directory.

## Build and deploy

Both deployer modes require a bootstrapped publication catalog containing `config.json` and
`status.json` under `/mnt/btrfs_storage/spomenar-public/catalog/`. For first installation, follow
[automatic publication](spomenar-watch.md#installation-and-initial-adoption) to install the service
scripts and settings, verify the render interpreter, and run:

```sh
/usr/bin/python3 -B /usr/local/lib/spomenar-watch/spomenar-watch.py \
  --config /etc/spomenar-watch/config.json --bootstrap
```

Bootstrap creates the catalog, fallback configuration, status and public links after verifying
the native share and local source. It exits before snapshotting or rendering. The initial
fallback points at native DAV; the first verified publication replaces it with an immutable URL.

From the repository, build and deploy the viewer:

```sh
npm run build-spomenar
node scripts/deploy-spomenar.mjs --check
node scripts/deploy-spomenar.mjs --deploy
```

The build produces `dist/spomenar/`. Use `node scripts/build-spomenar.mjs --out DIRECTORY` for a
different build destination, and `--build-dir DIRECTORY` when deploying an existing output.
The deployer consumes that output; it does not run the build or compile the book. Static asset
uploads are limited to 128 MiB and reject symlinks, unexpected filesystem entries and a copied
`book.pdf`.

On first installation, integrate the fixed nginx routes through this deployment before enabling
the publication service. Then install and verify its systemd unit, reload the unit configuration,
and enable/start the service as described in the publication guide. PDF snapshots and preview
generation begin with the daemon. Later viewer deployments preserve the existing catalog.

The machine-specific settings are grouped in `target` at the beginning of
`scripts/deploy-spomenar.mjs`. It uses the existing SSH alias and the sudo-listener root channel
on Steffy. That listener must already be running, with its key readable only by the invoking
user. The script does not read the key into logs or change its permissions.

`--check` is the default. It performs HEAD against the named share's native Nextcloud DAV endpoint,
then verifies a conditional range of at most sixteen PDF bytes. The preflight requires PDF
content type, identity encoding, a strong ETag or valid Last-Modified, HTTP 206 and the matching
length, Content-Range and validator. Redirects and whole-file responses are rejected before
their bodies are read. This native request checks the publication source's public access.

The check also runs `nginx -t` against temporary copies of the proposed configuration. It leaves
live nginx files and assets unchanged and does not reload the server. It can run before building
the viewer assets, once catalog bootstrap is complete.

`--deploy` uploads the static build and installs the checked publication snippet in the existing
TLS server. The installer removes the staged build's `config.json` seed so the live catalog alias
stays authoritative. It validates nginx, renames the previous asset tree aside, activates the new
tree and gracefully reloads nginx. The migration removes only the recognized former Spomenar
`REQUEST_URI` adapter; an unfamiliar remaining reference stops the operation for review.

Failure during activation restores the preceding asset tree and both nginx files, validates
them and reloads the restored configuration. A successful reload commits activation. Subsequent
backup cleanup or final reporting can fail while the new site remains active, so inspect the
served site and command's failure stage before assuming a nonzero result rolled it back.
Normal success removes the old assets and local/remote staging. The catalog, immutable PDFs and
derived-asset store remain outside this asset replacement. A publication-producer
upgrade is a separate operation: follow the service guide's
[existing-edition migration](spomenar-watch.md#upgrading-an-existing-edition) to
install its coherent Python/C/format bundle and restart the watcher. That restart
lets the current unchanged book acquire a missing reading representation.

## PDF delivery and updates

The single source for public locations is `scripts/spomenar-watch.nginx.conf`:

| Public path | Source and behavior |
| --- | --- |
| `/spomenar/` | Replaceable viewer assets. |
| `/spomenar/config.json` | Atomic configuration through the publication catalog's public link. |
| `/spomenar/status.json` | Small publication progress record through the same link. |
| `/spomenar-versions/<SHA>/book.pdf` | Static immutable PDF from the retained edition. |
| `/spomenar/previews/<SHA>/manifest.json` and its relative assets | Matching published preview atlas. |
| `/spomenar/previews/<SHA>/reading.json` and `reading/` assets | Verified structural PDF and progressive/original encoded image streams. |
| `/spomenar-previews` and paths below it | Explicit 404 for the direct storage namespace. |

Static nginx PDF delivery uses sendfile, HEAD, identity transfer, ETag, byte ranges and If-Range.
The route accepts one range per request. The four publication locations disable open-file
caching so removal of the shared public link withdraws subsequent requests together.

Nextcloud remains the authority for the source node and public access. The service polls that
authority, follows renames and moves, waits for a changed source to settle, and creates a
copy-on-write PDF snapshot under its SHA. It publishes priority-page previews, then the full
atlas and the reading representation, with atomic configuration and manifest updates. Each identity includes the exact
source digest, byte length and observed static HTTP validator. A fuller manifest can replace
an earlier checkpoint while the current PDF stays open.

Confirmed share withdrawal removes the public link at the next service poll. Transient failures,
resumable generation, edition retention and storage limits are defined in the
[publication guide](spomenar-watch.md#recovery-withdrawal-and-retention).

To unpublish, stop and disable the service and remove its public link. Keep the fixed nginx
locations, including the direct-storage deny, while retaining published assets for rollback or
inspection. This keeps requests on the withdrawn routes instead of falling through to the
surrounding server configuration. Remove or move retained public assets before removing their
protective locations during a later uninstall, then validate nginx and reload it.

The bare `/spomenar` URL redirects to `/spomenar/`. Page links use a hash, so reloading or sharing
a page link still requests the same entry document from nginx.

## Browser assets and headers

Entry HTML, configuration, styles, modules and runtime assets use `Cache-Control: no-cache`.
The publication routes use the same policy, including immutable PDF editions. Immutability
describes the edition's bytes; browser requests still revalidate them. PDF and atlas locations
retain normal validators. Configuration and status disable ETag and If-Modified-Since handling,
so an equal-size atomic JSON update within one second still returns its new small body.

The site's CSP permits only same-origin connections and scripts. It also permits PDF.js worker
blobs, data/blob images and fonts, inline styles used by the viewer and robot panel, and WebAssembly
compilation. JavaScript eval remains disabled in the viewer. CMaps, standard fonts, image decoders,
and the pinned PDF.js worker are included under the site's relative asset directory.

After publication, read the actual configuration and status, then verify HEAD and a small
conditional range against the exact `pdfUrl` named by that configuration. The range must return
206, the requested byte count and the correct Content-Range total and validator. Use the served
site to check workers, CSP, page links, touch controls and visible page readiness.

The focused suites are:

```sh
npm run test:spomenar:offline
```

Installer cases exercise bounded native preflight, invalid ranges and validators, closing a
whole-file response before body consumption, exact adapter removal, catalog preservation,
config-seed omission, activation rollback, and cleanup/reporting failure after successful
activation. The activation fixture uses real filesystem commit/restore ordering with substituted
nginx commands.

The watch suite owns the actual nginx static-route fixture. It checks HEAD, Range, If-Range,
same-second JSON replacement, the direct-storage deny, and withdrawal through the shared link.
It also covers source snapshots, priority/full/reading publication, unchanged-edition
migration, restart recovery, stale jobs, backoff and separate derived-asset retention.
See the publication guide's [focused checks](spomenar-watch.md#focused-checks)
for the optional Btrfs fixture settings.
