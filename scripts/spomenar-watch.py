#!/usr/bin/env python3
"""Watch one public Nextcloud share and publish immutable PDF/preview editions.

This is a supervisor for motionlab-previews.py and publish-spomenar-previews.py.
It does not render PDFs. Its root-owned catalog is the publication commit point;
native parsing runs with the configured unprivileged renderer identity.
"""
from __future__ import annotations

import argparse
import contextlib
from dataclasses import dataclass
import fcntl
import hashlib
import http.client
import importlib.util
import json
import math
import os
from pathlib import Path
import pwd
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import urlsplit


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("spomenar_publisher", SCRIPT_DIRECTORY / "publish-spomenar-previews.py")
PUBLISHER = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(PUBLISHER)
PRODUCER = PUBLISHER._protocol
READING = PUBLISHER.READING
MIB = PRODUCER.MIB
HASH = PRODUCER.HASH

# Linux FICLONE, from <linux/fs.h>. This is deliberately an ioctl-only path: an
# unsupported filesystem fails without silently copying a multi-gigabyte PDF.
FICLONE = 0x40049409
MAX_SETTINGS_BYTES = 64 * 1024
MAX_STATE_BYTES = 256 * 1024
HTTP_TIMEOUT_SECONDS = 15  # Last resort for an unresponsive HTTP peer.
CHILD_STOP_SECONDS = 15  # A wedged child causes service restart/cgroup cleanup.

# Existing writer staging protocols. Recovery only removes these names while
# holding that writer's own lock. Keep this adapter together if either writer
# changes its staging convention; committed manifests/assets are never removed.
PRODUCER_LOCK = ".motionlab.lock"
PRODUCER_STAGING_PREFIX = ".motionlab-work-"
PRODUCER_PENDING_MANIFEST = ".manifest.pending"
PUBLISHER_LOCK = ".publish.lock"
PUBLISHER_PENDING = re.compile(r"^\.publish-[a-f0-9]{32}\.tmp$")


class Failure(Exception):
    pass


class Withdrawn(Failure):
    pass


class Changed(Failure):
    pass


class Stopping(Failure):
    pass


class ChildStuck(Failure):
    pass


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}, separators=(",", ":")), flush=True)


def identity(path):
    info = Path(path).lstat()
    if not stat.S_ISREG(info.st_mode):
        raise Failure("Expected a regular file")
    return PRODUCER.stat_fingerprint(info)


def read_json(path, maximum=MAX_SETTINGS_BYTES):
    path = Path(path)
    if identity(path)[2] > maximum:
        raise Failure("JSON input exceeds its byte bound")
    with path.open("rb") as stream:
        payload = stream.read(maximum + 1)
    if len(payload) > maximum:
        raise Failure("JSON input exceeds its byte bound")
    return json.loads(payload)


def atomic_json(path, value, mode=0o644):
    """Replace one complete document, and preserve its validator if unchanged."""
    path = Path(path)
    payload = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()
    if path.is_symlink():
        raise Failure("Refusing a symlink at an owned JSON path")
    if path.is_file() and path.read_bytes() == payload:
        return False
    fd, temporary = tempfile.mkstemp(prefix=".watch-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        PRODUCER.sync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return True


def child_identity(name):
    user = pwd.getpwnam(name)
    if os.geteuid() == user.pw_uid:
        return {}
    if os.geteuid() != 0:
        raise Failure("Changing the child identity requires the root supervisor")
    return {"user": user.pw_uid, "group": user.pw_gid, "extra_groups": []}


@contextlib.contextmanager
def writer_lock(path, owner=None):
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size != 0:
            raise Failure("A writer lock is not an empty regular file")
        if owner is not None and os.geteuid() == 0:
            os.fchown(descriptor, owner.pw_uid, owner.pw_gid)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Failure("An existing writer still owns this directory") from error
        yield
    finally:
        os.close(descriptor)


@dataclass(frozen=True)
class Settings:
    publication_root: Path
    preview_root: Path
    work_root: Path
    state_root: Path
    base_config: Path
    python: Path
    nextcloud_root: Path
    source_root: Path
    native_url: str
    share_token: str
    renderer_user: str = "juraj"
    nextcloud_user: str = "www-data"
    public_url_prefix: str = "/spomenar-versions"
    preview_url_prefix: str = "/spomenar/previews"
    adopt_atlas: Path | None = None
    priority_pages: tuple[int, ...] = (99, 100)
    # Seconds. Polling also catches share changes which a file-only watch misses.
    poll_seconds: float = 30
    settle_seconds: float = 30
    retry_seconds: float = 60
    retirement_seconds: float = 24 * 60 * 60
    # Logical PDF bytes, not exclusive Btrfs blocks. Three published editions and
    # one pending edition fit the current 1.6 GB book in this 8 GiB hard budget.
    max_snapshot_mib: int = 8192
    max_published_versions: int = 3
    # Existing producer units: MiB, seconds, worker count, virtual address space.
    max_output_mib: int = 512
    max_reading_output_mib: int = 2048
    # Published raster, reading and metadata bytes across retained editions.
    # Temporary generation is separately bounded by its phase's output budget.
    max_derived_mib: int = 10240
    workers: int = 1
    max_worker_mib: int = 4096
    render_deadline_seconds: float = 600
    reading_deadline_seconds: float = 3600
    job_timeout_seconds: float = 60

    @classmethod
    def load(cls, path):
        value = read_json(path)
        for key in ("publication_root", "preview_root", "work_root", "state_root", "base_config", "python",
                    "nextcloud_root", "source_root", "adopt_atlas"):
            if key in value and value[key] is not None:
                value[key] = Path(value[key])
        if "priority_pages" in value:
            value["priority_pages"] = tuple(value["priority_pages"])
        result = cls(**value)
        result.validate()
        return result

    def validate(self):
        roots = (self.publication_root, self.preview_root, self.work_root, self.state_root)
        for path in (*roots, self.base_config, self.python, self.nextcloud_root, self.source_root):
            if not path.is_absolute() or ".." in path.parts:
                raise Failure("Service paths must be absolute without parent traversal")
        if any(a == b or a in b.parents or b in a.parents for i, a in enumerate(roots) for b in roots[i + 1:]):
            raise Failure("Publication, work and state roots must be separate")
        if any(path == self.source_root or self.source_root in path.parents for path in roots):
            raise Failure("Service output must be outside the Nextcloud source root")
        parsed = urlsplit(self.native_url)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment):
            raise Failure("native_url must be an absolute HTTPS URL without credentials or query")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", self.share_token):
            raise Failure("Invalid public share token")
        if parsed.path.rsplit("/", 1)[-1] != self.share_token:
            raise Failure("The native DAV URL must end with the configured share token")
        if not re.fullmatch(r"/[A-Za-z0-9_-]+", self.public_url_prefix):
            raise Failure("public_url_prefix must be one absolute URL segment")
        if not re.fullmatch(r"(?:/[A-Za-z0-9_-]+)+", self.preview_url_prefix):
            raise Failure("preview_url_prefix must contain safe absolute URL segments")
        for value in (self.poll_seconds, self.settle_seconds, self.retry_seconds, self.retirement_seconds,
                      self.render_deadline_seconds, self.reading_deadline_seconds, self.job_timeout_seconds):
            if not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 < value <= 86400:
                raise Failure("Service times must be finite positive seconds, at most one day")
        if (self.workers not in (1, 2) or not 128 <= self.max_worker_mib <= 16384
                or not 1 <= self.max_output_mib <= 4096 or self.job_timeout_seconds > 3600
                or not 1 <= self.max_reading_output_mib <= 65536 or not 1 <= self.max_derived_mib <= 65536
                or not 1 <= self.max_published_versions <= 8
                or not 1 <= self.max_snapshot_mib <= 65536):
            raise Failure("Invalid service resource budget")
        if not self.priority_pages or any(type(page) is not int or not 1 <= page <= PRODUCER.MAX_PAGES
                                          for page in self.priority_pages):
            raise Failure("priority_pages must contain bounded one-based page numbers")


