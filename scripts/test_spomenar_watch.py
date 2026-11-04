"""Watcher lifecycle tests with private tiny files and the real atlas publisher."""
from __future__ import annotations

import contextlib
from dataclasses import replace
import errno
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from PIL import Image

SPEC = importlib.util.spec_from_file_location("spomenar_watch", Path(__file__).with_name("spomenar-watch.py"))
WATCH = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = WATCH
SPEC.loader.exec_module(WATCH)


def checksum(data):
    return hashlib.sha256(data).hexdigest()


def replace_fixture_file(path, data=None):
    """Model a restore to a new inode, retaining content unless explicitly changed."""
    replacement = path.with_name(path.name + ".restored")
    replacement.write_bytes(path.read_bytes() if data is None else data)
    replacement.chmod(path.stat().st_mode & 0o777)
    replacement.replace(path)


def clone_tiny_fixture(destination, operation, source):
    """Filesystem-independent lifecycle tests; the separate Btrfs test uses ioctl."""
    assert operation == WATCH.FICLONE
    os.lseek(source, 0, os.SEEK_SET)
    while block := os.read(source, 65536):
        os.write(destination, block)


def atlas(path, sha, size, *, pages=(1, 2, 3), count=3):
    path.mkdir(parents=True, exist_ok=True)
    value = {"version": 1, "document": {"key": "sha256:" + sha, "sha256": sha,
             "size": size, "pageCount": count}, "pages": []}
    for number in pages:
        assets = []
        for tier in WATCH.PRODUCER.TIERS:
            image = Image.new("RGB", (tier, tier), (number * 40 % 255, 20, 180))
            stream = io.BytesIO()
            image.save(stream, "JPEG")
            image.close()
            data = stream.getvalue()
            digest = checksum(data)
            relative = f"assets/p{number}-{tier}-{digest}.jpg"
            target = path / relative
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(data)
            assets.append({"path": relative, "width": tier, "height": tier,
                           "bytes": len(data), "sha256": digest, "mime": "image/jpeg"})
        value["pages"].append({"pageNumber": number, "width": 100, "height": 100,
                               "rotation": 0, "assets": assets, "imageRegions": []})
    WATCH.atomic_json(path / "manifest.json", value)
    return value


class FakeChild:
    def __init__(self):
        self.returncode = None
        self.terminated = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = 143

    def wait(self, timeout=None):
        return self.returncode


class FixtureWatcher(WATCH.Watcher):
    def __init__(self, settings, source, clock, *, real_renderer=False):
        super().__init__(settings, monotonic=lambda: clock[0], wall_time=lambda: 1700000000 + clock[0])
        self.source_path = source
        self.source_failure = None
        self.launched = []
        self.real_renderer = real_renderer

    def resolve(self):
        if self.source_failure is not None:
            raise self.source_failure
        fingerprint = WATCH.identity(self.source_path)
        return WATCH.Source(str(self.source_path), 7, fingerprint[2], '"native"', fingerprint)

    def launch(self, sha, phase):
        self.launched.append((sha, phase))
        if self.real_renderer:
            return super().launch(sha, phase)
        if self.child is not None:
            raise AssertionError("A second render job was started")
        self.records[sha].update(pageCount=3, priorities=[2, 3])
        self.save()
        self.child, self.child_phase = FakeChild(), phase


class WatcherTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="spomenar-watch-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.root.chmod(0o755)
        self.source_root = self.root / "nextcloud"
        self.source_root.mkdir()
        self.source = self.source_root / "original.pdf"
        self.source.write_bytes(b"%PDF-1.4\nsmall owned source A\n")
        self.seed = self.root / "seed"
        self.base = self.root / "base.json"
        WATCH.atomic_json(self.base, {"pdfUrl": "./book.pdf", "title": "Test book",
                                     "filename": "test.pdf", "sourceUrl": "/nextcloud/s/test"})
        self.clock = [0.0]
        user = os.environ.get("SPOMENAR_RENDERER_FIXTURE_USER", pwd.getpwuid(os.geteuid()).pw_name)
        self.settings = WATCH.Settings(publication_root=self.root / "publication",
                                       preview_root=self.root / "previews", work_root=self.root / "work",
                                       state_root=self.root / "state", base_config=self.base,
                                       python=Path(sys.executable), nextcloud_root=self.source_root,
                                       source_root=self.source_root, native_url="https://example.test/dav/files/test",
                                       share_token="test", renderer_user=user, nextcloud_user=user,
                                       priority_pages=(2, 3), settle_seconds=10, poll_seconds=10)
        self.output = io.StringIO()
        self.redirect = contextlib.redirect_stdout(self.output)
        self.redirect.__enter__()
        self.addCleanup(self.redirect.__exit__, None, None, None)
        self.clone = mock.patch.object(WATCH.fcntl, "ioctl", side_effect=clone_tiny_fixture)
        self.clone_mock = self.clone.start()
        self.addCleanup(self.clone.stop)
        self.transport = mock.patch.object(WATCH, "http_pdf", side_effect=self.static_transport)
        self.transport.start()
        self.addCleanup(self.transport.stop)
        self.watcher = self.make_watcher()

    def make_watcher(self, settings=None, **kwargs):
        watcher = FixtureWatcher(settings or self.settings, self.source, self.clock, **kwargs)
        watcher.open()
        self.addCleanup(watcher.close)
        return watcher

    def static_transport(self, url, expected_size=None, **kwargs):
        return {"size": expected_size, "etag": '"static-' + url.split("/")[-2] + '"'}

    def settle(self):
        self.watcher.tick()
        self.clock[0] += self.settings.settle_seconds
        self.watcher.tick()

    def finish(self, pages=(1, 2, 3), count=3):
        sha = self.watcher.candidate
        atlas(self.settings.work_root / sha, sha, self.watcher.records[sha]["size"], pages=pages, count=count)
        self.watcher.child.returncode = 0
        self.watcher.tick()
        return sha

    def adopt_current(self, payload=None):
        if payload is not None:
            self.source.write_bytes(payload)
        sha = checksum(self.source.read_bytes())
        if self.seed.exists():
            shutil.rmtree(self.seed)
        atlas(self.seed, sha, self.source.stat().st_size)
        self.watcher.settings = replace(self.watcher.settings, adopt_atlas=self.seed)
        self.settle()
        self.assertEqual(self.watcher.current(), sha, self.output.getvalue())
        return sha

    def test_bootstrap_is_native_and_catalog_lives_outside_site(self):
        config = self.watcher.current_config()
        self.assertEqual(config["pdfUrl"], self.settings.native_url)
        self.assertEqual(config["publicationGeneration"], 0)
        self.assertNotIn("previews", config)
        self.assertFalse((self.watcher.root / "public").exists())
        self.watcher.tick()
        self.assertTrue((self.watcher.root / "public/config.json").is_file())
        self.assertEqual((self.watcher.catalog / "previews").resolve(), self.settings.preview_root)

    def test_changes_coalesce_and_a_change_during_render_stops_the_owned_job(self):
        self.watcher.tick()
        self.clock[0] = 6
        self.source.write_bytes(b"%PDF-1.4\nsource B\n")
        self.watcher.tick()
        self.clock[0] = 10
        self.watcher.tick()
        self.assertFalse(self.watcher.launched)
        self.clock[0] = 16
        self.watcher.tick()
        self.assertEqual(len(self.watcher.launched), 1)
        old_sha, child = self.watcher.candidate, self.watcher.child
        original = (self.watcher.versions / old_sha / "book.pdf").read_bytes()
        self.source.write_bytes(b"%PDF-1.4\nsource C\n")
        self.watcher.tick()
        self.assertTrue(child.terminated)
        self.assertIsNone(self.watcher.child)
        self.assertEqual((self.watcher.versions / old_sha / "book.pdf").read_bytes(), original)
        self.assertEqual(self.watcher.current_config()["pdfUrl"], self.settings.native_url)

    def test_priority_then_full_reuses_pdf_and_atomically_changes_manifest_revision(self):
        self.settle()
        sha = self.finish(pages=(2, 3))
        priority = self.watcher.current_config()
        self.assertEqual(self.watcher.child_phase, "full")
        self.assertEqual(priority["publicationGeneration"], 1)
        self.assertEqual(priority["previews"]["manifestRevision"],
                         checksum((self.settings.preview_root / sha / "manifest.json").read_bytes()))
        self.finish()
        complete = self.watcher.current_config()
        self.assertEqual(complete["pdfUrl"], priority["pdfUrl"])
        self.assertEqual(complete["previews"]["validator"], priority["previews"]["validator"])
        self.assertNotEqual(complete["previews"]["manifestRevision"], priority["previews"]["manifestRevision"])
        self.assertEqual(complete["publicationGeneration"], 2)
        self.assertFalse((self.settings.work_root / sha).exists())
        status = WATCH.read_json(self.watcher.catalog / "status.json")
        self.assertEqual((status["phase"], status["readyPages"], status["totalPages"]), ("ready", 3, 3))
        self.assertNotIn(str(self.root), json.dumps(status))
        config_identity = WATCH.identity(self.watcher.config_path)
        self.watcher.tick()
        self.assertEqual(WATCH.identity(self.watcher.config_path), config_identity)

    def test_adopts_complete_atlas_then_skips_render_and_hash_on_restart(self):
        sha = self.adopt_current()
        self.assertFalse(self.watcher.launched)
        self.watcher.close()
        restarted = self.make_watcher()
        self.watcher = restarted
        with mock.patch.object(WATCH.PUBLISHER, "publish", side_effect=AssertionError("unexpected republish")), \
                mock.patch.object(WATCH.hashlib, "sha256", side_effect=AssertionError("unexpected rehash")):
            before = self.clone_mock.call_count
            self.settle()
        self.assertEqual(self.clone_mock.call_count, before)
        self.assertEqual(restarted.current(), sha)
        self.assertFalse(restarted.launched)

    def test_rename_follows_share_identity_and_reuses_same_edition(self):
        sha = self.adopt_current()
        original_config = self.watcher.current_config()
        renamed = self.source_root / "Moved book with spaces.pdf"
        self.source.rename(renamed)
        self.source = self.watcher.source_path = renamed
        self.settle()
        self.assertEqual(self.watcher.current(), sha)
        self.assertEqual(self.watcher.current_config(), original_config)
        self.assertEqual(self.watcher.records[sha]["source"]["path"], str(renamed))
        self.assertFalse(self.watcher.launched)

    def test_same_sha_candidate_recovers_restored_snapshot_metadata(self):
        sha = self.adopt_current()
        snapshot = self.watcher.versions / sha / "book.pdf"
        before = WATCH.identity(snapshot)
        replace_fixture_file(snapshot)
        self.assertNotEqual(WATCH.identity(snapshot), before)
        renamed = self.source_root / "Moved identical book.pdf"
        self.source.rename(renamed)
        self.source = self.watcher.source_path = renamed
        self.settle()
        self.assertEqual(self.watcher.candidate, sha, self.output.getvalue())
        self.assertEqual(self.watcher.records[sha]["snapshot"], list(WATCH.identity(snapshot)))
        self.assertEqual(self.watcher.records[sha]["source"]["path"], str(renamed))
        self.assertEqual(WATCH.read_json(self.watcher.catalog / "status.json")["phase"], "ready")
        self.assertFalse(self.watcher.launched)

    def test_restart_revalidates_restored_edition_and_refreshes_transport_once(self):
        sha = self.adopt_current()
        snapshot = self.watcher.versions / sha / "book.pdf"
        manifest = self.settings.preview_root / sha / "manifest.json"
        original = self.watcher.current_config()
        replace_fixture_file(snapshot)
        replace_fixture_file(manifest)
        self.watcher.close()
        self.watcher = self.make_watcher()
        clones = self.clone_mock.call_count
        checked = WATCH.PUBLISHER.checked_asset
        with mock.patch.object(WATCH.PUBLISHER, "checked_asset", wraps=checked) as verified, \
                mock.patch.object(WATCH.PUBLISHER, "publish", side_effect=AssertionError("unexpected republish")), \
                mock.patch.object(WATCH, "http_pdf", return_value={"size": self.source.stat().st_size, "etag": '"restored"'}):
            self.settle()
            paths = [call.args[2]["path"] for call in verified.call_args_list]
            self.assertEqual(paths.count("book.pdf"), 1, self.output.getvalue())
            self.assertEqual(len(paths), 1 + 3 * len(WATCH.PRODUCER.TIERS), "a restored manifest revalidates its bounded assets")
            config = self.watcher.current_config()
            self.assertEqual(config["previews"]["validator"]["value"], '"restored"')
            self.assertEqual(config["publicationGeneration"], original["publicationGeneration"] + 1)
            self.assertEqual(config["previews"]["manifestRevision"], original["previews"]["manifestRevision"])
            with mock.patch.object(WATCH.hashlib, "sha256", side_effect=AssertionError("unexpected repeat hash")):
                self.watcher.tick()
        self.assertEqual(self.clone_mock.call_count, clones, "recovery does not clone or render the unchanged source")
        self.assertEqual(self.watcher.records[sha]["snapshot"], list(WATCH.identity(snapshot)))
        self.assertEqual(self.watcher.records[sha]["manifest"], list(WATCH.identity(manifest)))
        self.assertEqual(WATCH.read_json(self.watcher.state_path)["records"][sha], self.watcher.records[sha])
        self.assertFalse(self.watcher.launched)

    def test_manifest_metadata_recovery_does_not_rehash_the_unchanged_pdf(self):
        sha = self.adopt_current()
        manifest = self.settings.preview_root / sha / "manifest.json"
        replace_fixture_file(manifest)
        with mock.patch.object(WATCH.PUBLISHER, "checked_asset", wraps=WATCH.PUBLISHER.checked_asset) as verified:
            self.watcher.tick()
        self.assertEqual(len(verified.call_args_list), 3 * len(WATCH.PRODUCER.TIERS), self.output.getvalue())
        self.assertNotIn("book.pdf", [call.args[2]["path"] for call in verified.call_args_list])
        self.assertEqual(self.watcher.records[sha]["manifest"], list(WATCH.identity(manifest)))

    def test_recovered_metadata_retries_interrupted_config_commit_after_restart(self):
        sha = self.adopt_current()
        original_config = self.watcher.config_path.read_bytes()
        replace_fixture_file(self.watcher.versions / sha / "book.pdf")
        writer = WATCH.atomic_json

        def interrupt_config(path, value, *args, **kwargs):
            if Path(path) == self.watcher.config_path:
                raise OSError("fixture interrupted config replacement")
            return writer(path, value, *args, **kwargs)

        with mock.patch.object(WATCH, "http_pdf", return_value={"size": self.source.stat().st_size, "etag": '"restored"'}):
            with mock.patch.object(WATCH, "atomic_json", side_effect=interrupt_config):
                self.watcher.tick()
            self.assertEqual(self.watcher.config_path.read_bytes(), original_config)
            self.watcher.close()
            self.watcher = self.make_watcher()
            self.clock[0] += self.settings.retry_seconds
            with mock.patch.object(WATCH.PUBLISHER, "checked_asset", side_effect=AssertionError("verified metadata was not persisted")):
                self.settle()
            self.assertEqual(self.watcher.current_config()["previews"]["validator"]["value"], '"restored"', self.output.getvalue())
            self.assertEqual(WATCH.read_json(self.watcher.catalog / "status.json")["phase"], "ready")
        self.assertFalse(self.watcher.launched)

    def test_changed_fingerprint_never_adopts_corrupted_pdf_bytes(self):
        sha = self.adopt_current()
        snapshot = self.watcher.versions / sha / "book.pdf"
        before = self.watcher.records[sha]["snapshot"][:]
        original_config = self.watcher.config_path.read_bytes()
        data = snapshot.read_bytes()
        replace_fixture_file(snapshot, data[:-1] + bytes([data[-1] ^ 1]))
        with self.assertRaises((WATCH.Failure, WATCH.PUBLISHER.Failure)):
            self.watcher.advance(sha, self.watcher.resolve())
        self.assertEqual(self.watcher.records[sha]["snapshot"], before)
        self.assertEqual(self.watcher.config_path.read_bytes(), original_config)

    def test_existing_corrupt_candidate_backoff_survives_restart_without_source_rehash(self):
        sha = self.adopt_current()
        snapshot = self.watcher.versions / sha / "book.pdf"
        data = snapshot.read_bytes()
        replace_fixture_file(snapshot, data[:-1] + bytes([data[-1] ^ 1]))
        renamed = self.source_root / "Moved healthy source.pdf"
        self.source.rename(renamed)
        self.source = self.watcher.source_path = renamed
        clones = self.clone_mock.call_count
        with mock.patch.object(WATCH.PUBLISHER, "checked_asset", wraps=WATCH.PUBLISHER.checked_asset) as verified:
            self.settle()
            self.assertEqual(self.watcher.candidate, sha, "a failed retained verification still owns a known SHA candidate")
            self.assertEqual(self.clone_mock.call_count, clones + 1)
            self.assertEqual(verified.call_count, 1)
            retry_at = self.watcher.records[sha]["retryAt"]
            self.assertGreater(retry_at, self.watcher.wall_time())
            self.clock[0] += self.settings.poll_seconds
            self.watcher.tick()
            self.watcher.close()
            self.watcher = self.make_watcher()
            self.settle()
            self.assertEqual(self.watcher.candidate, sha)
            self.assertEqual(self.clone_mock.call_count, clones + 1, "restart retains the verified source-to-SHA association")
            self.assertEqual(verified.call_count, 1, "polls and restart respect the persisted failure deadline")
            self.clock[0] += retry_at - self.watcher.wall_time()
            self.watcher.tick()
            self.assertEqual(verified.call_count, 2, "the next verification occurs once at the retry deadline")
            self.assertEqual(self.clone_mock.call_count, clones + 1, "retry hashes the suspect snapshot, never the healthy source again")
            self.assertGreater(self.watcher.records[sha]["retryAt"], retry_at)
        self.assertFalse(self.watcher.launched)

    def test_changed_fingerprint_never_adopts_a_different_valid_manifest(self):
        sha = self.adopt_current()
        manifest = self.settings.preview_root / sha / "manifest.json"
        before = self.watcher.records[sha]["manifest"][:]
        value = WATCH.read_json(manifest)
        value["pages"][0].update(width=200, height=200)
        WATCH.atomic_json(manifest, value)
        with self.assertRaises((WATCH.Failure, WATCH.PUBLISHER.Failure)):
            self.watcher.advance(sha, self.watcher.resolve())
        self.assertEqual(self.watcher.records[sha]["manifest"], before)

    def test_manifest_recovery_rejects_corrupted_asset_without_accepting_metadata(self):
        sha = self.adopt_current()
        manifest = self.settings.preview_root / sha / "manifest.json"
        before = self.watcher.records[sha]["manifest"][:]
        asset = self.settings.preview_root / sha / WATCH.read_json(manifest)["pages"][0]["assets"][0]["path"]
        data = asset.read_bytes()
        replace_fixture_file(asset, data[:-1] + bytes([data[-1] ^ 1]))
        replace_fixture_file(manifest)
        with self.assertRaises((WATCH.Failure, WATCH.PUBLISHER.Failure)):
            self.watcher.advance(sha, self.watcher.resolve())
        self.assertEqual(self.watcher.records[sha]["manifest"], before)

    def test_restart_resumes_missing_full_phase_from_completed_priority_assets(self):
        self.settle()
        sha = self.watcher.candidate
        atlas(self.settings.work_root / sha, sha, self.source.stat().st_size, pages=(2, 3))
        self.watcher.close()
        self.watcher = self.make_watcher()
        before = self.clone_mock.call_count
        self.settle()
        self.assertEqual(self.clone_mock.call_count, before)
        self.assertEqual(self.watcher.launched, [(sha, "full")])
        self.assertEqual(self.watcher.current(), sha)

    def test_source_change_during_publish_keeps_previous_config(self):
        old_sha = self.adopt_current()
        self.watcher.settings = replace(self.watcher.settings, adopt_atlas=None)
        self.source.write_bytes(b"%PDF-1.4\nnew edition\n")
        self.settle()
        sha = self.watcher.candidate
        atlas(self.settings.work_root / sha, sha, self.source.stat().st_size, pages=(2, 3))
        old_config = self.watcher.config_path.read_bytes()
        publish = WATCH.PUBLISHER.publish

        def change_after_assets(*args, **kwargs):
            result = publish(*args, **kwargs)
            self.source.write_bytes(b"%PDF-1.4\na newer edition arrived\n")
            return result

        self.watcher.child.returncode = 0
        with mock.patch.object(WATCH.PUBLISHER, "publish", side_effect=change_after_assets):
            self.watcher.tick()
        self.assertEqual(self.watcher.config_path.read_bytes(), old_config)
        self.assertEqual(self.watcher.current(), old_sha)
        self.assertTrue((self.settings.preview_root / old_sha / "manifest.json").is_file())

    def test_failed_publisher_preserves_config_and_gate_and_records_retry(self):
        old_sha = self.adopt_current()
        self.watcher.settings = replace(self.watcher.settings, adopt_atlas=None)
        self.source.write_bytes(b"%PDF-1.4\nnew edition\n")
        self.settle()
        sha = self.watcher.candidate
        atlas(self.settings.work_root / sha, sha, self.source.stat().st_size, pages=(2, 3))
        config = self.watcher.config_path.read_bytes()
        self.watcher.child.returncode = 0
        with mock.patch.object(WATCH.PUBLISHER, "publish", side_effect=WATCH.PUBLISHER.Failure("fixture failure")):
            self.watcher.tick()
        self.assertEqual(self.watcher.config_path.read_bytes(), config)
        self.assertTrue((self.watcher.root / "public/config.json").is_file())
        self.assertEqual(self.watcher.current(), old_sha)
        self.assertGreater(self.watcher.records[sha]["retryAt"], self.watcher.wall_time())

    def test_stop_during_asset_publication_keeps_previous_config_and_releases_staging(self):
        self.adopt_current()
        self.watcher.settings = replace(self.watcher.settings, adopt_atlas=None)
        self.source.write_bytes(b"%PDF-1.4\nnew edition\n")
        self.settle()
        sha = self.watcher.candidate
        atlas(self.settings.work_root / sha, sha, self.source.stat().st_size, pages=(2, 3))
        config = self.watcher.config_path.read_bytes()
        original = WATCH.PUBLISHER.copy_asset

        def stop_after_asset(*args, **kwargs):
            result = original(*args, **kwargs)
            self.watcher.stop_event.set()
            return result

        self.watcher.child.returncode = 0
        with mock.patch.object(WATCH.PUBLISHER, "copy_asset", side_effect=stop_after_asset):
            with self.assertRaises(WATCH.Stopping):
                self.watcher.tick()
        self.assertEqual(self.watcher.config_path.read_bytes(), config)
        self.assertFalse(list((self.settings.preview_root / sha).rglob(".publish-*.tmp")))

    def test_transient_resolution_keeps_content_but_confirmed_withdrawal_closes_all_routes(self):
        sha = self.adopt_current()
        config = self.watcher.config_path.read_bytes()
        self.watcher.source_failure = WATCH.Failure("temporary resolver failure")
        self.watcher.tick()
        self.assertTrue((self.watcher.root / f"public/versions/{sha}/book.pdf").is_file())
        self.assertTrue((self.watcher.root / f"public/previews/{sha}/manifest.json").is_file())
        self.watcher.source_failure = WATCH.Withdrawn("native DAV says unavailable")
        self.watcher.tick()
        self.assertFalse((self.watcher.root / "public").exists())
        self.assertEqual(self.watcher.config_path.read_bytes(), config)
        self.assertTrue((self.watcher.versions / sha / "book.pdf").is_file())

    def test_frequent_updates_evict_old_versions_without_waiting_for_grace(self):
        self.watcher.settings = replace(self.watcher.settings, max_snapshot_mib=1)
        editions = []
        for number in range(6):
            editions.append(self.adopt_current(b"%PDF-1.4\n" + bytes([65 + number]) * 400000))
            self.clock[0] += 1
        self.assertLessEqual(len(self.watcher.records), 3)
        self.assertLessEqual(sum(record["size"] for record in self.watcher.records.values()), WATCH.MIB)
        self.assertEqual(self.watcher.current(), editions[-1])
        self.assertIn(editions[-2], self.watcher.records)
        self.assertNotIn(editions[0], self.watcher.records)
        self.assertFalse((self.watcher.versions / editions[0]).exists())
        self.assertFalse((self.settings.preview_root / editions[0]).exists())

    def test_unsupported_reflink_never_falls_back_to_full_copy(self):
        self.clone_mock.side_effect = OSError(errno.EOPNOTSUPP, "fixture has no reflinks")
        self.settle()
        self.assertEqual(list(self.watcher.versions.iterdir()), [])
        self.assertFalse(self.watcher.launched)
        self.assertIsNone(self.watcher.current())

    def test_restart_discards_only_uncommitted_producer_staging_under_its_lock(self):
        self.settle()
        sha = self.watcher.candidate
        self.watcher.stop_child()
        work = self.watcher.work_directory(sha)
        pending = work / ".manifest.pending"
        pending.write_bytes(b"incomplete manifest")
        stale = work / ".motionlab-work-fixture"
        stale.mkdir()
        self.watcher.work_directory(sha)
        self.assertFalse(pending.exists())
        self.assertFalse(stale.exists())
        pending.write_bytes(b"an active producer owns this")
        descriptor = os.open(work / ".motionlab.lock", os.O_RDWR | os.O_CREAT, 0o600)
        try:
            WATCH.fcntl.flock(descriptor, WATCH.fcntl.LOCK_EX | WATCH.fcntl.LOCK_NB)
            with self.assertRaises(WATCH.Failure):
                self.watcher.work_directory(sha)
            self.assertTrue(pending.exists())
        finally:
            os.close(descriptor)

    def test_publisher_crash_staging_is_reclaimed_before_publication(self):
        sha = checksum(self.source.read_bytes())
        folder = self.settings.preview_root / sha / "assets"
        folder.mkdir(parents=True)
        pending = folder / (".publish-" + "a" * 32 + ".tmp")
        pending.write_bytes(b"incomplete asset")
        self.adopt_current()
        self.assertFalse(pending.exists())

    def test_atlas_without_region_capability_is_not_adopted_as_complete(self):
        sha = checksum(self.source.read_bytes())
        value = atlas(self.seed, sha, self.source.stat().st_size)
        for page in value["pages"]:
            page.pop("imageRegions")
        WATCH.atomic_json(self.seed / "manifest.json", value)
        self.watcher.settings = replace(self.watcher.settings, adopt_atlas=self.seed)
        self.settle()
        self.assertEqual(self.watcher.launched, [(sha, "priority")])
        self.assertIsNone(self.watcher.current())

    def test_single_service_lock_and_atomic_config_failure(self):
        other = FixtureWatcher(self.settings, self.source, self.clock)
        with self.assertRaisesRegex(WATCH.Failure, "Another watcher"):
            other.open()
        other.close()
        before = self.watcher.config_path.read_bytes()
        original_replace = WATCH.os.replace

        def fail_config(source, destination):
            if Path(destination) == self.watcher.config_path:
                raise OSError("fixture interrupted rename")
            return original_replace(source, destination)

        with mock.patch.object(WATCH.os, "replace", side_effect=fail_config):
            with self.assertRaises(OSError):
                WATCH.atomic_json(self.watcher.config_path, {"new": "complete replacement"})
        self.assertEqual(self.watcher.config_path.read_bytes(), before)
        self.assertFalse(list(self.watcher.catalog.glob(".watch-*")))

    @unittest.skipUnless(importlib.util.find_spec("fitz"), "Existing PyMuPDF runtime is required")
    def test_real_tiny_pdf_inspector_priority_and_full_cli_contract(self):
        import fitz
        self.watcher.close()
        with fitz.open() as document:
            for _ in range(3):
                page = document.new_page(width=100, height=100)
                page.draw_rect(fitz.Rect(10, 10, 90, 90), fill=(.2, .4, .8))
            document.save(self.source)
        self.watcher = self.make_watcher(real_renderer=True)
        self.settle()
        self.assertEqual(self.watcher.child_phase, "priority", self.output.getvalue())
        self.assertEqual(self.watcher.child.wait(timeout=30), 0)
        self.watcher.tick()
        self.assertEqual(self.watcher.child_phase, "full", self.output.getvalue())
        self.assertEqual(self.watcher.child.wait(timeout=30), 0)
        self.watcher.tick()
        self.assertIsNone(self.watcher.child)
        status = WATCH.read_json(self.watcher.catalog / "status.json")
        self.assertEqual((status["phase"], status["readyPages"]), ("ready", 3), self.output.getvalue())


