# Automatic Spomenar publication

`scripts/spomenar-watch.py` watches one stable public Nextcloud share. It resolves
the current local file, waits for changes to settle, creates an immutable Btrfs
reflink, and invokes the Motion Lab raster and reading producers and their shared
publisher. It uses the local PDF for both derived representations.

The service, its sequential generation phases, and native worker children belong to one
systemd cgroup. A private flock prevents two supervisors from owning the same
state. The supervisor runs as root for publication; the PDF inspector and
renderer run as `juraj`, and the Nextcloud metadata resolver runs as `www-data`.
The existing Python environment supplies Pillow and PyMuPDF.

## Identity and work order

Every 30 seconds, the supervisor checks the native token DAV endpoint with HEAD
and invokes the small PHP resolver. Native DAV remains the authority for public
access. The resolver uses `OCP\App\IAppManager`, `OCP\Share\IManager`, the shared
node, and the public local-storage API. Loading the filesystem applications is
necessary for group-folder mounts in a CLI process. It does not query Nextcloud
tables or read database settings into Python.
The resolver sets `NC_config_is_read_only=1` in its own PHP process before
Nextcloud starts. This enables Nextcloud's supported read-only configuration
mode under the service's filesystem restrictions; the live site configuration
stays unchanged.

The candidate identity includes Nextcloud file ID and ETag, resolved local path,
and the file's device, inode, size, modification time and change time. A new
identity must remain unchanged for 30 seconds. A rename or move therefore follows
the share's node. Deployment settings identify the public share.
The poll also observes replacement, password/access changes and revoked shares,
which a file-only notification watch cannot cover.