@dataclass(frozen=True)
class Source:
    path: str
    file_id: int
    size: int
    etag: str
    fingerprint: tuple[int, ...]

    def record(self):
        return {"path": self.path, "fileId": self.file_id, "size": self.size,
                "etag": self.etag, "fingerprint": list(self.fingerprint)}


def http_pdf(url, expected_size=None, check_range=False, share_guard=False):
    """No redirects, decompression, or full-body fallback are accepted."""
    parsed = urlsplit(url)
    connection = http.client.HTTPSConnection(parsed.hostname, parsed.port, timeout=HTTP_TIMEOUT_SECONDS)
    response = None
    try:
        connection.request("HEAD", parsed.path, headers={"Accept-Encoding": "identity"})
        response = connection.getresponse()
        if response.status in (401, 403, 404, 410):
            if share_guard:
                raise Withdrawn("The public share is unavailable")
            raise Failure("The static PDF route is unavailable")
        if response.status != 200 or response.getheader("Content-Encoding"):
            raise Failure("The public PDF HEAD did not return an identity representation")
        size = int(response.getheader("Content-Length", "0"))
        etag = response.getheader("ETag", "")
        if (not 0 < size <= PRODUCER.MAX_SOURCE_BYTES or expected_size is not None and size != expected_size
                or not re.fullmatch(r'"[^"\r\n]*"', etag)):
            raise Failure("The public PDF has inconsistent size or a missing strong ETag")
        response.close()
        response = None
        connection.close()
        if check_range:
            connection = http.client.HTTPSConnection(parsed.hostname, parsed.port, timeout=HTTP_TIMEOUT_SECONDS)
            end = min(15, size - 1)
            connection.request("GET", parsed.path, headers={"Accept-Encoding": "identity",
                               "Range": f"bytes=0-{end}", "If-Range": etag})
            response = connection.getresponse()
            if (response.status != 206 or response.getheader("Content-Encoding")
                    or response.getheader("Content-Range") != f"bytes 0-{end}/{size}"
                    or response.getheader("Content-Length") != str(end + 1)
                    or response.getheader("ETag") != etag):
                raise Failure("The public PDF did not preserve its bounded range and validator")
            data = response.read(end + 2)
            if len(data) != end + 1 or not data.startswith(b"%PDF-"):
                raise Failure("The public PDF range has invalid bytes")
        return {"size": size, "etag": etag}
    finally:
        if response is not None:
            response.close()
        connection.close()