class TransportTest(unittest.TestCase):
    def response(self, status, headers=None, data=b""):
        response = mock.Mock(status=status)
        response.getheader.side_effect = lambda key, default=None: (headers or {}).get(key, default)
        response.read.return_value = data
        return response

    def test_head_and_tiny_if_range_are_exact_and_connections_close(self):
        head = self.response(200, {"Content-Length": "100", "ETag": '"v1"'})
        ranged = self.response(206, {"Content-Length": "16", "Content-Range": "bytes 0-15/100", "ETag": '"v1"'},
                               b"%PDF-1.4\n1234567")
        connections = [mock.Mock(), mock.Mock()]
        connections[0].getresponse.return_value = head
        connections[1].getresponse.return_value = ranged
        with mock.patch.object(WATCH.http.client, "HTTPSConnection", side_effect=connections):
            result = WATCH.http_pdf("https://example.test/book.pdf", expected_size=100, check_range=True)
        self.assertEqual(result, {"size": 100, "etag": '"v1"'})
        self.assertEqual(connections[1].request.call_args.kwargs["headers"]["If-Range"], '"v1"')
        ranged.read.assert_called_once_with(17)
        for connection in connections:
            connection.close.assert_called()

    def test_whole_body_fallback_is_closed_without_reading_and_static_404_is_transient(self):
        head = self.response(200, {"Content-Length": "100", "ETag": '"v1"'})
        whole = self.response(200, {"Content-Length": "100", "ETag": '"v2"'})
        connections = [mock.Mock(), mock.Mock()]
        connections[0].getresponse.return_value = head
        connections[1].getresponse.return_value = whole
        with mock.patch.object(WATCH.http.client, "HTTPSConnection", side_effect=connections):
            with self.assertRaises(WATCH.Failure):
                WATCH.http_pdf("https://example.test/book.pdf", check_range=True)
        whole.read.assert_not_called()
        for guarded in (False, True):
            connection = mock.Mock()
            connection.getresponse.return_value = self.response(404)
            with mock.patch.object(WATCH.http.client, "HTTPSConnection", return_value=connection):
                with self.assertRaises(WATCH.Failure) as caught:
                    WATCH.http_pdf("https://example.test/book.pdf", share_guard=guarded)
            self.assertEqual(isinstance(caught.exception, WATCH.Withdrawn), guarded)


