"""Black-box contract tests for the bounded MotionLab PDF preview CLI."""

from __future__ import annotations

import asyncio
import copy
import contextlib
import ctypes
import hashlib
import io
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

import fitz
from PIL import Image


SCRIPT = Path(__file__).with_name("motionlab-previews.py")
MIB = 1024 * 1024


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_state(path: Path) -> tuple:
    stat = path.stat()
    return (stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns, sha256(path))


def solid_image() -> bytes:
    data = io.BytesIO()
    Image.new("RGB", (20, 10), (20, 200, 40)).save(data, format="PNG")
    return data.getvalue()


def make_pdf(path: Path, pages: int = 2) -> None:
    with fitz.open() as document:
        for number in range(pages):
            page = document.new_page(width=120, height=80)
            page.draw_rect(fitz.Rect(0, 0, 60, 80), color=None, fill=(1, 0, 0))
            page.draw_rect(fitz.Rect(60, 0, 120, 80), color=None, fill=(0, 0, 1))
            page.insert_text((8, 40), f"Page {number + 1}", fontsize=8)
        document.save(path, deflate=True)


def make_cropped_pdf(path: Path, rotations=(0, 90, 180, 270)) -> None:
    image = solid_image()
    with fitz.open() as document:
        for rotation in rotations:
            page = document.new_page(width=300, height=240)
            # Its visible part after cropping is (0, 0, 80, 70) in a 220x180 page.
            # The independent expectations below rotate that clipped rectangle by hand.
            page.insert_image(fitz.Rect(20, 20, 120, 100), stream=image, keep_proportion=False)
            page.set_cropbox(fitz.Rect(40, 30, 260, 210))
            page.set_rotation(rotation)
        document.save(path, deflate=True)


class MotionLabPreviewsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="motionlab-preview-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source.pdf"
        self.output = self.root / "previews"
        make_pdf(self.source)

    def run_cli(self, *options: str, source: Path | None = None,
                output: Path | None = None, omit_output: bool = False,
                environment: dict[str, str] | None = None):
        source = source or self.source
        before = source_state(source)
        command = [sys.executable, "-B", str(SCRIPT), str(source)]
        if not omit_output:
            command += ["--output", str(output or self.output)]
        command += list(options)
        child_environment = dict(os.environ)
        child_environment["PYTHONDONTWRITEBYTECODE"] = "1"
        if environment:
            child_environment.update(environment)
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                env=child_environment, timeout=45, check=False)
        self.assertEqual(source_state(source), before, "the CLI changed its source PDF or metadata")
        events = []
        for line in result.stdout.splitlines():
            if line.strip():
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError as error:
                    self.fail(f"stdout is not JSON lines: {line[:300]!r}: {error}")
        errors = []
        for line in result.stderr.splitlines():
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                errors.append(value)
        detail = f"exit={result.returncode}\nstdout={result.stdout[-3000:]}\nstderr={result.stderr[-3000:]}"
        self.assertTrue(events or errors, "the CLI did not emit a JSON summary\n" + detail)
        return result, events, detail

    def complete(self, *options: str, **kwargs):
        result, events, detail = self.run_cli(*options, **kwargs)
        self.assertEqual(result.returncode, 0, detail)
        self.assertEqual(events[-1].get("event"), "complete", detail)
        return events

    def rejected(self, *options: str, **kwargs):
        result, events, detail = self.run_cli(*options, **kwargs)
        self.assertIn(result.returncode, (1, 2), detail)
        self.assertFalse(any(event.get("event") in ("asset", "complete") for event in events), detail)
        return events

    def manifest(self, output: Path | None = None):
        return json.loads(((output or self.output) / "manifest.json").read_text())

    def output_snapshot(self, output: Path | None = None):
        output = output or self.output
        if not output.exists():
            return {}
        return {str(path.relative_to(output)): ("symlink", os.readlink(path)) if path.is_symlink()
                else ("file", path.read_bytes())
                for path in output.rglob("*") if path.is_symlink() or path.is_file()}

    def validate_manifest(self, source: Path | None = None, output: Path | None = None,
                          key: str | None = None, selected: list[int] | None = None,
                          geometry_delta: float = 1e-5):
        source, output = source or self.source, output or self.output
        manifest = self.manifest(output)
        digest = sha256(source)
        self.assertEqual(manifest["version"], 1)
        identity = manifest["document"]
        self.assertEqual(identity["key"], key or "sha256:" + digest)
        self.assertEqual(identity["sha256"], digest)
        self.assertEqual(identity["size"], source.stat().st_size)
        with fitz.open(source) as document:
            self.assertEqual(identity["pageCount"], len(document))
            numbers = [page["pageNumber"] for page in manifest["pages"]]
            self.assertEqual(len(numbers), len(set(numbers)))
            if selected is not None:
                self.assertCountEqual(numbers, selected)
            for entry in manifest["pages"]:
                page = document[entry["pageNumber"] - 1]
                self.assertAlmostEqual(entry["width"], page.rect.width, delta=geometry_delta)
                self.assertAlmostEqual(entry["height"], page.rect.height, delta=geometry_delta)
                self.assertEqual(entry["rotation"], page.rotation)
                self.assertTrue(entry["assets"])
                for asset in entry["assets"]:
                    relative = PurePosixPath(asset["path"])
                    self.assertFalse(relative.is_absolute())
                    self.assertNotIn("..", relative.parts)
                    self.assertNotIn("\\", asset["path"])
                    file = output / asset["path"]
                    self.assertEqual(os.path.commonpath((output.resolve(), file.resolve())), str(output.resolve()))
                    self.assertEqual(asset["sha256"], sha256(file))
                    self.assertIn(asset["sha256"], file.name, "asset names must address their content")
                    self.assertEqual(asset["bytes"], file.stat().st_size)
                    self.assertEqual(asset["mime"], "image/jpeg")
                    with Image.open(file) as image:
                        self.assertEqual(image.format, "JPEG")
                        self.assertEqual(image.size, (asset["width"], asset["height"]))
                        image.load()
                    self.assertLessEqual(abs(asset["width"] - asset["height"] * entry["width"] / entry["height"]), 2)
                if "imageRegions" in entry:
                    regions = entry["imageRegions"]
                    self.assertLessEqual(len(regions), 256)
                    self.assertEqual(len({region["id"] for region in regions}), len(regions))
                    for region in regions:
                        self.assertGreater(region["width"], 0)
                        self.assertGreater(region["height"], 0)
                        self.assertGreaterEqual(region["x"], 0)
                        self.assertGreaterEqual(region["y"], 0)
                        self.assertLessEqual(region["x"] + region["width"], 1 + 1e-6)
                        self.assertLessEqual(region["y"] + region["height"], 1 + 1e-6)
        return manifest

    def receipt(self, source: Path | None = None, output: Path | None = None, key="receipt-book"):
        source, output = source or self.source, output or self.output
        return {"version": 1, "document": {"key": key, "size": source.stat().st_size,
                "sha256": sha256(source)}, "pdf": source.name, "outputDirectory": str(output.resolve())}

    def write_receipt(self, value) -> Path:
        receipt = self.root / "source-receipt.json"
        receipt.write_text(json.dumps(value))
        return receipt

    def without_pymupdf_environment(self):
        disabled = self.root / "without-pymupdf"
        disabled.mkdir()
        for module in ("fitz", "pymupdf"):
            (disabled / (module + ".py")).write_text("raise ImportError('PyMuPDF unavailable in this CLI test')\n")
        # Model an absent installation for availability checks as well as imports. A fake
        # module alone would advertise a present but broken installation to find_spec.
        (disabled / "sitecustomize.py").write_text(
            "import importlib.util\n"
            "_find_spec = importlib.util.find_spec\n"
            "def _without_pymupdf(name, package=None):\n"
            "    return None if name.split('.')[0] in ('fitz', 'pymupdf') else _find_spec(name, package)\n"
            "importlib.util.find_spec = _without_pymupdf\n"
        )
        return {"PYTHONPATH": str(disabled)}

    def test_manifest_assets_pixels_and_source_identity(self):
        self.source.chmod(0o444)
        self.complete("--tiers", "192,512,768,1536", "--renderer", "pymupdf")
        manifest = self.validate_manifest(selected=[1, 2])
        for page in manifest["pages"]:
            self.assertCountEqual([max(asset["width"], asset["height"]) for asset in page["assets"]],
                                  [192, 512, 768, 1536])
            for asset in page["assets"]:
                with Image.open(self.output / asset["path"]) as image:
                    red = image.convert("RGB").getpixel((image.width // 4, image.height // 4))
                    blue = image.convert("RGB").getpixel((image.width * 3 // 4, image.height // 4))
                    self.assertGreater(red[0], 220)
                    self.assertLess(max(red[1:]), 35)
                    self.assertGreater(blue[2], 220)
                    self.assertLess(max(blue[:2]), 35)

    def test_rotated_nonzero_crop_and_clipped_image_regions(self):
        cropped = self.root / "cropped.pdf"
        make_cropped_pdf(cropped)
        self.complete("--tiers", "192", "--renderer", "pymupdf", "--require-image-regions", source=cropped)
        manifest = self.validate_manifest(source=cropped, selected=[1, 2, 3, 4])
        expected = {
            0: (220, 180, 0, 0, 80, 70),
            90: (180, 220, 110, 0, 70, 80),
            180: (220, 180, 140, 110, 80, 70),
            270: (180, 220, 0, 140, 70, 80),
        }
        clipped_edge = {0: (.02, .2), 90: (.98, .2), 180: (.98, .8), 270: (.2, .98)}
        for page in manifest["pages"]:
            width, height, x, y, region_width, region_height = expected[page["rotation"]]
            self.assertEqual((page["width"], page["height"]), (width, height))
            self.assertEqual(len(page["imageRegions"]), 1)
            region = page["imageRegions"][0]
            for field, value in {"x": x / width, "y": y / height,
                                 "width": region_width / width, "height": region_height / height}.items():
                self.assertAlmostEqual(region[field], value, delta=1e-5, msg=f"rotation {page['rotation']}: {field}")
            with Image.open(self.output / page["assets"][0]["path"]) as image:
                center = (int((x + region_width / 2) / width * image.width),
                          int((y + region_height / 2) / height * image.height))
                edge_x, edge_y = clipped_edge[page["rotation"]]
                for point in (center, (int(edge_x * image.width), int(edge_y * image.height))):
                    color = image.convert("RGB").getpixel(point)
                    self.assertTrue(all(abs(actual - wanted) < 25 for actual, wanted in zip(color, (20, 200, 40))), color)
                outside = image.convert("RGB").getpixel((image.width // 2, image.height // 2))
                self.assertGreater(min(outside), 235)

    def test_priorities_keep_spreads_together_and_small_tiers_first(self):
        many = self.root / "four-pages.pdf"
        make_pdf(many, 4)
        events = self.complete("--pages", "1-4", "--priority-spreads", "3:4", "--priority-pages", "2",
                               "--tiers", "192,512", "--workers", "1", source=many)
        assets = [(event["pageNumber"], event["tier"]) for event in events if event.get("event") == "asset"]
        # Both spread halves get their smallest tier before larger priority assets.
        # The whole explicit-priority pyramid finishes before any background page.
        self.assertEqual(assets, [(3, 192), (4, 192), (2, 192),
                                  (3, 512), (4, 512), (2, 512),
                                  (1, 192), (1, 512)])
        self.validate_manifest(source=many, selected=[1, 2, 3, 4])

    def test_two_workers_preserve_tier_barrier(self):
        events = self.complete("--tiers", "192,512", "--workers", "2")
        assets = [(event["pageNumber"], event["tier"]) for event in events if event.get("event") == "asset"]
        self.assertCountEqual(assets, [(page, tier) for tier in (192, 512) for page in (1, 2)])
        self.assertEqual([tier for _, tier in assets], [192, 192, 512, 512])
        self.validate_manifest(selected=[1, 2])

    def test_each_asset_event_exposes_a_readable_manifest_with_complete_assets(self):
        async def observe():
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-B", str(SCRIPT), str(self.source), "--output", str(self.output),
                "--tiers", "192,512", "--workers", "2",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            errors = asyncio.create_task(process.stderr.read())
            events = []

            async def consume():
                while line := await process.stdout.readline():
                    event = json.loads(line)
                    events.append(event)
                    if event.get("event") != "asset":
                        continue
                    # Workers may finish another asset while this snapshot is read. Every
                    # reference in either atomic manifest version must already be complete.
                    manifest = self.manifest()
                    self.assertEqual(manifest["document"]["sha256"], sha256(self.source))
                    self.assertTrue(manifest["pages"])
                    for page in manifest["pages"]:
                        self.assertTrue(page["assets"])
                        for asset in page["assets"]:
                            file = self.output / asset["path"]
                            self.assertEqual(file.stat().st_size, asset["bytes"])
                            self.assertEqual(sha256(file), asset["sha256"])
                            with Image.open(file) as image:
                                image.verify()
                self.assertEqual(await process.wait(), 0, (await errors).decode())
                return events

            try:
                return await asyncio.wait_for(consume(), 45)
            finally:
                if process.returncode is None:
                    process.send_signal(signal.SIGINT)
                    try:
                        await asyncio.wait_for(process.wait(), 5)
                    except asyncio.TimeoutError:
                        process.kill()
                        await process.wait()
                await errors

        before = source_state(self.source)
        try:
            events = asyncio.run(observe())
        finally:
            self.assertEqual(source_state(self.source), before)
        self.assertEqual(sum(event.get("event") == "asset" for event in events), 4)
        self.assertEqual(events[-1]["event"], "complete")
        self.validate_manifest(selected=[1, 2])

    def test_selected_pages_are_valid_partial_document_coverage(self):
        many = self.root / "three-pages.pdf"
        make_pdf(many, 3)
        self.complete("--pages", "2-3", "--tiers", "192", source=many)
        self.validate_manifest(source=many, selected=[2, 3])

    def test_receipt_supplies_output_and_document_key(self):
        receipt = self.write_receipt(self.receipt())
        self.complete("--source-receipt", str(receipt), "--tiers", "192", omit_output=True)
        self.validate_manifest(key="receipt-book", selected=[1, 2])

    def test_receipt_mismatches_preserve_existing_output(self):
        valid = self.receipt()
        receipt = self.write_receipt(valid)
        self.complete("--source-receipt", str(receipt), "--tiers", "192", omit_output=True)
        original = self.output_snapshot()
        variants = []
        for field, bad in (("sha256", "0" * 64), ("size", valid["document"]["size"] + 1)):
            value = copy.deepcopy(valid)
            value["document"][field] = bad
            variants.append((field, value, []))
        value = copy.deepcopy(valid)
        value["pdf"] = "another.pdf"
        variants.append(("basename", value, []))
        variants += [("output conflict", valid, ["--output", str(self.root / "wrong-output")]),
                     ("key conflict", valid, ["--document-key", "wrong-key"])]
        for name, value, arguments in variants:
            with self.subTest(name=name):
                receipt = self.write_receipt(value)
                self.rejected("--source-receipt", str(receipt), "--tiers", "192", *arguments, omit_output=True)
                self.assertEqual(self.output_snapshot(), original)

    def test_receipt_requires_integer_version(self):
        for bad in (True, "1", 1.0, 2):
            with self.subTest(version=bad):
                value = self.receipt()
                value["version"] = bad
                self.rejected("--source-receipt", str(self.write_receipt(value)), "--tiers", "192", omit_output=True)
                self.assertFalse((self.output / "manifest.json").exists())

    def test_resume_merges_tiers_and_reuses_verified_assets(self):
        self.complete("--pages", "1", "--tiers", "192")
        before = self.validate_manifest(selected=[1])
        old = before["pages"][0]["assets"][0]
        asset = self.output / old["path"]
        identity = (asset.stat().st_ino, asset.stat().st_mtime_ns, asset.read_bytes())
        self.complete("--pages", "1-2", "--tiers", "192,512")
        merged = self.validate_manifest(selected=[1, 2])
        self.assertEqual((asset.stat().st_ino, asset.stat().st_mtime_ns, asset.read_bytes()), identity)
        for page in merged["pages"]:
            self.assertCountEqual([max(asset["width"], asset["height"]) for asset in page["assets"]], [192, 512])

    def test_different_source_identity_cannot_overwrite_output(self):
        self.complete("--tiers", "192")
        original = self.output_snapshot()
        other = self.root / "different.pdf"
        make_pdf(other, 3)
        self.rejected("--tiers", "192", source=other)
        self.assertEqual(self.output_snapshot(), original)

    def test_reused_jpeg_dimensions_must_match_encoded_image(self):
        self.complete("--pages", "1", "--tiers", "192")
        manifest = self.manifest()
        asset = manifest["pages"][0]["assets"][0]
        # This remains inside the manifest's two-pixel aspect tolerance. Its bytes,
        # size and checksum are all valid; only the claimed encoded height is false.
        asset["height"] += 1
        (self.output / "manifest.json").write_text(json.dumps(manifest))
        before = self.output_snapshot()
        self.rejected("--pages", "1", "--tiers", "192")
        self.assertEqual(self.output_snapshot(), before)

    def test_existing_manifest_rotation_rejects_boolean(self):
        self.complete("--pages", "1", "--tiers", "192")
        manifest = self.manifest()
        manifest["pages"][0]["rotation"] = False
        (self.output / "manifest.json").write_text(json.dumps(manifest))
        before = self.output_snapshot()
        self.rejected("--pages", "1", "--tiers", "192")
        self.assertEqual(self.output_snapshot(), before)

    def test_invalid_tiers_and_page_selections_leave_output_unchanged(self):
        for arguments in (("--tiers", "191"), ("--tiers", "192,384"), ("--pages", "0"),
                          ("--pages", "3"), ("--pages", "2-1"), ("--workers", "3")):
            with self.subTest(arguments=arguments):
                before = self.output_snapshot()
                self.rejected(*arguments)
                self.assertEqual(self.output_snapshot(), before)

    def test_priority_spreads_must_be_adjacent_and_selected(self):
        many = self.root / "three-pages.pdf"
        make_pdf(many, 3)
        for arguments in (("--priority-spreads", "1:3"),
                          ("--pages", "1-2", "--priority-spreads", "2:3")):
            with self.subTest(arguments=arguments):
                self.rejected("--tiers", "192", *arguments, source=many)
                self.assertFalse((self.output / "manifest.json").exists())

    def test_raster_budget_is_independent_of_the_owned_reading_namespace(self):
        self.complete("--pages", "1", "--tiers", "192")
        reading = self.output / "reading"
        reading.mkdir()
        asset = reading / "owned-image.bin"
        asset.write_bytes(b"x" * (2 * MIB))
        metadata = self.output / "reading.json"
        metadata.write_text('{"owned":"reading generator"}\n')
        before = (source_state(asset), source_state(metadata))
        self.complete("--pages", "1-2", "--tiers", "192,512", "--max-output-mib", "1")
        self.assertEqual((source_state(asset), source_state(metadata)), before)
        self.validate_manifest(selected=[1, 2])
        ordinary = self.output / "unrelated.bin"
        ordinary.write_bytes(b"y" * MIB)
        result, _, detail = self.run_cli("--pages", "1-2", "--tiers", "192,512", "--max-output-mib", "1")
        self.assertEqual(result.returncode, 3, detail)

    def test_quota_preserves_completed_manifest_and_counts_unrelated_files(self):
        self.complete("--pages", "1", "--tiers", "192")
        filler = self.output / "preexisting.bin"
        filler.write_bytes(b"retained" * 1024)
        original = self.output_snapshot()
        existing = sum(path.stat().st_size for path in self.output.rglob("*") if path.is_file())
        quota = (existing + 64) / MIB
        result, events, detail = self.run_cli("--pages", "1-2", "--tiers", "192,512", "--max-output-mib", str(quota))
        self.assertEqual(result.returncode, 3, detail)
        self.assertEqual(events[-1].get("event"), "partial", detail)
        self.assertEqual(self.output_snapshot(), original, "quota stop must preserve completed files and leave no staging files")
        self.validate_manifest(selected=[1])

    def test_quota_before_first_asset_does_not_publish_empty_manifest(self):
        self.output.mkdir()
        filler = self.output / "retained.bin"
        filler.write_bytes(b"x" * 4096)
        original = self.output_snapshot()
        result, events, detail = self.run_cli("--tiers", "192", "--max-output-mib", str((4096 + 64) / MIB))
        self.assertEqual(result.returncode, 3, detail)
        self.assertEqual(events[-1].get("event"), "partial", detail)
        after = self.output_snapshot()
        lock = after.pop(".motionlab.lock", None)
        if lock is not None:
            self.assertEqual(lock, ("file", b""), "only the empty persistent lock may be created")
        self.assertEqual(after, original)

    def test_existing_manifest_cannot_address_files_outside_output(self):
        self.complete("--pages", "1", "--tiers", "192")
        original = self.manifest()
        asset = original["pages"][0]["assets"][0]
        outside = self.root / "outside.jpg"
        outside.write_bytes((self.output / asset["path"]).read_bytes())
        outside_before = source_state(outside)
        for unsafe in ("../outside.jpg", str(outside.resolve())):
            with self.subTest(path=unsafe):
                manifest = copy.deepcopy(original)
                manifest["pages"][0]["assets"][0]["path"] = unsafe
                (self.output / "manifest.json").write_text(json.dumps(manifest))
                before = self.output_snapshot()
                self.rejected("--pages", "1", "--tiers", "192")
                self.assertEqual(self.output_snapshot(), before)
                self.assertEqual(source_state(outside), outside_before)

    def test_existing_asset_symlink_cannot_escape_output(self):
        self.complete("--pages", "1", "--tiers", "192")
        asset = self.output / self.manifest()["pages"][0]["assets"][0]["path"]
        outside = self.root / "outside.jpg"
        outside.write_bytes(asset.read_bytes())
        outside_before = source_state(outside)
        asset.unlink()
        asset.symlink_to(outside)
        before = self.output_snapshot()
        self.rejected("--pages", "1", "--tiers", "192")
        self.assertEqual(self.output_snapshot(), before)
        self.assertEqual(source_state(outside), outside_before)

    def test_unlinked_and_invalid_occurrences_declare_incomplete_inventory(self):
        spec = importlib.util.spec_from_file_location("occurrence_producer", SCRIPT)
        producer = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = producer
        spec.loader.exec_module(producer)
        class Page:
            rect = fitz.Rect(0, 0, 200, 200)
            rotation = 0
            rotation_matrix = fitz.Matrix(1, 1)
            def get_image_info(self, hashes, xrefs):
                self.xrefs_requested = xrefs
                return [{"bbox": (10, 10, 50, 50), "xref": 42},
                        {"bbox": (70, 10, 110, 50), "xref": 0},
                        {"bbox": (float("nan"), 0, 10, 10), "xref": 99}]
        page = Page()
        result = producer.page_geometry(page, 1, True)
        self.assertFalse(page.xrefs_requested)
        self.assertFalse(result["imageRegionsComplete"])
        self.assertEqual(len(result["imageRegions"]), 2)
        by_id = {region["id"]: region for region in result["imageRegions"]}
        self.assertNotIn("resourceId", by_id["p1-i0"])
        self.assertNotIn("resourceId", by_id["p1-i1"])

    def test_equal_content_external_and_inline_occurrences_are_not_invented_links(self):
        spec = importlib.util.spec_from_file_location("ambiguity_producer", SCRIPT)
        producer = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = producer
        spec.loader.exec_module(producer)
        for inline in (None, b"BI ", b"BI% inline dictionary follows\n", b"BI\x00", b"split"):
            with fitz.open() as document:
                page = document.new_page(width=200, height=100)
                first = document.get_new_xref()
                dictionary = "<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 >>"
                document.update_object(first, dictionary)
                pixels = bytes([220, 20, 30]) * 4
                document.update_stream(first, pixels)
                second = None
                if inline is None:
                    second = document.get_new_xref()
                    document.update_object(second, dictionary)
                    document.update_stream(second, pixels)
                resources = document.get_new_xref()
                extra = f" /B {second} 0 R" if second is not None else ""
                document.update_object(resources, f"<< /XObject << /A {first} 0 R{extra} >> >>")
                document.xref_set_key(page.xref, "Resources", f"{resources} 0 R")
                commands = b"q 60 0 0 60 10 20 cm /A Do Q\n"
                commands += (b"q 60 0 0 60 110 20 cm " + (b"BI " if inline == b"split" else inline) + b"/W 2 /H 2 /CS /RGB /BPC 8 ID " + pixels + b" EI Q") if inline is not None else b"q 60 0 0 60 110 20 cm /B Do Q"
                content = document.get_new_xref()
                document.update_object(content, "<< >>")
                if inline == b"split":
                    prefix, suffix = commands.split(b"BI", 1)
                    document.update_stream(content, prefix + b"BI")
                    tail = document.get_new_xref()
                    document.update_object(tail, "<< >>")
                    document.update_stream(tail, suffix)
                    document.xref_set_key(page.xref, "Contents", f"[{content} 0 R {tail} 0 R]")
                else:
                    document.update_stream(content, commands)
                    document.xref_set_key(page.xref, "Contents", f"{content} 0 R")
                result = producer.page_geometry(page, 1, True)
                self.assertEqual(len(result["imageRegions"]), 2)
                self.assertFalse(result["imageRegionsComplete"])
                self.assertTrue(all("resourceId" not in region for region in result["imageRegions"]))

    def test_occurrences_keep_actual_shared_xref_and_distinct_placements(self):
        source = self.root / "repeated-resource.pdf"
        with fitz.open() as document:
            page = document.new_page(width=200, height=200)
            xref = page.insert_image(fitz.Rect(10, 10, 50, 30), stream=solid_image())
            page.insert_image(fitz.Rect(70, 60, 150, 100), xref=xref)
            document.save(source)
        self.complete("--tiers", "192", "--require-image-regions", source=source)
        page = self.manifest()["pages"][0]
        self.assertTrue(page["imageRegionsComplete"])
        self.assertEqual(len(page["imageRegions"]), 2)
        self.assertEqual({r["resourceId"] for r in page["imageRegions"]}, {f"x{xref}"})
        self.assertEqual(len({r["id"] for r in page["imageRegions"]}), 2)
        manifest_path = self.output / "manifest.json"
        legacy = self.manifest()
        legacy["pages"][0].pop("imageRegionsComplete")
        for region in legacy["pages"][0]["imageRegions"]:
            region.pop("resourceId", None)
        manifest_path.write_text(json.dumps(legacy))
        self.complete("--tiers", "192", "--require-image-regions", source=source)
        self.assertTrue(self.manifest()["pages"][0]["imageRegionsComplete"])
        second_events = self.complete("--tiers", "192", "--require-image-regions", source=source)
        self.assertFalse(any(event.get("event") == "asset" for event in second_events))
        self.complete("--tiers", "512", "--require-image-regions", source=source)
        self.assertEqual(self.manifest()["pages"][0]["imageRegions"], page["imageRegions"])

    def test_metadata_enrichment_preserves_existing_verified_raster_bytes_and_descriptors(self):
        self.complete("--tiers", "192", "--renderer", "pymupdf")
        value = self.manifest()
        # A valid pre-existing encoder result need not match today's renderer.
        for page in value["pages"]:
            page.pop("imageRegionsComplete", None)
            asset = page["assets"][0]
            output = io.BytesIO()
            Image.new("RGB", (asset["width"], asset["height"]), (123, 45, 67)).save(output, "JPEG", quality=74)
            data = output.getvalue()
            digest = hashlib.sha256(data).hexdigest()
            relative = f"assets/p{page['pageNumber']:05d}-192-{digest}.jpg"
            (self.output / relative).write_bytes(data)
            asset.update(path=relative, bytes=len(data), sha256=digest)
        (self.output / "manifest.json").write_text(json.dumps(value))
        assets = copy.deepcopy([page["assets"] for page in value["pages"]])
        before = {asset["path"]: source_state(self.output / asset["path"]) for page in value["pages"] for asset in page["assets"]}
        events = self.complete("--tiers", "192", "--renderer", "pymupdf", "--require-image-regions")
        after = self.manifest()
        self.assertEqual([page["assets"] for page in after["pages"]], assets)
        self.assertEqual({name: source_state(self.output / name) for name in before}, before)
        self.assertFalse(any(event.get("event") == "asset" for event in events))
        self.assertEqual(sum(event.get("event") == "metadata" for event in events), len(value["pages"]))
        self.assertTrue(all(type(page.get("imageRegionsComplete")) is bool for page in after["pages"]))
        self.assertEqual(events[-1]["publishedAssets"], 0)
        self.assertEqual(events[-1]["metadataPages"], len(value["pages"]))

    def test_metadata_atomic_failure_keeps_verified_assets_and_can_resume(self):
        from unittest import mock
        self.complete("--tiers", "192", "--renderer", "pymupdf")
        value = self.manifest()
        for page in value["pages"]:
            page.pop("imageRegionsComplete", None)
        manifest_path = self.output / "manifest.json"
        manifest_path.write_text(json.dumps(value))
        original = manifest_path.read_bytes()
        assets = {asset["path"]: source_state(self.output / asset["path"]) for page in value["pages"] for asset in page["assets"]}
        spec = importlib.util.spec_from_file_location("metadata_atomic_producer", SCRIPT)
        producer = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = producer
        spec.loader.exec_module(producer)
        publisher = producer.Publisher(self.output, value["document"], len(value["pages"]), 512 * MIB, producer.Deadline(30))
        geometry = {**value["pages"][0], "imageRegionsComplete": False}
        replace = producer.os.replace
        def interrupted(source, destination):
            if Path(destination) == manifest_path:
                raise OSError("metadata publication interrupted")
            return replace(source, destination)
        with mock.patch.object(producer.os, "replace", side_effect=interrupted):
            with self.assertRaisesRegex(OSError, "metadata publication interrupted"):
                publisher.publish_metadata({"metadataOnly": True, "page": geometry}, 1, 0)
        self.assertEqual(manifest_path.read_bytes(), original)
        self.assertFalse((self.output / ".manifest.pending").exists())
        self.assertEqual({name: source_state(self.output / name) for name in assets}, assets)
        publisher = producer.Publisher(self.output, value["document"], len(value["pages"]), 512 * MIB, producer.Deadline(30))
        with contextlib.redirect_stdout(io.StringIO()):
            publisher.publish_metadata({"metadataOnly": True, "page": geometry}, 1, 0)
        self.assertIs(self.manifest()["pages"][0]["imageRegionsComplete"], False)
        self.assertEqual({name: source_state(self.output / name) for name in assets}, assets)

    def test_fresh_raster_is_independent_of_occurrence_extraction_document_state(self):
        from unittest import mock
        spec = importlib.util.spec_from_file_location("raster_isolation_producer", SCRIPT)
        producer = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = producer
        spec.loader.exec_module(producer)
        original = producer.page_geometry
        opened_documents = []
        open_document = fitz.open
        def tracked_open(*args, **kwargs):
            document = open_document(*args, **kwargs)
            opened_documents.append(document)
            return document
        def geometry(page, number, include):
            result = original(page, number, include)
            if include:
                self.assertTrue(opened_documents[0].is_closed, "raster document closes before metadata extraction")
                # Model MuPDF's observed extraction-side state change with actual
                # PDF drawing. It must remain isolated from raster generation.
                page.draw_rect(page.rect, color=None, fill=(0, 1, 0), overlay=True)
            return result
        job = {"operation": "render", "source": str(self.source), "fingerprint": producer.fingerprint(self.source),
               "has_fitz": True, "renderer": "pymupdf", "page": 1, "tier": 192, "regions": False}
        previous_directory = Path.cwd()
        try:
            os.chdir(self.root)
            producer.worker_operation(job)
            before = Path("preview.jpg").read_bytes()
            with mock.patch.object(producer, "page_geometry", side_effect=geometry), mock.patch.object(fitz, "open", side_effect=tracked_open):
                producer.worker_operation({**job, "regions": True})
            self.assertEqual(Path("preview.jpg").read_bytes(), before)
        finally:
            os.chdir(previous_directory)
        self.assertEqual(len(opened_documents), 2)
        self.assertTrue(all(document.is_closed for document in opened_documents))

    def test_image_region_cap_keeps_largest_regions_and_reports_omissions(self):
        source = self.root / "many-regions.pdf"
        image = solid_image()
        with fitz.open() as document:
            page = document.new_page(width=200, height=200)
            for number in range(256):
                x, y = (number % 16) * 5, (number // 16) * 5
                page.insert_image(fitz.Rect(x, y, x + 3, y + 3), stream=image, keep_proportion=False)
            page.insert_image(fitz.Rect(100, 100, 190, 190), stream=image, keep_proportion=False)
            document.save(source, deflate=True)
        events = self.complete("--tiers", "192", "--require-image-regions", source=source)
        manifest = self.validate_manifest(source=source, selected=[1])
        regions = manifest["pages"][0]["imageRegions"]
        self.assertEqual(len(regions), 256)
        self.assertFalse(manifest["pages"][0]["imageRegionsComplete"])
        self.assertTrue(any(abs(region["width"] - .45) < 1e-5 and abs(region["height"] - .45) < 1e-5 for region in regions))
        self.assertEqual([event["regionsOmitted"] for event in events if event.get("event") == "asset"], [1])

    @unittest.skipUnless(shutil.which("pdftoppm") and shutil.which("pdfinfo"), "Poppler tools are unavailable")
    def test_poppler_uses_rotated_crop_box(self):
        cropped = self.root / "poppler-crop.pdf"
        make_cropped_pdf(cropped, rotations=(90,))
        self.complete("--tiers", "192", "--renderer", "poppler", source=cropped)
        manifest = self.validate_manifest(source=cropped, selected=[1])
        self.assertEqual((manifest["pages"][0]["width"], manifest["pages"][0]["height"]), (180, 220))
        asset = manifest["pages"][0]["assets"][0]
        self.assertEqual(max(asset["width"], asset["height"]), 192)
        with Image.open(self.output / asset["path"]) as image:
            color = image.convert("RGB").getpixel((int(image.width * .98), int(image.height * .2)))
            self.assertTrue(all(abs(actual - wanted) < 25 for actual, wanted in zip(color, (20, 200, 40))), color)

    @unittest.skipUnless(shutil.which("pdftoppm") and shutil.which("pdfinfo"), "Poppler tools are unavailable")
    def test_auto_falls_back_without_pymupdf_and_requires_region_capability(self):
        cropped = self.root / "fallback-crop.pdf"
        make_cropped_pdf(cropped, rotations=(270,))
        environment = self.without_pymupdf_environment()
        self.complete("--tiers", "192", "--renderer", "auto", source=cropped, environment=environment)
        manifest = self.validate_manifest(source=cropped, selected=[1])
        self.assertNotIn("imageRegions", manifest["pages"][0])
        self.assertEqual((manifest["pages"][0]["width"], manifest["pages"][0]["height"]), (180, 220))
        with Image.open(self.output / manifest["pages"][0]["assets"][0]["path"]) as image:
            color = image.convert("RGB").getpixel((int(image.width * .2), int(image.height * .98)))
            self.assertTrue(all(abs(actual - wanted) < 25 for actual, wanted in zip(color, (20, 200, 40))), color)
        before = self.output_snapshot()
        self.rejected("--tiers", "192", "--renderer", "auto", "--require-image-regions", source=cropped, environment=environment)
        self.assertEqual(self.output_snapshot(), before)

    @unittest.skipUnless(shutil.which("pdftoppm") and shutil.which("pdfinfo"), "Poppler tools are unavailable")
    def test_existing_poppler_tier_backfills_regions_with_fractional_crop(self):
        cropped = self.root / "fractional-crop.pdf"
        crop = fitz.Rect(40.1234, 30.2345, 260.5678, 210.6789)
        with fitz.open() as document:
            page = document.new_page(width=300.123, height=240.456)
            page.insert_image(fitz.Rect(20, 20, 120, 100), stream=solid_image(), keep_proportion=False)
            page.set_cropbox(crop)
            page.set_rotation(90)
            document.save(cropped, deflate=True)
        self.complete("--tiers", "192", "--renderer", "auto", source=cropped,
                      environment=self.without_pymupdf_environment())
        initial = self.validate_manifest(source=cropped, selected=[1], geometry_delta=.02)
        self.assertNotIn("imageRegions", initial["pages"][0])
        initial_geometry = {field: initial["pages"][0][field] for field in ("width", "height", "rotation")}

        events = self.complete("--tiers", "192", "--renderer", "pymupdf", "--require-image-regions", source=cropped)
        manifest = self.validate_manifest(source=cropped, selected=[1], geometry_delta=.02)
        page = manifest["pages"][0]
        self.assertEqual({field: page[field] for field in initial_geometry}, initial_geometry)
        self.assertEqual(len(page["assets"]), 1, "metadata backfill must not duplicate an existing tier")
        self.assertEqual(len(page["imageRegions"]), 1)
        region = page["imageRegions"][0]
        expected = {"x": (crop.y1 - 100) / crop.height, "y": 0,
                    "width": (100 - crop.y0) / crop.height, "height": (120 - crop.x0) / crop.width}
        for field, value in expected.items():
            self.assertAlmostEqual(region[field], value, delta=1e-5, msg=field)
        self.assertEqual(page["assets"], initial["pages"][0]["assets"], "metadata enrichment preserves the verified Poppler asset")
        self.assertEqual(sum(event.get("event") == "metadata" for event in events), 1)
        self.assertFalse(any(event.get("event") == "asset" for event in events))

    @unittest.skipUnless(sys.platform == "linux" and hasattr(os, "pidfd_open") and shutil.which("pdfinfo"),
                         "Linux pidfds and pdfinfo are required for descendant cleanup verification")
    def test_sigterm_cleans_running_renderer_descendant_and_staging(self):
        marker = self.root / "renderer-started.json"
        binaries = self.root / "bin"
        binaries.mkdir()
        renderer = binaries / "pdftoppm"
        renderer.write_text(
            f"#!{sys.executable}\n"
            "import json, os\n"
            "with open(os.environ['MOTIONLAB_TEST_MARKER'], 'w') as stream:\n"
            "    json.dump({'pid': os.getpid(), 'ppid': os.getppid(), 'pgid': os.getpgrp()}, stream)\n"
            "reader, writer = os.pipe()\n"
            "os.read(reader, 1)\n"
        )
        renderer.chmod(0o700)
        environment = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", MOTIONLAB_TEST_MARKER=str(marker))
        environment["PATH"] = str(binaries) + os.pathsep + environment.get("PATH", "")
        libc = ctypes.CDLL(None, use_errno=True)
        libc.inotify_init1.argtypes = [ctypes.c_int]
        libc.inotify_init1.restype = ctypes.c_int
        libc.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        libc.inotify_add_watch.restype = ctypes.c_int
        watch = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        self.assertGreaterEqual(watch, 0, f"inotify_init1 errno {ctypes.get_errno()}")
        process = None
        owned_group = None
        descriptors = []
        before = source_state(self.source)
        try:
            self.assertGreaterEqual(libc.inotify_add_watch(watch, os.fsencode(self.root), 0x8 | 0x80), 0)
            process = subprocess.Popen(
                [sys.executable, "-B", str(SCRIPT), str(self.source), "--output", str(self.output),
                 "--renderer", "poppler", "--tiers", "192", "--workers", "1",
                 "--deadline-seconds", "20", "--job-timeout-seconds", "15"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=environment, start_new_session=True)
            deadline = time.monotonic() + 8
            while not marker.exists():
                remaining = deadline - time.monotonic()
                self.assertGreater(remaining, 0, "renderer did not publish its start marker")
                readable, _, _ = select.select([watch], [], [], remaining)
                self.assertTrue(readable, "renderer did not publish its start marker")
                os.read(watch, 65536)
            identity = json.loads(marker.read_text())
            self.assertEqual(identity["pgid"], identity["ppid"], "the renderer must belong to the worker's owned group")
            self.assertNotEqual(identity["pgid"], os.getpgrp())
            owned_group = identity["pgid"]
            descriptors = [os.pidfd_open(identity[field]) for field in ("ppid", "pid")]
            process.send_signal(signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=5)
            self.assertEqual(process.returncode, 143, stdout + stderr)
            summaries = [json.loads(line) for line in (stdout + stderr).splitlines() if line.strip()]
            self.assertTrue(any(event.get("event") == "error" for event in summaries))
            for descriptor in descriptors:
                self.assertTrue(select.select([descriptor], [], [], 0)[0], "an owned renderer process survived SIGTERM")
            self.assertEqual(list(self.output.glob(".motionlab-work-*")), [])
            self.assertFalse((self.output / "manifest.json").exists())
        finally:
            if owned_group is not None:
                try:
                    os.killpg(owned_group, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if process is not None and process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate(timeout=5)
            for descriptor in descriptors:
                try:
                    select.select([descriptor], [], [], 5)
                finally:
                    os.close(descriptor)
            os.close(watch)
            self.assertEqual(source_state(self.source), before)


if __name__ == "__main__":
    unittest.main()