class Watcher:
    def __init__(self, settings, *, monotonic=time.monotonic, wall_time=time.time):
        settings.validate()
        self.settings = settings
        self.monotonic, self.wall_time = monotonic, wall_time
        self.stop_event = threading.Event()
        self.root = settings.publication_root
        self.versions = self.root / "versions"
        self.catalog = self.root / "catalog"
        self.config_path = self.catalog / "config.json"
        self.state_path = settings.state_root / "state.json"
        self.state = {"version": 1, "records": {}}
        self.observed = None
        self.stable_since = 0
        self.candidate = None
        self.child = None
        self.child_phase = None
        self.lock = None

    @property
    def records(self):
        return self.state["records"]

    def save(self):
        atomic_json(self.state_path, self.state, 0o600)

    def open(self):
        for path, mode in ((self.root, 0o755), (self.versions, 0o755), (self.catalog, 0o755),
                           (self.settings.preview_root, 0o755),
                           (self.settings.state_root, 0o700), (self.settings.work_root, 0o755)):
            if path.is_symlink():
                raise Failure("An owned service directory is a symlink")
            path.mkdir(parents=True, exist_ok=True, mode=mode)
        self.lock = os.open(self.settings.state_root / "service.lock",
                            os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        if not stat.S_ISREG(os.fstat(self.lock).st_mode):
            raise Failure("The service lock is not a regular file")
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            os.close(self.lock)
            self.lock = None
            raise Failure("Another watcher owns this service state") from error
        if self.state_path.exists():
            self.state = read_json(self.state_path, MAX_STATE_BYTES)
            if (self.state.get("version") != 1 or not isinstance(self.records, dict)
                    or any(not HASH.fullmatch(key) for key in self.records)):
                raise Failure("Invalid watcher state")
        for name, target in (("versions", "../versions"), ("previews", str(self.settings.preview_root))):
            link = self.catalog / name
            if not link.exists() and not link.is_symlink():
                link.symlink_to(target, target_is_directory=True)
            if not link.is_symlink() or os.readlink(link) != target:
                raise Failure("A catalog link has an unexpected target")
        if not self.config_path.exists():
            fallback = read_json(self.settings.base_config)
            fallback["pdfUrl"] = self.settings.native_url
            fallback.pop("previews", None)
            fallback.pop("reading", None)
            fallback["publicationGeneration"] = 0
            atomic_json(self.config_path, fallback)
        current = self.current()
        if current and current not in self.records:
            raise Failure("The published config has no retained version record")
        # Only this service's staging names and SHA namespaces are eligible. A
        # crash between snapshot rename and state commit leaves an owned orphan.
        for path in self.versions.iterdir():
            if path.name.startswith(".pending-") or HASH.fullmatch(path.name) and path.name not in self.records:
                self.remove_directory(path)
        for path in self.settings.work_root.iterdir():
            if path.name.startswith(".inspect-") or HASH.fullmatch(path.name) and path.name not in self.records:
                self.remove_directory(path)
        self.save()
        self.status("waiting")

    def current_config(self):
        return read_json(self.config_path)

    def current(self):
        value = self.current_config()
        sha = value.get("previews", {}).get("sha256")
        if isinstance(sha, str) and HASH.fullmatch(sha) and value.get("pdfUrl") == self.pdf_url(sha):
            return sha
        return None

    def pdf_url(self, sha):
        return f"{self.settings.public_url_prefix}/{sha}/book.pdf"

    def gate(self, enabled):
        target = self.root / "public"
        if target.is_symlink():
            if os.readlink(target) != "catalog":
                raise Failure("The public gate has an unexpected target")
            if not enabled:
                target.unlink()
                PRODUCER.sync_directory(self.root)
        elif target.exists():
            raise Failure("The public gate must be an owned symlink")
        elif enabled:
            target.symlink_to("catalog", target_is_directory=True)
            PRODUCER.sync_directory(self.root)

    def status(self, phase, sha=None, ready=0, total=0):
        config = self.current_config()
        value = {"phase": phase, "versionSha": sha, "publishedSha": self.current(),
                 "readyPages": ready, "totalPages": total,
                 "configGeneration": config.get("publicationGeneration", 0)}
        if atomic_json(self.catalog / "status.json", value):
            emit("status", **value)

    def resolve(self):
        settings = self.settings
        response = http_pdf(settings.native_url, share_guard=True)
        result = subprocess.run(["/usr/bin/php", "-d", "apc.enable_cli=1",
                                 str(SCRIPT_DIRECTORY / "spomenar-share-source.php"),
                                 str(settings.nextcloud_root), settings.share_token],
                                **child_identity(settings.nextcloud_user),
                                capture_output=True, timeout=HTTP_TIMEOUT_SECONDS, check=False)
        if result.returncode or len(result.stdout) > MAX_SETTINGS_BYTES:
            raise Failure("The share resolver did not return bounded metadata")
        value = json.loads(result.stdout)
        # The native endpoint is the public-policy authority. A resolver failure
        # while native DAV still answers is transient, not a revocation signal.
        if value.get("status") != "ready":
            raise Failure("The share has no eligible local source")
        path = Path(value["path"])
        if (not path.is_absolute() or path.resolve() != path or self.settings.source_root not in path.parents
                or type(value.get("fileId")) is not int or type(value.get("size")) is not int):
            raise Failure("The share resolver returned an invalid local identity")
        fingerprint = identity(path)
        etag = '"' + value.get("etag", "") + '"'
        if fingerprint[2] != value["size"] or value["size"] != response["size"] or etag != response["etag"]:
            raise Failure("Nextcloud metadata and local source are not settled")
        return Source(str(path), value["fileId"], value["size"], etag, fingerprint)

    def assert_current(self, source):
        self.check()
        if self.resolve() != source:
            raise Changed("The public share changed before publication")

    def check(self):
        """Cancellation interface shared with the existing publisher deadline."""
        if self.stop_event.is_set():
            raise Stopping()

    @staticmethod
    def remove_directory(path):
        if path.is_symlink() or not path.is_dir():
            raise Failure("Refusing to remove an unexpected service path")
        shutil.rmtree(path)

    def retire(self, sha):
        if sha in (self.current(), self.candidate):
            raise Failure("Cannot retire the current or candidate edition")
        for root in (self.versions, self.settings.preview_root, self.settings.work_root):
            path = root / sha
            if path.exists() or path.is_symlink():
                self.remove_directory(path)
        del self.records[sha]
        self.save()
        emit("retired", sha256=sha)

    def reserve(self, incoming_size=0, new_version=False, incoming_derived=0):
        """Grace yields to hard caps; current/candidate never yield."""
        protected = {self.current(), self.candidate}
        for sha, record in list(self.records.items()):
            if sha not in protected and not record.get("publishedAt"):
                self.retire(sha)
        while True:
            records = self.records
            published = sum(bool(record.get("publishedAt")) for record in records.values())
            size = sum(record["size"] for record in records.values()) + incoming_size
            derived = sum(record.get("derivedBytes", self.settings.max_output_mib * MIB
                                     if record.get("publishedAt") else 0) for record in records.values()) + incoming_derived
            pressure = (size > self.settings.max_snapshot_mib * MIB
                        or derived > self.settings.max_derived_mib * MIB
                        or len(records) + int(new_version) > self.settings.max_published_versions + 1
                        or not new_version and published > self.settings.max_published_versions)
            eligible = sorted((sha for sha in records if sha not in protected),
                              key=lambda sha: records[sha].get("publishedAt", records[sha]["created"]))
            old = bool(eligible and published > 2
                       and self.wall_time() - records[eligible[0]].get("publishedAt", records[eligible[0]]["created"])
                       >= self.settings.retirement_seconds)
            if not pressure and not old:
                return
            if not eligible:
                if pressure:
                    raise Failure("The protected edition and candidate exceed the retention budget")
                return
            self.retire(eligible[0])

    def snapshot(self, source):
        self.reserve(source.size, new_version=True)
        self.status("snapshotting", self.candidate)
        pending = Path(tempfile.mkdtemp(prefix=".pending-", dir=self.versions))
        try:
            original = os.open(source.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                if PRODUCER.stat_fingerprint(os.fstat(original)) != source.fingerprint:
                    raise Changed("The source changed before its snapshot")
                with (pending / "book.pdf").open("xb+") as target:
                    fcntl.ioctl(target.fileno(), FICLONE, original)
                    target.flush()
                    os.fsync(target.fileno())
                    if identity(source.path) != source.fingerprint:
                        raise Changed("The source changed during its snapshot")
                    digest = hashlib.sha256()
                    target.seek(0)
                    while block := target.read(MIB):
                        if self.stop_event.is_set():
                            raise Stopping()
                        digest.update(block)
                    sha = digest.hexdigest()
                    os.fchmod(target.fileno(), 0o444)
                    os.fsync(target.fileno())
                self.assert_current(source)
            finally:
                os.close(original)
            destination = self.versions / sha
            if sha in self.records:
                record = self.records[sha]
                # This freshly hashed source-to-SHA association is authoritative
                # even if the older retained copy is corrupt. Verify that copy in
                # advance(), after tick owns the candidate and can persist backoff.
                record["source"] = source.record()
            else:
                if destination.exists():
                    raise Failure("An unrecorded snapshot occupies the SHA namespace")
                pending.chmod(0o755)
                PRODUCER.sync_directory(pending)
                os.replace(pending, destination)
                PRODUCER.sync_directory(self.versions)
                self.records[sha] = {"size": source.size, "source": source.record(),
                                     "snapshot": list(identity(destination / "book.pdf")),
                                     "created": self.wall_time(), "full": False}
            self.save()
            return sha
        finally:
            if pending.exists():
                self.remove_directory(pending)

    def verify_snapshot(self, sha):
        """Fingerprints cache verification; the SHA remains the durable identity."""
        record = self.records[sha]
        path = self.versions / sha / "book.pdf"
        fingerprint = identity(path)
        if tuple(record["snapshot"]) == fingerprint:
            return
        # A restore/remount may change device, inode or timestamps without changing
        # bytes. Reuse the publisher's exact-size, bounded, cancellation-aware hash
        # reader, and reject both corruption and a replacement during verification.
        with PUBLISHER.directory(path.parent) as folder:
            with PUBLISHER.regular_file(folder, path.name) as (descriptor, before):
                if PRODUCER.stat_fingerprint(before) != fingerprint:
                    raise Failure("The immutable snapshot changed before verification")
                PUBLISHER.checked_asset(descriptor, before,
                                        {"path": path.name, "bytes": record["size"], "sha256": sha},
                                        PUBLISHER.Deadline(self.settings.job_timeout_seconds, self))
        if identity(path) != fingerprint:
            raise Failure("The immutable snapshot changed during verification")
        record.update(snapshot=list(fingerprint), publicationPending=True)
        self.save()

    def verify_edition(self, sha):
        self.verify_snapshot(sha)
        record = self.records[sha]
        if not record.get("full"):
            return
        path = self.settings.preview_root / sha / "manifest.json"
        fingerprint = identity(path)
        if tuple(record["manifest"]) == fingerprint:
            return
        revision = record.get("manifestRevision")
        if revision is None and self.current() == sha:
            # Older state records already have an authoritative digest in their
            # atomic public config. Never infer an old revision from changed bytes.
            revision = self.current_config().get("previews", {}).get("manifestRevision")
        if not isinstance(revision, str) or not HASH.fullmatch(revision):
            raise Failure("The completed edition has no saved manifest revision")
        _, value, ready = self.manifest(path.parent, sha, verify_assets=True, expected_revision=revision)
        if value["document"]["pageCount"] != record["pageCount"] or len(ready) != record["pageCount"]:
            raise Failure("The restored edition does not contain its complete preview pyramid")
        if identity(path) != fingerprint:
            raise Failure("The completed manifest changed during verification")
        record.update(manifest=list(fingerprint), manifestRevision=revision, publicationPending=True)
        self.save()

    def manifest(self, directory, sha, *, verify_assets=False, expected_revision=None):
        deadline = PUBLISHER.Deadline(self.settings.job_timeout_seconds if verify_assets else 10, self)
        with PUBLISHER.directory(directory) as folder:
            payload, value = PUBLISHER.snapshot_manifest(folder, deadline)
            assets, _ = PUBLISHER.validate_manifest(value, sha, self.settings.max_output_mib * MIB)
            if value["document"]["size"] != self.records[sha]["size"]:
                raise Failure("The atlas does not describe the retained PDF size")
            if expected_revision is not None and hashlib.sha256(payload).hexdigest() != expected_revision:
                raise Failure("The completed manifest differs from its saved revision")
            if verify_assets:
                for asset in assets:
                    with PUBLISHER.asset_parent(folder, asset["path"]) as (parent, name):
                        with PUBLISHER.regular_file(parent, name) as (descriptor, before):
                            PUBLISHER.checked_asset(descriptor, before, asset, deadline)
        ready = {page["pageNumber"] for page in value["pages"]
                 if "imageRegions" in page
                 and set(PRODUCER.TIERS).issubset({max(asset["width"], asset["height"]) for asset in page["assets"]})}
        return payload, value, ready

    def atlas_metadata_ready(self, directory, sha):
        # Legacy geometry and complete raster tiers remain valid while the new
        # occurrence evidence is prepared. False is a processed conservative result.
        _, value, ready = self.manifest(directory, sha)
        return len(ready) == value["document"]["pageCount"] and all(
            type(page.get("imageRegionsComplete")) is bool for page in value["pages"])

    def prepare_metadata_work(self, sha):
        self.reserve(incoming_derived=self.settings.max_output_mib * MIB)
        work = self.work_directory(sha)
        if (work / "manifest.json").exists():
            self.manifest(work, sha, verify_assets=True)
            return work
        # Seed through the same validating publisher used for live publication.
        # Only its destination changes; the public edition remains untouched.
        public = self.settings.preview_root / sha
        self.manifest(public, sha, verify_assets=True)
        user = pwd.getpwnam(self.settings.renderer_user)
        with writer_lock(work / PRODUCER_LOCK, user):
            args = PUBLISHER.parser().parse_args([str(public), "--web-root", str(self.settings.work_root),
                "--sha256", sha, "--max-assets-mib", str(self.settings.max_output_mib)])
            with open(os.devnull, "w") as output, contextlib.redirect_stdout(output):
                PUBLISHER.publish(args, cancellation=self)
            # The publisher writes protected files as the supervisor. The ordinary
            # producer owns this resumable staging tree and must create new assets.
            if os.geteuid() == 0:
                entries = 0
                for _, folders, files, descriptor in os.fwalk(work, follow_symlinks=False):
                    entries += len(folders) + len(files)
                    if entries > PRODUCER.MAX_DIRECTORY_ENTRIES:
                        raise Failure("The metadata staging scan exceeds its entry bound")
                    os.fchown(descriptor, user.pw_uid, user.pw_gid)
                    for name in files:
                        os.chown(name, user.pw_uid, user.pw_gid, dir_fd=descriptor, follow_symlinks=False)
        return work

    def reading_manifest(self, directory, sha, *, verify_assets=False, expected_revision=None):
        deadline = PUBLISHER.Deadline(self.settings.render_deadline_seconds if verify_assets else 10, self)
        with PUBLISHER.directory(directory) as folder:
            payload, value = PUBLISHER.snapshot_manifest(folder, deadline, "reading.json")
            assets, asset_bytes = PUBLISHER.validate_reading(value, sha, self.settings.max_reading_output_mib * MIB)
            record = self.records[sha]
            if (value["source"]["size"] != record["size"]
                    or value["source"]["pageCount"] != record["pageCount"]):
                raise Failure("The reading representation differs from the retained PDF")
            if expected_revision is not None and hashlib.sha256(payload).hexdigest() != expected_revision:
                raise Failure("The reading manifest differs from its saved revision")
            if verify_assets:
                for asset in assets:
                    with PUBLISHER.asset_parent(folder, asset["path"]) as (parent, name):
                        with PUBLISHER.regular_file(parent, name) as (descriptor, before):
                            PUBLISHER.checked_asset(descriptor, before, asset, deadline)
        return payload, value, asset_bytes + len(payload)

    def reading_ready(self, sha):
        record = self.records[sha]
        if record.get("readingVersion") != READING.VERSION:
            return False
        path = self.settings.preview_root / sha / "reading.json"
        try:
            fingerprint = identity(path)
        except FileNotFoundError:
            return False
        if tuple(record.get("readingManifest", ())) != fingerprint:
            revision = record.get("readingRevision")
            if not isinstance(revision, str) or not HASH.fullmatch(revision):
                raise Failure("The reading representation has no saved revision")
            _, _, size = self.reading_manifest(path.parent, sha, verify_assets=True, expected_revision=revision)
            if identity(path) != fingerprint:
                raise Failure("The reading manifest changed during verification")
            record.update(readingManifest=list(fingerprint), readingBytes=size, publicationPending=True)
            self.save()
        return True

    def derived_bytes(self, sha):
        return PRODUCER.directory_bytes(self.settings.preview_root / sha,
                                        PUBLISHER.Deadline(self.settings.job_timeout_seconds, self))

    def work_directory(self, sha):
        path = self.settings.work_root / sha
        if path.is_symlink():
            raise Failure("The render directory is a symlink")
        path.mkdir(mode=0o700, exist_ok=True)
        user = pwd.getpwnam(self.settings.renderer_user)
        if os.geteuid() == 0:
            os.chown(path, user.pw_uid, user.pw_gid)
        with writer_lock(path / PRODUCER_LOCK, user):
            for stale in path.glob(PRODUCER_STAGING_PREFIX + "*"):
                self.remove_directory(stale)
            pending = path / PRODUCER_PENDING_MANIFEST
            if pending.exists() or pending.is_symlink():
                if identity(pending)[2] > PRODUCER.MAX_MANIFEST_BYTES:
                    raise Failure("An abandoned manifest exceeds its producer bound")
                pending.unlink()
                PRODUCER.sync_directory(path)
        return path

    def clear_publisher_staging(self, sha):
        namespace = self.settings.preview_root / sha
        if not namespace.exists():
            return
        if namespace.is_symlink():
            raise Failure("The publication namespace is a symlink")
        with writer_lock(namespace / PUBLISHER_LOCK):
            entries = 0
            for directory, folders, files in os.walk(namespace, followlinks=False):
                entries += len(folders) + len(files)
                if entries > PRODUCER.MAX_DIRECTORY_ENTRIES:
                    raise Failure("The publication staging scan exceeds its entry bound")
                for name in files:
                    if PUBLISHER_PENDING.fullmatch(name):
                        path = Path(directory) / name
                        if identity(path)[2] > max(READING.MAX_IMAGE_BYTES, READING.MAX_PDF_BYTES, PRODUCER.MAX_MANIFEST_BYTES):
                            raise Failure("An abandoned publication exceeds its writer bound")
                        path.unlink()

    def spawn(self, arguments, *, cwd=None, stdin=None):
        environment = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", PYTHONNOUSERSITE="1",
                           OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1")
        with (self.settings.state_root / "last-render-error.log").open("wb") as errors:
            return subprocess.Popen(arguments, cwd=cwd, env=environment,
                                    stdin=stdin, stdout=subprocess.DEVNULL, stderr=errors,
                                    start_new_session=True, **child_identity(self.settings.renderer_user))

    def stop_child(self):
        if self.child is None:
            return
        if self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=CHILD_STOP_SECONDS)
            except subprocess.TimeoutExpired as error:
                # Do not launch a replacement over possibly orphaned native
                # workers. systemd kills the entire service cgroup on restart.
                raise ChildStuck("The owned render process did not stop") from error
        self.child = None
        self.child_phase = None

    def inspect_pages(self, sha):
        """Use the producer's existing bounded inspector, then its public CLI.

        This small adapter to --_worker keeps page-count parsing in one place and
        lets configured priorities be clipped when a replacement book is shorter.
        Its contract is exercised by a real tiny-PDF test.
        """
        folder = Path(tempfile.mkdtemp(prefix=".inspect-", dir=self.settings.work_root))
        user = pwd.getpwnam(self.settings.renderer_user)
        if os.geteuid() == 0:
            os.chown(folder, user.pw_uid, user.pw_gid)
        settings = self.settings
        payload = {"operation": "inspect", "source": str(self.versions / sha / "book.pdf"),
                   "fingerprint": self.records[sha]["snapshot"], "renderer": "pymupdf", "has_fitz": True,
                   "memory_mib": settings.max_worker_mib, "file_limit": PRODUCER.MIN_JOB_FILE_BYTES,
                   "timeout": settings.job_timeout_seconds}
        try:
            self.child = self.spawn([str(settings.python), "-B", str(SCRIPT_DIRECTORY / "motionlab-previews.py"),
                                     "--_worker"], cwd=folder, stdin=subprocess.PIPE)
            self.child.stdin.write(json.dumps(payload).encode())
            self.child.stdin.close()
            deadline = self.monotonic() + settings.job_timeout_seconds
            while self.child.poll() is None:
                if self.stop_event.wait(.1):
                    raise Stopping()
                if self.monotonic() >= deadline:
                    raise Failure("The producer's metadata inspector exceeded its deadline")
            if self.child.returncode:
                raise Failure("The producer's metadata inspector failed")
            count = read_json(folder / "result.json")["pageCount"]
            if type(count) is not int or not 0 < count <= PRODUCER.MAX_PAGES:
                raise Failure("The producer returned an invalid page count")
            return count
        finally:
            self.stop_child()
            self.remove_directory(folder)

    def launch(self, sha, phase):
        if self.child is not None:
            raise Failure("A render process already owns the job slot")
        settings, record = self.settings, self.records[sha]
        if "pageCount" not in record:
            record["pageCount"] = self.inspect_pages(sha)
            record["priorities"] = [page for page in dict.fromkeys(settings.priority_pages)
                                     if page <= record["pageCount"]] or [1]
            self.save()
        priority = ",".join(map(str, record["priorities"]))
        if phase == "reading":
            self.reserve(incoming_derived=settings.max_reading_output_mib * MIB)
            arguments = [str(settings.python), "-B", str(SCRIPT_DIRECTORY / "motionlab-reading.py"),
                         str(self.versions / sha / "book.pdf"), "--output", str(self.work_directory(sha)),
                         "--max-output-mib", str(settings.max_reading_output_mib),
                         "--max-worker-mib", str(settings.max_worker_mib),
                         "--deadline-seconds", str(settings.reading_deadline_seconds),
                         "--job-timeout-seconds", str(settings.job_timeout_seconds)]
            self.child = self.spawn(arguments)
            self.child_phase = phase
            self.status(phase, sha, total=record["pageCount"])
            emit("render-start", sha256=sha, phase=phase)
            return
        self.reserve(incoming_derived=settings.max_output_mib * MIB)
        arguments = [str(settings.python), "-B", str(SCRIPT_DIRECTORY / "motionlab-previews.py"),
                     str(self.versions / sha / "book.pdf"), "--output", str(self.work_directory(sha)),
                     "--priority-pages", priority, "--workers", str(settings.workers),
                     "--max-output-mib", str(settings.max_output_mib),
                     "--max-worker-mib", str(settings.max_worker_mib),
                     "--deadline-seconds", str(settings.render_deadline_seconds),
                     "--job-timeout-seconds", str(settings.job_timeout_seconds),
                     "--renderer", "pymupdf", "--require-image-regions"]
        if phase == "priority":
            arguments += ["--pages", priority]
        self.child = self.spawn(arguments)
        self.child_phase = phase
        self.status(phase, sha, total=record["pageCount"])
        emit("render-start", sha256=sha, phase=phase)

    def publish(self, sha, source, generated, full):
        self.assert_current(source)
        self.status("publishing", sha)
        # The existing publisher validates paths, bytes, hashes and manifest size;
        # it commits its manifest last. No renderer output is copied ad hoc here.
        self.clear_publisher_staging(sha)
        args = PUBLISHER.parser().parse_args([str(generated), "--web-root", str(self.settings.preview_root),
                                              "--sha256", sha, "--max-assets-mib", str(self.settings.max_output_mib)])
        with open(os.devnull, "w") as output, contextlib.redirect_stdout(output):
            PUBLISHER.publish(args, cancellation=self)
        self.commit(sha, source, full)

    def publish_reading(self, sha, source, generated):
        self.assert_current(source)
        payload, value, size = self.reading_manifest(generated, sha)
        self.reserve(incoming_derived=size)
        self.status("publishing-reading", sha)
        self.clear_publisher_staging(sha)
        args = PUBLISHER.parser().parse_args([str(generated), "--reading", "--web-root", str(self.settings.preview_root),
                                              "--sha256", sha, "--max-assets-mib", str(self.settings.max_reading_output_mib),
                                              "--deadline-seconds", str(self.settings.render_deadline_seconds)])
        with open(os.devnull, "w") as output, contextlib.redirect_stdout(output):
            PUBLISHER.publish(args, cancellation=self)
        self.assert_current(source)
        public = self.settings.preview_root / sha
        published, _, published_size = self.reading_manifest(public, sha)
        if published != payload or published_size != size:
            raise Failure("The published reading snapshot differs from the selected generation")
        self.records[sha].update(readingVersion=value["version"], readingManifest=list(identity(public / "reading.json")),
                                 readingRevision=hashlib.sha256(payload).hexdigest(), readingBytes=size,
                                 derivedBytes=self.derived_bytes(sha), publicationPending=True)
        self.save()
        self.commit(sha, source, full=True)

    def commit(self, sha, source, full):
        """Bind the PDF, atlas revision and observed HTTP validator in one file."""
        payload, manifest, ready = self.manifest(self.settings.preview_root / sha, sha)
        if full and len(ready) != manifest["document"]["pageCount"]:
            raise Failure("The completed job did not produce the full preview pyramid")
        self.verify_snapshot(sha)
        self.assert_current(source)
        record = self.records[sha]
        parsed = urlsplit(self.settings.native_url)
        transport = http_pdf(f"{parsed.scheme}://{parsed.netloc}{self.pdf_url(sha)}",
                             expected_size=record["size"], check_range=True)
        self.assert_current(source)
        config = self.current_config()
        update = dict(config, pdfUrl=self.pdf_url(sha), previews={
            "manifestUrl": f"{self.settings.preview_url_prefix}/{sha}/manifest.json",
            "sha256": sha, "size": record["size"],
            "validator": {"header": "ETag", "value": transport["etag"]},
            "manifestRevision": hashlib.sha256(payload).hexdigest()})
        if self.reading_ready(sha):
            update["reading"] = {"manifestUrl": f"{self.settings.preview_url_prefix}/{sha}/reading.json",
                "manifestRevision": record["readingRevision"], "sha256": sha, "size": record["size"],
                "validator": dict(update["previews"]["validator"])}
        else:
            update.pop("reading", None)
        record.update(full=full, pageCount=manifest["document"]["pageCount"],
                      publishedAt=self.wall_time(), manifest=list(identity(self.settings.preview_root / sha / "manifest.json")),
                      manifestRevision=update["previews"]["manifestRevision"],
                      derivedBytes=self.derived_bytes(sha), publicationPending=True)
        record.pop("retryAt", None)
        record.pop("failures", None)
        # Write recoverable edition metadata before the single public commit.
        self.save()
        if update != config:
            update["publicationGeneration"] = config.get("publicationGeneration", 0) + 1
            atomic_json(self.config_path, update)
        # A verified restore may change nginx's validator. Clear this durable
        # retry marker only after the matching config has committed successfully.
        record.pop("publicationPending", None)
        self.save()
        self.status("ready" if full else "full", sha, len(ready), record["pageCount"])
        emit("published", sha256=sha, full=full, configGeneration=update.get("publicationGeneration", 0))
        if full:
            work = self.settings.work_root / sha
            if work.exists() and ("reading" in update or not (work / READING.STATE).exists()):
                self.remove_directory(work)
        self.reserve()

    def adopt(self, sha, source):
        directory = self.settings.adopt_atlas
        if directory is None or not directory.is_dir():
            return False
        try:
            _, value, ready = self.manifest(directory, sha)
        except (Failure, PUBLISHER.Failure, OSError, ValueError):
            return False
        if len(ready) != value["document"]["pageCount"]:
            return False
        self.publish(sha, source, directory, full=True)
        if (directory / "reading.json").is_file():
            self.publish_reading(sha, source, directory)
        return True

    def advance(self, sha, source):
        record = self.records[sha]
        if record.get("retryAt", 0) > self.wall_time():
            return
        self.verify_edition(sha)
        if record.get("full"):
            reading_ready = self.reading_ready(sha)
            if self.current() == sha and not record.get("publicationPending"):
                self.status("ready", sha, record["pageCount"], record["pageCount"])
            else:
                self.commit(sha, source, full=True)
            if not reading_ready:
                work = self.settings.work_root / sha
                if (work / "reading.json").is_file():
                    self.publish_reading(sha, source, work)
                else:
                    self.launch(sha, "reading")
            elif not self.atlas_metadata_ready(self.settings.preview_root / sha, sha):
                work = self.prepare_metadata_work(sha)
                if self.atlas_metadata_ready(work, sha):
                    self.publish(sha, source, work, full=True)
                else:
                    self.launch(sha, "metadata")
            return
        if self.adopt(sha, source):
            return
        work = self.settings.work_root / sha
        if (work / "manifest.json").exists():
            _, value, ready = self.manifest(work, sha)
            count = value["document"]["pageCount"]
            record["pageCount"] = count
            record["priorities"] = [page for page in dict.fromkeys(self.settings.priority_pages) if page <= count] or [1]
            full = len(ready) == count
            if full or set(record["priorities"]).issubset(ready):
                self.publish(sha, source, work, full)
                if full:
                    return
                self.launch(sha, "full")
                return
        self.launch(sha, "priority")

    def tick(self):
        try:
            source = self.resolve()
        except Withdrawn:
            self.gate(False)
            self.stop_child()
            self.observed = self.candidate = None
            self.status("withdrawn")
            return
        except (Failure, OSError, ValueError, subprocess.SubprocessError):
            self.status("unavailable", self.candidate)
            return
        self.gate(True)
        if source != self.observed:
            self.stop_child()
            self.observed, self.candidate = source, None
            self.stable_since = self.monotonic()
            self.status("settling")
            return
        if self.monotonic() - self.stable_since < self.settings.settle_seconds:
            return
        try:
            if self.candidate is None:
                self.candidate = next((sha for sha, record in self.records.items()
                                       if record["source"] == source.record()), None)
                if self.candidate is None:
                    self.candidate = self.snapshot(source)
            sha = self.candidate
            if self.child is not None:
                code = self.child.poll()
                if code is None:
                    work = self.settings.work_root / sha
                    if (work / "manifest.json").exists():
                        _, value, ready = self.manifest(work, sha)
                        self.status(self.child_phase, sha, len(ready), value["document"]["pageCount"])
                    return
                phase = self.child_phase
                self.child = self.child_phase = None
                if code < 0:
                    raise ChildStuck("The renderer was killed; restart clears its entire cgroup")
                if code:
                    raise Failure(f"The {phase} producer exited with status {code}")
                if phase == "reading":
                    self.publish_reading(sha, source, self.settings.work_root / sha)
                else:
                    if phase == "metadata" and not self.atlas_metadata_ready(self.settings.work_root / sha, sha):
                        raise Failure("The metadata producer did not finish occurrence inventory processing")
                    self.publish(sha, source, self.settings.work_root / sha, full=phase in {"full", "metadata"})
                if phase == "priority":
                    self.launch(sha, "full")
            else:
                self.advance(sha, source)
        except Withdrawn:
            self.gate(False)
            self.stop_child()
            self.observed = self.candidate = None
            self.status("withdrawn")
        except Changed:
            self.stop_child()
            self.observed = self.candidate = None
            self.status("settling")
        except (ChildStuck, Stopping):
            raise
        except (Failure, PUBLISHER.Failure, PRODUCER.LimitReached, OSError, ValueError,
                subprocess.SubprocessError) as error:
            self.stop_child()
            if self.candidate is not None:
                record = self.records[self.candidate]
                record["failures"] = min(record.get("failures", 0) + 1, 8)
                record["retryAt"] = self.wall_time() + min(3600, self.settings.retry_seconds * 2 ** (record["failures"] - 1))
                self.save()
            self.status("retrying", self.candidate)
            emit("retry", kind=type(error).__name__, message=str(error)[:300])

    def close(self):
        try:
            self.stop_child()
        finally:
            if self.lock is not None:
                os.close(self.lock)
                self.lock = None

    def run(self):
        try:
            self.open()
            while not self.stop_event.is_set():
                self.tick()
                ends = self.monotonic() + self.settings.poll_seconds
                wait_for_child = self.child is not None and self.child.poll() is None
                while not self.stop_event.is_set() and self.monotonic() < ends:
                    if wait_for_child and self.child is not None and self.child.poll() is not None:
                        break
                    self.stop_event.wait(min(1, max(0, ends - self.monotonic())))
        except Stopping:
            pass
        finally:
            self.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="Root-owned service settings JSON")
    parser.add_argument("--bootstrap", action="store_true",
                        help="Create the native fallback catalog, verify its share, open its gate, then exit")
    arguments = parser.parse_args()
    watcher = None
    try:
        watcher = Watcher(Settings.load(arguments.config))
        for kind in (signal.SIGTERM, signal.SIGINT):
            signal.signal(kind, lambda *_: watcher.stop_event.set())
        if arguments.bootstrap:
            try:
                watcher.open()
                watcher.resolve()
                watcher.gate(True)
            finally:
                watcher.close()
        else:
            watcher.run()
        return 0
    except (Failure, OSError, ValueError, TypeError, KeyError) as error:
        emit("error", kind=type(error).__name__, message=str(error)[:300])
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
