"""Black-box publication tests using only private temporary preview directories."""

from __future__ import annotations

import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from PIL import Image


SCRIPT = Path(__file__).with_name("publish-spomenar-previews.py")
MIB = 1024 * 1024


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def snapshot(root: Path):
    if not root.exists():
        return {}
    return {str(path.relative_to(root)): ("symlink", os.readlink(path)) if path.is_symlink()
            else ("file", path.read_bytes())
            for path in root.rglob("*") if path.is_symlink() or path.is_file()}


class PublishSpomenarPreviewsTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="publish-spomenar-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.generated = self.root / "generated"
        self.generated.mkdir()
        self.web = self.root / "web"
        self.sha = digest(b"the source identity is supplied by the generated manifest")
        self.namespace = self.web / self.sha
        self.value = {"version": 1, "document": {"key": "sha256:" + self.sha,
                      "sha256": self.sha, "size": 12345, "pageCount": 2}, "pages": []}
        for page, color in ((1, (180, 35, 20)), (2, (20, 80, 190))):
            self.value["pages"].append({"pageNumber": page, "width": 120, "height": 80,
                                       "rotation": 0, "assets": [self.make_asset(page, color)],
                                       "imageRegions": [{"id": "image-1", "x": .1, "y": .1,
                                                         "width": .3, "height": .2}]})
        self.original = self.write_manifest(self.value)

    def make_asset(self, page, color):
        stream = io.BytesIO()
        Image.new("RGB", (192, 128), color).save(stream, format="JPEG", quality=85)
        data = stream.getvalue()
        checksum = digest(data)
        relative = f"assets/p{page}-192-{checksum}.jpg"
        target = self.generated / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        return {"path": relative, "width": 192, "height": 128, "bytes": len(data),
                "sha256": checksum, "mime": "image/jpeg"}

    def write_manifest(self, value):
        data = (json.dumps(value, indent=2) + "\n").encode()
        (self.generated / "manifest.json").write_bytes(data)
        return data

    def arguments(self, *options, generated=None, web_root=None, expected_sha=None,
                  omit_web_root=False, omit_sha=False):
        arguments = [str(generated or self.generated)]
        if not omit_web_root:
            arguments += ["--web-root", str(web_root or self.web)]
        if not omit_sha:
            arguments += ["--sha256", self.sha if expected_sha is None else expected_sha]
        return arguments + list(options)

    def run_cli(self, *options, environment=None, umask=-1, **kwargs):
        before = snapshot(self.generated)
        child_environment = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
        child_environment.update(environment or {})
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), *self.arguments(*options, **kwargs)],
                                cwd=self.root, env=child_environment, umask=umask,
                                capture_output=True, text=True, timeout=20, check=False)
        self.assertEqual(snapshot(self.generated), before, "publication changed generated source files")
        events = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        errors = []
        for line in result.stderr.splitlines():
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                errors.append(value)
        detail = f"exit={result.returncode}\nstdout={result.stdout[-2500:]}\nstderr={result.stderr[-2500:]}"
        self.assertTrue(events or errors, "publication emitted no JSON result\n" + detail)
        return result, events, errors, detail

    def complete(self, *options, **kwargs):
        result, events, errors, detail = self.run_cli(*options, **kwargs)
        self.assertEqual(result.returncode, 0, detail)
        self.assertFalse(errors, detail)
        self.assertEqual(events[-1].get("event"), "complete", detail)
        return events

    def rejected(self, *options, **kwargs):
        result, events, errors, detail = self.run_cli(*options, **kwargs)
        self.assertEqual(result.returncode, 2, detail)
        self.assertTrue(any(error.get("event") == "error" for error in errors), detail)
        self.assertFalse(any(event.get("event") == "complete" for event in events), detail)
        return events

    def assert_published(self, expected=None, namespace=None):
        namespace = namespace or self.namespace
        self.assertEqual((namespace / "manifest.json").read_bytes(), expected or self.original)
        manifest = json.loads((namespace / "manifest.json").read_bytes())
        for page in manifest["pages"]:
            for asset in page["assets"]:
                data = (namespace / asset["path"]).read_bytes()
                self.assertEqual(len(data), asset["bytes"])
                self.assertEqual(digest(data), asset["sha256"])
                self.assertEqual(data, (self.generated / asset["path"]).read_bytes())

    def assert_no_staging_files(self, root=None, allowed=None):
        root = root or self.namespace
        allowed = set(allowed or ()) | {"manifest.json", ".publish.lock"}
        allowed.update(asset["path"] for page in self.value["pages"] for asset in page["assets"])
        self.assertLessEqual(set(snapshot(root)), allowed, "temporary publication files remain")
        allowed_directories = {str(parent) for name in allowed for parent in Path(name).parents if str(parent) != "."}
        directories = {str(path.relative_to(root)) for path in root.rglob("*") if path.is_dir()}
        self.assertLessEqual(directories, allowed_directories, "temporary publication directories remain")

    def test_copies_valid_previews_and_preserves_exact_manifest_bytes(self):
        events = self.complete()
        self.assert_published()
        self.assertEqual(sum(event.get("event") == "asset" for event in events), 2)
        self.assertEqual(list(self.generated.glob("*.pdf")), [])
        self.assert_no_staging_files()

    def test_republication_reuses_verified_immutable_assets(self):
        self.complete()
        paths = [self.namespace / asset["path"] for page in self.value["pages"] for asset in page["assets"]]
        before = {path: (path.stat().st_ino, path.stat().st_mtime_ns, path.read_bytes()) for path in paths}
        self.complete()
        self.assertEqual({path: (path.stat().st_ino, path.stat().st_mtime_ns, path.read_bytes()) for path in paths}, before)
        self.assert_published()
        self.assert_no_staging_files()

    def test_uppercase_expected_hash_selects_lowercase_namespace(self):
        self.complete(expected_sha=self.sha.upper())
        self.assert_published()
        self.assertFalse((self.web / self.sha.upper()).exists())

    def test_source_equal_to_destination_namespace_is_rejected_unchanged(self):
        with tempfile.TemporaryDirectory(prefix="publish-spomenar-overlap-") as directory:
            web = Path(directory) / "web"
            web.mkdir(mode=0o700)
            source = web / self.sha
            self.generated.replace(source)
            for path in (source, *source.rglob("*")):
                path.chmod(0o700 if path.is_dir() else 0o600)
            before = snapshot(source)
            modes = {str(path.relative_to(web)): stat.S_IMODE(path.stat().st_mode)
                     for path in (web, source, *source.rglob("*"))}
            result = subprocess.run(
                [sys.executable, "-B", str(SCRIPT), str(source), "--web-root", str(web), "--sha256", self.sha],
                capture_output=True, text=True, timeout=20, check=False)
            self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
            errors = [json.loads(line) for line in result.stderr.splitlines() if line.strip()]
            self.assertTrue(any(error.get("event") == "error" for error in errors))
            self.assertEqual(snapshot(source), before, "rejection must not add a lock or staging files")
            self.assertEqual({str(path.relative_to(web)): stat.S_IMODE(path.stat().st_mode)
                              for path in (web, source, *source.rglob("*"))}, modes)

    def test_requires_explicit_destination_and_sha(self):
        for options in ({"omit_web_root": True}, {"omit_sha": True}, {"web_root": Path("relative-web")},
                        {"expected_sha": "not-a-sha256"}):
            with self.subTest(options=options):
                self.rejected(**options)
                self.assertFalse(self.namespace.exists())

    def test_identity_and_key_mismatches_preserve_published_namespace(self):
        self.complete()
        before = snapshot(self.namespace)
        variants = []
        for field, bad in (("key", "sha256:" + "0" * 64), ("key", "another-key"),
                           ("sha256", "0" * 64), ("sha256", self.sha.upper())):
            value = copy.deepcopy(self.value)
            value["document"][field] = bad
            variants.append(value)
        for value in variants:
            with self.subTest(document=value["document"]):
                self.write_manifest(value)
                self.rejected()
                self.assertEqual(snapshot(self.namespace), before)
        self.write_manifest(self.value)
        self.rejected(expected_sha="f" * 64)
        self.assertEqual(snapshot(self.namespace), before)

    def test_asset_byte_count_and_digest_failures_leave_old_manifest_and_no_staging(self):
        self.complete()
        before = snapshot(self.namespace)
        original = copy.deepcopy(self.value)
        for field, bad in (("bytes", original["pages"][1]["assets"][0]["bytes"] + 1), ("sha256", "f" * 64)):
            with self.subTest(field=field):
                value = copy.deepcopy(original)
                value["pages"][1]["assets"] = [self.make_asset(2, (40, 140, 60))]
                if field == "bytes":
                    bad = value["pages"][1]["assets"][0]["bytes"] + 1
                value["pages"][1]["assets"][0][field] = bad
                self.write_manifest(value)
                self.rejected()
                self.assertEqual(snapshot(self.namespace), before)
                self.assert_no_staging_files()

    def test_mismatched_existing_immutable_asset_is_not_overwritten(self):
        self.complete()
        asset = self.namespace / self.value["pages"][0]["assets"][0]["path"]
        asset.write_bytes(b"x" * asset.stat().st_size)
        before = snapshot(self.namespace)
        self.rejected()
        self.assertEqual(snapshot(self.namespace), before)

    def test_reused_hardlinked_asset_and_empty_lock_preserve_private_modes(self):
        asset = self.value["pages"][0]["assets"][0]
        target = self.namespace / asset["path"]
        target.parent.mkdir(parents=True)
        private_asset = self.root / "private-image.jpg"
        private_asset.write_bytes((self.generated / asset["path"]).read_bytes())
        private_asset.chmod(0o600)
        os.link(private_asset, target)
        private_lock = self.root / "private-empty-lock"
        private_lock.write_bytes(b"")
        private_lock.chmod(0o600)
        os.link(private_lock, self.namespace / ".publish.lock")
        originals = {path: (path.stat().st_ino, stat.S_IMODE(path.stat().st_mode), path.read_bytes())
                     for path in (private_asset, private_lock)}
        self.complete()
        self.assert_published()
        self.assertEqual({path: (path.stat().st_ino, stat.S_IMODE(path.stat().st_mode), path.read_bytes())
                          for path in originals}, originals)
        self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.namespace / ".publish.lock").stat().st_mode), 0o600)
        self.assert_no_staging_files()

    def test_nonempty_hardlinked_lock_is_rejected_without_changing_private_file(self):
        self.complete()
        lock = self.namespace / ".publish.lock"
        lock.unlink()
        private = self.root / "private-lock-data"
        private.write_bytes(b"this file is not a publication lock")
        private.chmod(0o600)
        os.link(private, lock)
        before = snapshot(self.namespace)
        identity = (private.stat().st_ino, private.stat().st_mtime_ns, private.stat().st_ctime_ns,
                    stat.S_IMODE(private.stat().st_mode), private.read_bytes())
        self.rejected()
        self.assertEqual(snapshot(self.namespace), before)
        self.assertEqual((private.stat().st_ino, private.stat().st_mtime_ns, private.stat().st_ctime_ns,
                          stat.S_IMODE(private.stat().st_mode), private.read_bytes()), identity)
        self.assert_no_staging_files()

    def test_namespace_update_retains_old_assets_and_unrelated_directories(self):
        self.complete()
        old_assets = {asset["path"]: (self.namespace / asset["path"]).read_bytes()
                      for page in self.value["pages"] for asset in page["assets"]}
        unrelated = self.web / "unrelated" / "keep.txt"
        unrelated.parent.mkdir()
        unrelated.write_bytes(b"keep this namespace")
        other_namespace = self.web / ("0" * 64)
        other_namespace.mkdir()
        (other_namespace / "existing.json").write_bytes(b"unrelated prior deployment")
        unaffected = {str(unrelated): unrelated.read_bytes(),
                      str(other_namespace / "existing.json"): (other_namespace / "existing.json").read_bytes()}
        self.value["pages"] = [self.value["pages"][0]]
        self.value["pages"][0]["assets"] = [self.make_asset(1, (90, 150, 30))]
        expected = self.write_manifest(self.value)
        self.complete()
        self.assert_published(expected)
        for name, data in old_assets.items():
            self.assertEqual((self.namespace / name).read_bytes(), data)
        for name, data in unaffected.items():
            self.assertEqual(Path(name).read_bytes(), data)
        self.assert_no_staging_files(allowed=old_assets)

    def test_asset_paths_must_be_canonical_relative_paths(self):
        self.complete()
        before = snapshot(self.namespace)
        asset = self.value["pages"][0]["assets"][0]
        outside = self.root / "outside.jpg"
        outside.write_bytes((self.generated / asset["path"]).read_bytes())
        name = Path(asset["path"]).name
        for unsafe in ("../outside.jpg", str(outside), "assets//" + name, "assets/./" + name,
                       "./" + asset["path"], "assets\\" + name, "assets/../assets/" + name):
            with self.subTest(path=unsafe):
                value = copy.deepcopy(self.value)
                value["pages"][0]["assets"][0]["path"] = unsafe
                self.write_manifest(value)
                self.rejected()
                self.assertEqual(snapshot(self.namespace), before)

    def test_source_asset_and_parent_symlinks_are_rejected(self):
        self.complete()
        before = snapshot(self.namespace)
        asset = self.generated / self.value["pages"][0]["assets"][0]["path"]
        outside = self.root / "outside.jpg"
        asset.replace(outside)
        asset.symlink_to(outside)
        self.rejected()
        self.assertEqual(snapshot(self.namespace), before)
        asset.unlink()
        outside.replace(asset)
        directory = self.generated / "assets"
        outside_directory = self.root / "outside-assets"
        directory.replace(outside_directory)
        directory.symlink_to(outside_directory, target_is_directory=True)
        self.rejected()
        self.assertEqual(snapshot(self.namespace), before)

    def test_source_manifest_and_root_symlinks_are_rejected(self):
        self.complete()
        before = snapshot(self.namespace)
        manifest = self.generated / "manifest.json"
        outside = self.root / "outside-manifest.json"
        manifest.replace(outside)
        manifest.symlink_to(outside)
        self.rejected()
        self.assertEqual(snapshot(self.namespace), before)
        manifest.unlink()
        outside.replace(manifest)
        alias = self.root / "source-alias"
        alias.symlink_to(self.generated, target_is_directory=True)
        self.rejected(generated=alias)
        self.assertEqual(snapshot(self.namespace), before)

    def test_destination_root_namespace_and_asset_directory_symlinks_are_rejected(self):
        for kind in ("root", "namespace", "asset-directory"):
            with self.subTest(kind=kind):
                web = self.root / ("web-" + kind)
                outside = self.root / ("outside-" + kind)
                outside.mkdir()
                (outside / "keep.txt").write_bytes(b"unchanged")
                if kind == "root":
                    web.symlink_to(outside, target_is_directory=True)
                else:
                    web.mkdir()
                    if kind == "namespace":
                        (web / self.sha).symlink_to(outside, target_is_directory=True)
                    else:
                        (web / self.sha).mkdir()
                        (web / self.sha / "assets").symlink_to(outside, target_is_directory=True)
                before = snapshot(outside)
                self.rejected(web_root=web)
                self.assertEqual(snapshot(outside), before)

    def test_destination_manifest_asset_and_lock_symlinks_are_rejected(self):
        self.complete()
        for name in ("manifest.json", self.value["pages"][0]["assets"][0]["path"], ".publish.lock"):
            with self.subTest(name=name):
                file = self.namespace / name
                outside = self.root / "outside-destination"
                original = file.read_bytes()
                file.replace(outside)
                file.symlink_to(outside)
                before = snapshot(self.namespace)
                self.rejected()
                self.assertEqual(snapshot(self.namespace), before)
                self.assertEqual(outside.read_bytes(), original)
                file.unlink()
                outside.replace(file)

    def test_duplicate_asset_paths_are_rejected_without_publication(self):
        value = copy.deepcopy(self.value)
        value["pages"][1]["assets"] = [copy.deepcopy(value["pages"][0]["assets"][0])]
        self.write_manifest(value)
        self.rejected()
        self.assertFalse((self.namespace / "manifest.json").exists())

    def test_metadata_type_geometry_and_count_bounds_preserve_old_manifest(self):
        self.complete()
        before = snapshot(self.namespace)
        variants = []
        for label, fields, bad in (("boolean-version", ("version",), True),
                                   ("too-many-pages", ("document", "pageCount"), 10001),
                                   ("boolean-size", ("document", "size"), True),
                                   ("zero-width", ("pages", 0, "width"), 0),
                                   ("boolean-rotation", ("pages", 0, "rotation"), False),
                                   ("invalid-mime", ("pages", 0, "assets", 0, "mime"), "text/html"),
                                   ("oversized-asset", ("pages", 0, "assets", 0, "bytes"), 4 * MIB + 1)):
            value = copy.deepcopy(self.value)
            cursor = value
            for field in fields[:-1]:
                cursor = cursor[field]
            cursor[fields[-1]] = bad
            variants.append((label, value))
        value = copy.deepcopy(self.value)
        value["pages"][0]["imageRegions"] = [{"id": f"image-{number}", "x": 0, "y": 0,
                                              "width": .1, "height": .1} for number in range(257)]
        variants.append(("too-many-regions", value))
        for label, value in variants:
            with self.subTest(label=label):
                self.write_manifest(value)
                self.rejected()
                self.assertEqual(snapshot(self.namespace), before)

    def test_manifest_byte_limit_is_enforced_before_publication(self):
        (self.generated / "manifest.json").write_bytes(self.original + b" " * (4 * MIB))
        self.rejected()
        self.assertFalse((self.namespace / "manifest.json").exists())

    def test_referenced_asset_budget_preserves_old_manifest(self):
        self.complete()
        before = snapshot(self.namespace)
        total = sum(asset["bytes"] for page in self.value["pages"] for asset in page["assets"])
        self.rejected("--max-assets-mib", str((total - 1) / MIB))
        self.assertEqual(snapshot(self.namespace), before)
        self.complete("--max-assets-mib", str(total / MIB))

    def test_invalid_budget_and_deadline_are_structured_errors(self):
        for option, value in (("--max-assets-mib", "0"), ("--max-assets-mib", "nan"),
                              ("--deadline-seconds", "0"), ("--deadline-seconds", "inf")):
            with self.subTest(option=option, value=value):
                self.rejected(option, value)
                self.assertFalse((self.namespace / "manifest.json").exists())

    def test_new_publication_permissions_override_restrictive_umask(self):
        self.complete(umask=0o077)
        for directory in (self.web, self.namespace, self.namespace / "assets"):
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o755, str(directory))
        for file in self.namespace.rglob("*"):
            if file.is_file():
                self.assertEqual(stat.S_IMODE(file.stat().st_mode), 0o644, str(file))
        self.assert_no_staging_files()

    def test_publisher_needs_no_pdf_or_image_libraries(self):
        blocked = self.root / "without-image-libraries"
        blocked.mkdir()
        (blocked / "sitecustomize.py").write_text(
            "import builtins\n"
            "_original_import = builtins.__import__\n"
            "def _stdlib_only(name, *args, **kwargs):\n"
            "    if name.split('.')[0] in ('fitz', 'pymupdf', 'PIL'):\n"
            "        raise ImportError('image library forbidden in publisher test')\n"
            "    return _original_import(name, *args, **kwargs)\n"
            "builtins.__import__ = _stdlib_only\n")
        self.complete(environment={"PYTHONPATH": str(blocked)})
        self.assert_published()

    def reading_manifest(self):
        def asset(data, suffix):
            checksum = digest(data)
            relative = f"reading/{checksum}.{suffix}"
            target = self.generated / relative
            target.parent.mkdir(exist_ok=True)
            target.write_bytes(data)
            return {"path": relative, "bytes": len(data), "sha256": checksum}
        data = b"\xff\xd8first-complete-scan\xff\xc4second-complete-scan\xff\xd9"
        split = data.index(b"second")
        image = {**asset(data, "jpg"), "id": "x17", "originalSha256": digest(b"original jpeg"),
                 "width": 96, "height": 64, "components": 3, "encoding": "progressive-jpeg",
                 "coefficientBytes": 24704, "chunks": [
                     {"offset": 0, "bytes": split, "sha256": digest(data[:split]), "scan": 1},
                     {"offset": split, "bytes": len(data) - split, "sha256": digest(data[split:]), "scan": 2}]}
        value = {"version": 1, "source": {"sha256": self.sha, "size": 12345, "pageCount": 2},
                 "pdf": asset(b"%PDF-1.7\nsmall structural document\n", "pdf"), "images": [image]}
        payload = (json.dumps(value) + "\n").encode()
        (self.generated / "reading.json").write_bytes(payload)
        return value, payload

    def test_reading_publication_preserves_atlas_and_commits_verified_snapshot_last(self):
        self.complete()
        value, payload = self.reading_manifest()
        spec = importlib.util.spec_from_file_location("reading_publication_snapshot", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        observed = []
        def emit(event, **fields):
            if event == "asset":
                self.assertFalse((self.namespace / "reading.json").exists())
                self.assertEqual((self.namespace / "manifest.json").read_bytes(), self.original)
                observed.append(fields["path"])
                (self.generated / "reading.json").write_text('{"replaced":true}')
        with mock.patch.object(module, "emit", side_effect=emit):
            self.assertEqual(module.main(self.arguments("--reading")), 0)
        self.assertEqual(len(observed), 2)
        self.assertEqual((self.namespace / "reading.json").read_bytes(), payload)
        for asset in [value["pdf"], *value["images"]]:
            self.assertEqual((self.namespace / asset["path"]).read_bytes(),
                             (self.generated / asset["path"]).read_bytes())
        self.assertEqual((self.namespace / "manifest.json").read_bytes(), self.original)

    def test_reading_chunk_checksum_failure_does_not_replace_previous_manifest(self):
        value, payload = self.reading_manifest()
        self.complete("--reading")
        value["images"][0]["chunks"][0]["sha256"] = "0" * 64
        (self.generated / "reading.json").write_text(json.dumps(value))
        self.rejected("--reading")
        self.assertEqual((self.namespace / "reading.json").read_bytes(), payload)
        self.assertFalse(list(self.namespace.rglob(".publish-*.tmp")))

    def test_reading_source_partition_and_budget_reject_before_publication(self):
        value, _ = self.reading_manifest()
        for mutation in (lambda v: v["source"].update(sha256="0" * 64),
                         lambda v: v["images"][0]["chunks"][1].update(offset=1)):
            changed = copy.deepcopy(value)
            mutation(changed)
            (self.generated / "reading.json").write_text(json.dumps(changed))
            self.rejected("--reading")
            self.assertFalse(self.namespace.exists())
        self.reading_manifest()
        total = value["pdf"]["bytes"] + value["images"][0]["bytes"]
        self.rejected("--reading", "--max-assets-mib", str((total - 1) / MIB))
        self.assertFalse(self.namespace.exists())

    def test_input_manifest_snapshot_stays_original_and_is_published_last(self):
        spec = importlib.util.spec_from_file_location("spomenar_publisher_snapshot_test", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        original_emit = module.emit
        events = []
        replacement = copy.deepcopy(self.value)
        replacement["document"]["key"] = "manifest-replaced-during-publication"

        def emit(event, **values):
            if event == "asset":
                self.assertFalse((self.namespace / "manifest.json").exists(), "manifest appeared before the final asset")
                if not events:
                    self.write_manifest(replacement)
                events.append(values)
            original_emit(event, **values)

        module.emit = emit
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = module.main(self.arguments())
        self.assertEqual(result, 0, stdout.getvalue() + stderr.getvalue())
        self.assertEqual(len(events), 2)
        self.assertNotEqual((self.generated / "manifest.json").read_bytes(), self.original)
        self.assert_published(self.original)
        self.assert_no_staging_files()

    def test_atomic_manifest_replacement_during_first_read_publishes_held_snapshot(self):
        spec = importlib.util.spec_from_file_location("spomenar_publisher_read_snapshot_test", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        manifest = self.generated / "manifest.json"
        # Valid JSON whitespace makes the original span more than one bounded read.
        original = self.original + b" " * (MIB + 23)
        manifest.write_bytes(original)
        old_info = manifest.stat()
        next_value = copy.deepcopy(self.value)
        next_value["pages"][0]["imageRegions"].append(
            {"id": "image-2", "x": .6, "y": .6, "width": .2, "height": .2})
        replacement = (json.dumps(next_value, indent=2) + "\n").encode()
        prepared = self.root / "next-manifest.json"
        prepared.write_bytes(replacement)
        original_read = os.read
        replaced = []

        def replace_after_first_chunk(descriptor, count):
            block = original_read(descriptor, count)
            info = os.fstat(descriptor)
            if block and not replaced and (info.st_dev, info.st_ino) == (old_info.st_dev, old_info.st_ino):
                os.replace(prepared, manifest)
                replaced.append(len(block))
            return block

        stdout, stderr = io.StringIO(), io.StringIO()
        with mock.patch.object(module.os, "read", replace_after_first_chunk), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            result = module.main(self.arguments())
        self.assertEqual(result, 0, stdout.getvalue() + stderr.getvalue())
        self.assertEqual(len(replaced), 1)
        self.assertGreater(replaced[0], 0)
        self.assertLess(replaced[0], len(original), "the replacement must happen between snapshot chunks")
        self.assertEqual(manifest.read_bytes(), replacement)
        self.assert_published(original)
        self.assert_no_staging_files()

    @unittest.skipUnless(os.name == "posix", "POSIX signals are required")
    def test_sigterm_immediately_after_temporary_open_cleans_owned_file(self):
        self.complete()
        before = snapshot(self.namespace)
        self.value["pages"][0]["assets"] = [self.make_asset(1, (60, 110, 30))]
        self.write_manifest(self.value)
        source_before = snapshot(self.generated)
        launcher = (
            "import contextlib, importlib.util, os, signal, sys\n"
            "spec = importlib.util.spec_from_file_location('publisher_acquisition_signal_test', sys.argv[1])\n"
            "module = importlib.util.module_from_spec(spec)\n"
            "spec.loader.exec_module(module)\n"
            "original_open = os.open\n"
            "opened = []\n"
            "def interrupt_after_open(name, flags, *args, **kwargs):\n"
            "    descriptor = original_open(name, flags, *args, **kwargs)\n"
            "    if not opened and isinstance(name, str) and name.startswith('.publish-') and flags & os.O_EXCL:\n"
            "        opened.append(descriptor)\n"
            "        os.kill(os.getpid(), signal.SIGTERM)\n"
            "    return descriptor\n"
            "os.open = interrupt_after_open\n"
            "try:\n"
            "    result = module.main(sys.argv[2:])\n"
            "    assert opened, 'temporary-file acquisition hook did not run'\n"
            "    for descriptor in opened:\n"
            "        try:\n"
            "            os.fstat(descriptor)\n"
            "        except OSError:\n"
            "            pass\n"
            "        else:\n"
            "            raise AssertionError('temporary descriptor remained open')\n"
            "finally:\n"
            "    os.open = original_open\n"
            "    for descriptor in opened:\n"
            "        with contextlib.suppress(OSError):\n"
            "            os.close(descriptor)\n"
            "raise SystemExit(result)\n")
        result = subprocess.run([sys.executable, "-B", "-c", launcher, str(SCRIPT), *self.arguments()],
                                capture_output=True, text=True, timeout=20, start_new_session=True, check=False)
        self.assertEqual(result.returncode, 143, result.stdout + result.stderr)
        errors = [json.loads(line) for line in result.stderr.splitlines() if line.strip()]
        self.assertTrue(any(error.get("event") == "error" for error in errors))
        self.assertEqual(snapshot(self.namespace), before)
        self.assertEqual(snapshot(self.generated), source_before)
        self.assert_no_staging_files(allowed=before)

    @unittest.skipUnless(os.name == "posix", "POSIX signals are required")
    def test_signals_preserve_old_manifest_and_remove_temporary_files(self):
        self.complete()
        old_manifest = (self.namespace / "manifest.json").read_bytes()
        old_paths = set(snapshot(self.namespace))
        launcher = (
            "import importlib.util, os, signal, sys\n"
            "spec = importlib.util.spec_from_file_location('publisher_signal_test', sys.argv[1])\n"
            "module = importlib.util.module_from_spec(spec)\n"
            "spec.loader.exec_module(module)\n"
            "original_emit = module.emit\n"
            "def emit(event, **values):\n"
            "    original_emit(event, **values)\n"
            "    if event == 'asset':\n"
            "        os.kill(os.getpid(), int(sys.argv[2]))\n"
            "module.emit = emit\n"
            "raise SystemExit(module.main(sys.argv[3:]))\n")
        for sent, expected in ((signal.SIGTERM, 143), (signal.SIGINT, 130)):
            with self.subTest(signal=sent):
                self.value["pages"][0]["assets"] = [self.make_asset(1, (40, 160, int(sent)))]
                self.write_manifest(self.value)
                result = subprocess.run([sys.executable, "-B", "-c", launcher, str(SCRIPT), str(int(sent)),
                                         *self.arguments()], capture_output=True, text=True, timeout=20,
                                        start_new_session=True, check=False)
                self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
                errors = [json.loads(line) for line in result.stderr.splitlines() if line.strip()]
                self.assertTrue(any(error.get("event") == "error" for error in errors))
                self.assertEqual((self.namespace / "manifest.json").read_bytes(), old_manifest)
                self.assert_no_staging_files(allowed=old_paths)
                old_paths.update(snapshot(self.namespace))


if __name__ == "__main__":
    unittest.main()