class BtrfsTest(unittest.TestCase):
    @unittest.skipUnless(os.environ.get("SPOMENAR_BTRFS_FIXTURE_ROOT"), "Requires an explicit owned Btrfs fixture root")
    def test_real_cross_subvolume_clone_survives_source_write_and_rename(self):
        root = os.environ["SPOMENAR_BTRFS_FIXTURE_ROOT"]
        source_root = os.environ.get("SPOMENAR_BTRFS_SOURCE_FIXTURE_ROOT", root)
        with tempfile.TemporaryDirectory(prefix="spomenar-watch-fixture-", dir=source_root) as src, \
                tempfile.TemporaryDirectory(prefix="spomenar-watch-fixture-", dir=root) as dst:
            source, target = Path(src) / "source.pdf", Path(dst) / "book.pdf"
            data = b"%PDF-1.4\n" + b"owned fixture" * 1024
            source.write_bytes(data)
            with source.open("rb") as original, target.open("xb") as clone:
                WATCH.fcntl.ioctl(clone.fileno(), WATCH.FICLONE, original.fileno())
            source.write_bytes(b"%PDF-1.4\nreplacement")
            source.rename(Path(src) / "renamed.pdf")
            self.assertEqual(target.read_bytes(), data)


@unittest.skipUnless(shutil.which("nginx"), "Requires the existing nginx executable")
class StaticNginxTest(unittest.TestCase):
    def test_fixed_routes_range_validators_json_changes_and_one_gate(self):
        with tempfile.TemporaryDirectory(prefix="spomenar-nginx-test-") as temporary:
            root = Path(temporary)
            root.chmod(0o755)
            publication, previews = root / "publication", root / "previews"
            catalog = publication / "catalog"
            catalog.mkdir(parents=True)
            previews.mkdir()
            web = root / "web"
            web.mkdir()
            (web / "spomenar-previews").symlink_to(previews, target_is_directory=True)
            (web / "control.txt").write_text("public root control")
            data = b"%PDF-1.4\n" + b"tiny owned PDF fixture" * 512
            sha = checksum(data)
            version = publication / "versions" / sha
            version.mkdir(parents=True)
            (version / "book.pdf").write_bytes(data)
            atlas(previews / sha, sha, len(data), pages=(1,), count=1)
            (catalog / "versions").symlink_to("../versions", target_is_directory=True)
            (catalog / "previews").symlink_to(previews, target_is_directory=True)
            (publication / "public").symlink_to("catalog", target_is_directory=True)
            WATCH.atomic_json(catalog / "config.json", {"edition": "A"})
            WATCH.atomic_json(catalog / "status.json", {"phase": "ready"})
            locations = Path(__file__).with_name("spomenar-watch.nginx.conf").read_text()
            locations = locations.replace("/mnt/btrfs_storage/spomenar-public", str(publication))
            listener = root / "http.sock"
            configuration = root / "nginx.conf"
            configuration.write_text(f"""daemon off;
master_process off;
pid {root / 'nginx.pid'};
error_log {root / 'nginx-error.log'} notice;
events {{ worker_connections 32; }}
http {{
  access_log off;
  types {{ application/pdf pdf; application/json json; image/jpeg jpg; }}
  server {{ listen unix:{listener}; root {web}; {locations} }}
}}
""")
            with (root / "startup.log").open("wb") as errors:
                process = subprocess.Popen([shutil.which("nginx"), "-p", str(root), "-c", str(configuration)],
                                           stdout=subprocess.DEVNULL, stderr=errors)
            try:
                # nginx exposes socket creation as its readiness event; this
                # bounded wait only handles a process which might never start.
                deadline = time.monotonic() + 5
                while not listener.exists() and process.poll() is None and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue(listener.exists(), (root / "startup.log").read_text())

                def request(path, method="GET", headers=None):
                    connection = WATCH.http.client.HTTPConnection("localhost", timeout=3)
                    connection.sock = socket.socket(socket.AF_UNIX)
                    connection.sock.settimeout(3)
                    connection.sock.connect(str(listener))
                    try:
                        connection.request(method, path, headers=headers or {})
                        response = connection.getresponse()
                        return response.status, dict(response.getheaders()), response.read()
                    finally:
                        connection.close()

                pdf = f"/spomenar-versions/{sha}/book.pdf"
                status, headers, body = request(pdf, "HEAD")
                self.assertEqual((status, int(headers["Content-Length"]), body), (200, len(data), b""))
                etag = headers["ETag"]
                status, headers, body = request(pdf, headers={"Range": "bytes=0-15", "If-Range": etag,
                                                              "Accept-Encoding": "gzip, br"})
                self.assertEqual((status, body), (206, data[:16]))
                self.assertEqual(headers["Content-Range"], f"bytes 0-15/{len(data)}")
                self.assertNotIn("Content-Encoding", headers)
                self.assertEqual(request(pdf, headers={"Range": "bytes=0-15", "If-Range": '"stale"'})[0], 200)
                os.utime(catalog / "config.json", (1700000000, 1700000000))
                status, first, body = request("/spomenar/config.json")
                self.assertEqual(status, 200)
                self.assertNotIn("ETag", first)
                WATCH.atomic_json(catalog / "config.json", {"edition": "B"})
                os.utime(catalog / "config.json", (1700000000, 1700000000))
                status, _, body = request("/spomenar/config.json", headers={"If-Modified-Since": first["Last-Modified"],
                                                                           "If-None-Match": '"old"'})
                self.assertEqual((status, json.loads(body)), (200, {"edition": "B"}))
                manifest_url = f"/spomenar/previews/{sha}/manifest.json"
                self.assertEqual(request(manifest_url)[0], 200)
                self.assertEqual(request("/control.txt")[0], 200, "the fixture exposes its ordinary document root")
                direct_paths = (f"/spomenar-previews/{sha}/manifest.json", "/spomenar-previews")
                for path in direct_paths:
                    self.assertEqual(request(path)[0], 404, path)
                (publication / "public").unlink()
                for path in (pdf, manifest_url, "/spomenar/config.json", "/spomenar/status.json", *direct_paths):
                    self.assertEqual(request(path)[0], 404, path)
                self.assertIsNone(process.poll(), "gate changes must not reload or stop nginx")
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


if __name__ == "__main__":
    unittest.main()