After settling, Linux `FICLONE` creates a copy-on-write snapshot. The source and
destination must support reflinks on the same underlying filesystem. The
supervisor refuses a physical-copy fallback. PDF snapshots live on Btrfs at
`/mnt/btrfs_storage`; the existing `/var/www/html` and Motion Lab cache use ext4,
so JPEG publication remains in the existing preview store. The operation is defined by the
[Linux FICLONE interface](https://man7.org/linux/man-pages/man2/FICLONE.2const.html).

The supervisor hashes the local snapshot and rechecks the live share before
accepting it as `versions/<SHA>/book.pdf`. A repeated unchanged observation uses
the retained record and does not hash again. A rename which preserves bytes may
need one new local hash, then reuses the same SHA edition. Copy-on-write isolates
existing readers from later in-place source edits.

For a new SHA, the existing producer's bounded inspector supplies page count.
Configured priority pages, initially 99 and 100, are clipped to the document; if
none exist, page 1 is the priority. Three producer invocations run sequentially:

1. The priority pages receive the normal 192, 512, 768 and 1536 pixel pyramid and
   image regions. The existing publisher validates and publishes that checkpoint.
2. The full invocation resumes the same work directory and fills the remaining
   document. Its completed checkpoint replaces the atlas manifest atomically.
3. The reading producer preserves the PDF's native text/layout/operator structure
   and externalizes image streams. Verified progressive JPEG scans and exact
   original-mode fallbacks are published before its completed `reading.json`.

At most one invocation owns the job slot. Each publication checks the current
share before asset publication and again before the config commit. A changed
source cancels the owned job and restarts settling. A completed stale namespace
can remain as retained data, but it cannot become the config's current edition.

The producer and publisher perform source hashing, enforce parser limits, define
preview geometry and manifests, validate assets, resume interrupted rendering,
and publish assets atomically. Their command interfaces are described in
[motionlab-previews.md](motionlab-previews.md) and
[motionlab-reading.md](motionlab-reading.md). The supervisor's `inspect_pages`
function calls the producer's internal inspector to determine page count.

## Publication files and public access

The root-owned publication catalog is outside the replaceable viewer site:

| File or link | Purpose |
| --- | --- |
| `/mnt/btrfs_storage/spomenar-public/versions/<SHA>/book.pdf` | Immutable PDF reflink |
| `/mnt/btrfs_storage/spomenar-public/catalog/config.json` | Authoritative atomic site configuration |
| `/mnt/btrfs_storage/spomenar-public/catalog/status.json` | Small public progress record |
| `catalog/versions` | Root-owned link to `../versions` |
| `catalog/previews` | Root-owned link to `/var/www/html/spomenar-previews` |
| `public` | Root-owned link to `catalog`; removing it withdraws public access |
| `/var/www/html/spomenar-previews/<SHA>/manifest.json` | Existing publisher's atomic atlas manifest |
| `/var/www/html/spomenar-previews/<SHA>/reading.json` | Atomic source-bound reading manifest |
| `/var/www/html/spomenar-previews/<SHA>/reading/` | Immutable structural PDF and encoded image assets |
| `/var/lib/spomenar-watch/state.json` | Private source identities and recovery records |
| `/var/cache/spomenar-watch/<SHA>/` | Producer's resumable work directory |

The fixed nginx locations in `scripts/spomenar-watch.nginx.conf` map
`/spomenar/config.json`, `/spomenar/status.json`, `/spomenar-versions/`, and
`/spomenar/previews/` through that link. PDF requests use static nginx delivery
with sendfile, HEAD, byte ranges and If-Range.

The same snippet explicitly returns 404 for the direct `/spomenar-previews/`
storage path, including the slashless spelling. Assets are reachable through
the public link even if the surrounding server later serves its document root.

Before the first edition, the seeded config points directly at native DAV. After
a verified priority or full publication, one atomic
config replacement retains the title, filename and source link and binds all
edition fields together:

```json
{
  "pdfUrl": "/spomenar-versions/<64-character-source-SHA>/book.pdf",
  "title": "30 godina LARICS-a",
  "filename": "Kako je LARICS postao 30-godišnjak.pdf",
  "sourceUrl": "/nextcloud/s/spomenar-2026",
  "publicationGeneration": 2,
  "previews": {
    "manifestUrl": "/spomenar/previews/<64-character-source-SHA>/manifest.json",
    "sha256": "<64-character-source-SHA>",
    "size": 1608358464,
    "validator": { "header": "ETag", "value": "\"observed-static-nginx-etag\"" },
    "manifestRevision": "<64-character-manifest-SHA>"
  },
  "reading": {
    "manifestUrl": "/spomenar/previews/<64-character-source-SHA>/reading.json",
    "sha256": "<64-character-source-SHA>",
    "size": 1608358464,
    "validator": { "header": "ETag", "value": "\"observed-static-nginx-etag\"" },
    "manifestRevision": "<64-character-reading-manifest-SHA>"
  }
}
```

The example placeholders are descriptive. Production fields contain actual
hashes and the validator observed from HEAD plus a 16-byte conditional range on
the immutable PDF URL. A full-atlas update can change `manifestRevision` without
changing PDF identity. Readers can refresh the preview atlas while keeping the
current PDF open. The optional reading binding appears only after the complete
reading representation verifies. It uses the same original PDF identity and
HTTP validator, with its own manifest byte digest. A new source never inherits
the preceding edition's reading binding.

Status has exactly `phase`, `versionSha`, `publishedSha`, `readyPages`,
`totalPages`, and `configGeneration`. Ready pages have every configured pyramid
tier. Phases include `waiting`, `settling`, `snapshotting`, `priority`, `full`,
`reading`, `publishing`, `publishing-reading`, `ready`, `retrying`, `unavailable`,
and `withdrawn`. Public status
contains only these publication fields.

The two small JSON locations disable nginx ETags and If-Modified-Since handling.
Static nginx validators use second-resolution modification time and byte length;
same-size atomic updates within a second could otherwise be missed. A visible
client receives the small body and compares the generation/identity/revision.
PDF and atlas locations retain normal validators. All four routes disable
open-file caching so removing the public link takes effect on subsequent requests.

## Recovery, withdrawal and retention

The state record is committed before the public config. On restart, the public
config identifies the currently advertised edition. Completed immutable records
skip completed phases, while incomplete manifests resume the missing phase.
A missing or older reading-format version starts reading generation even when
the source and full raster atlas are unchanged. Recorded
filesystem metadata avoids repeated content checks. If that metadata changes,
the service verifies the PDF hash and the completed manifest and assets before
refreshing the recorded metadata. A persistent pending-publication flag keeps
configuration replacement retryable across restarts.
The service discards only its own abandoned staging directories and unrecorded
SHA snapshot/work directories. It also reclaims an uncommitted producer manifest
or publisher temporary asset while holding the corresponding writer's existing
lock. It never scans for or kills processes by name.

Producer/publisher failures preserve the last complete config and published
assets. Failed work remains resumable, with exponential retry delay from 60
seconds to one hour. A transient resolver or HTTP failure keeps the public
link and last valid edition. Native DAV responses 401, 403, 404 or 410 remove the
link at the next poll and stop the owned job. A static alias error causes a
publication retry. Restoring the public share restores
the link after an authoritative native check. Bytes already downloaded by
a reader remain on that reader's device.

Defaults retain three published editions and one pending edition, with a hard
8 GiB budget for logical PDF sizes. The 24-hour retirement grace is best effort:
the oldest unreferenced edition is removed when the count or byte cap needs room.
Current and candidate editions are protected. A fourth update therefore proceeds
without waiting a day. Old version URLs have a finite lifetime; an old open tab
may need to reload after its edition is retired.

Each retained atlas has a 512 MiB raster budget. Reading assets and their metadata
have a separate 2 GiB output budget; atomic metadata replacement charges the old
and temporary new bytes together. `max_derived_mib`, default 10,240 MiB, bounds
actual published raster, reading and metadata bytes across retained editions.
Generation reserves room under this aggregate bound before starting, and
publication accounts the resulting namespace. Retention can remove an old
unprotected edition to make room, while current/candidate editions stay protected.

Resumable work has the same per-phase budgets, separate from published assets.
With at most four records, the conservative work allowance is 10 GiB plus bounded
native scratch, alongside the 10 GiB published-derived cap and 8 GiB logical-PDF
cap. Completed work is removed after publication. Btrfs sharing usually makes
physical PDF allocation smaller; the PDF cap counts full logical sizes. Existing
unrelated preview namespaces are not deleted by this service.

The service unit limits the whole cgroup to one CPU, 2 GiB of memory, and
32 tasks. The default renderer uses one worker and its existing 4 GiB virtual
address-space limit and 60-second native job timeout. Raster invocation has a
600-second deadline and 512 MiB output limit; reading invocation has a 3,600-second
deadline and 2 GiB output limit. These are configurable production-processing
budgets. A terminated or wedged generator causes supervisor exit
so systemd cleans the entire cgroup before restarting and launching another job.

## Installation and initial adoption

Use the existing authenticated root deployment channel.

1. Install the five adjacent scripts, root-owned and not writable by the render
   user, into `/usr/local/lib/spomenar-watch/`: `spomenar-watch.py`,
   `spomenar-share-source.php`, `motionlab-previews.py`, and
   `publish-spomenar-previews.py`, plus `motionlab-reading.py`. Install the exact
   `src/core/pdfReadingFormat.json` from the same revision there as
   `pdfReadingFormat.json`, and `scripts/pdf-jpeg-progressive/coefficients.c` under
   its `pdf-jpeg-progressive/` subdirectory. The installed producer loads that
   shared format file and compiles the maintained verifier in its owned work area.
2. Create `/etc/spomenar-watch/`. Copy `spomenar-watch.example.json` to
   `config.json`, and seed `base-config.json` from the intended public site's
   title, filename and source URL. The supervisor rewrites its initial PDF URL to
   native DAV and strips any stale preview/reading binding. Keep these settings root-owned.
3. Check the existing renderer interpreter in the settings can import Pillow and
   PyMuPDF as the configured render user, and that `cc` can link libjpeg with its
   installed development headers. The Steffy runtime already supplies these.
4. Bootstrap before enabling nginx aliases or starting the daemon:

   ```sh
   /usr/bin/python3 -B /usr/local/lib/spomenar-watch/spomenar-watch.py \
     --config /etc/spomenar-watch/config.json --bootstrap
   ```

   This creates the Btrfs publication directory, private state/work directories,
   catalog links, fallback config and initial status; it verifies native public
   access and local resolution, creates the public link, and exits. Rendering
   and PDF snapshots begin when the daemon starts.
5. Integrate the fixed locations from `spomenar-watch.nginx.conf` into the
   existing HTTPS server, replacing the old config/preview locations. Remove the
   old `/spomenar/book.pdf` adapter and its REQUEST_URI modification. Validate
   nginx configuration, reload it, and check the fallback config/status routes.

   The existing `node scripts/deploy-spomenar.mjs --check` and `--deploy` commands
   perform this integration from the single checked snippet. They require the
   bootstrap catalog, retain the native share's HEAD/16-byte preflight, and remove
   only the recognized Spomenar REQUEST_URI adapter. Asset deployment omits the
   build-time `config.json` seed; it never replaces the catalog's live config.
6. Install `spomenar-watch.service`, run `systemd-analyze verify` and
   `systemctl daemon-reload`, then `systemctl enable --now spomenar-watch.service`.
7. Observe the first adoption in the journal and public status. The example
   settings name the already completed current atlas as `adopt_atlas`. The service
   reflinks/hashes the current PDF, verifies that this atlas matches that SHA and
   has every page/tier, and uses the existing publisher. Since the current public
   assets already match, it validates and reuses them without another JPEG copy
   or renderer run. Confirm the config's static URL, source size, manifest SHA and
   observed static validator, then check a small conditional range. A complete
   sibling reading representation is adopted through the same verified publisher;
   otherwise the service generates it in the next phase.

## Upgrading an existing edition

Viewer-only deployment preserves the catalog and does not restart this service.
A producer/service upgrade must load the matching Python, C and format sources:

1. Validate `npm run test:spomenar:offline` on the exact source revision. Stage the
   five scripts, verifier source and format JSON listed above through the existing
   authenticated deployment channel. Keep their relative installed locations and
   root ownership; install the dependencies before replacing the supervisor.
2. Stop `spomenar-watch.service` before replacing its producer bundle or adopting
   precomputed work. This closes its single owned job and leaves the last public
   catalog and assets available. Replace the installed files from one revision.

   From the reviewed checkout or an identically structured staging bundle, run
   through that authenticated root channel:

   ```sh
   systemctl stop spomenar-watch.service
   install -d -o root -g root -m 0755 /usr/local/lib/spomenar-watch/pdf-jpeg-progressive
   install -o root -g root -m 0644 src/core/pdfReadingFormat.json /usr/local/lib/spomenar-watch/pdfReadingFormat.json
   install -o root -g root -m 0644 scripts/pdf-jpeg-progressive/coefficients.c /usr/local/lib/spomenar-watch/pdf-jpeg-progressive/coefficients.c
   install -o root -g root -m 0644 scripts/motionlab-previews.py scripts/motionlab-reading.py scripts/publish-spomenar-previews.py scripts/spomenar-share-source.php scripts/spomenar-watch.py /usr/local/lib/spomenar-watch/
   ```

3. Optionally place a completed, source-verified staging result into
   `/var/cache/spomenar-watch/<original-PDF-SHA>/` as the configured render user.
   Transfer only its `reading.json` and `reading/` assets, preserving the immutable
   names. Do not overwrite existing resumable work: first reconcile its source
   and writer lock. The service revalidates the source, asset and scan hashes
   before publishing this staged result. Without precomputed work it generates
   the representation itself.
4. Start `spomenar-watch.service`. The unchanged current edition's missing or
   outdated reading record schedules only the reading phase; its original PDF,
   raster atlas and prior catalog remain in service. The completed representation
   commits through the existing publisher, followed by one atomic catalog update.

   ```sh
   systemctl start spomenar-watch.service
   systemctl status --no-pager spomenar-watch.service
   ```
5. Check the journal and public status, then read `config.json`. Confirm that
   original `pdfUrl`, SHA and size stayed fixed, `reading.manifestRevision` hashes
   the actual published `reading.json`, and its structural PDF and assets pass
   their declared hashes. Check a small conditional range on the unchanged
   original PDF. Deploy the compatible viewer/worker through the separate viewer
   deployment command and validate text, photographs and final native composition.

The production run can be prepared in an isolated directory before this upgrade,
using the existing immutable source file. Generation alone changes no catalog,
watcher setting or live publication. The original source fingerprint, exact code
hashes, output manifest and verification receipt accompany that staged handoff.

Later site deployments must retain the fixed alias include and the root-owned
catalog. The seed file is used only when no catalog config exists; it is not a
second live copy of the public configuration. To unpublish, stop/disable the unit
and remove the public link. Keep the fixed locations and direct-storage denial
while retaining published assets for rollback or inspection, so requests stay on
the withdrawn routes instead of falling through to the surrounding server.
Remove or move those assets before removing their protective locations during a
later uninstall, then validate nginx and reload it.

## Focused checks

```sh
npm run test:spomenar:offline
```

The gate includes producer, preview, publisher, watcher and installer suites. It
uses tiny owned files, the real existing publisher, and the real
producer when PyMuPDF is available. Its nginx test starts a private Unix-socket
fixture, verifies Range/HEAD/If-Range and JSON updates, then closes every route
by removing the public link without reloading nginx. On Steffy, explicitly enable the
cross-subvolume fixture with `SPOMENAR_BTRFS_FIXTURE_ROOT=/mnt/btrfs_storage` and
`SPOMENAR_BTRFS_SOURCE_FIXTURE_ROOT=/mnt/btrfs_storage/nextcloud_data`. Both fixture
directories are temporary and removed on every exit. Tests use their own fixtures;
the live shared PDF stays unchanged.
