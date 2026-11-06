"""Production reading assets preserve PDF composition and exact source identity."""
from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest

import fitz
from PIL import Image, ImageChops, ImageStat


SCRIPT = Path(__file__).with_name("motionlab-reading.py")
VERIFIER = SCRIPT.parent / "pdf-jpeg-progressive" / "coefficients.c"
SPEC = importlib.util.spec_from_file_location("reading_protocol_test", SCRIPT)
READING = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(READING)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def jpeg(*, rgb=False, cmyk=False):
    image = Image.new("CMYK" if cmyk else "RGB", (96, 64))
    for y in range(image.height):
        for x in range(image.width):
            image.putpixel((x, y), (x * 2, y * 3, (x + y) % 256, 20) if cmyk
                           else (x * 2, y * 3, (x + y) % 256))
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=91, keep_rgb=rgb, subsampling=0)
    image.close()
    return output.getvalue()


def alpha_png():
    image = Image.new("RGBA", (16, 12), (20, 170, 230, 110))
    output = io.BytesIO()
    image.save(output, format="PNG")
    image.close()
    return output.getvalue()


def fixture(path, *, rgb=False, cmyk=False):
    with fitz.open() as document:
        page = document.new_page(width=240, height=180)
        page.insert_text((20, 50), "Under the photograph", fontsize=12)
        image = page.insert_image(fitz.Rect(10, 20, 190, 140), stream=jpeg(rgb=rgb, cmyk=cmyk))
        if rgb:
            document.xref_set_key(image, "DecodeParms", "<</ColorTransform 0>>")
        page.insert_text((30, 70), "Above the photograph", fontsize=13, color=(1, 0, 0))
        page.insert_image(fitz.Rect(100, 80, 210, 160), stream=alpha_png())
        page.insert_image(fitz.Rect(190, 25, 230, 55), xref=image)
        page.set_cropbox(fitz.Rect(8, 10, 232, 170))
        page.set_rotation(90)
        nested = document.new_page(width=180, height=240)
        with fitz.open() as inner:
            target = inner.new_page(width=100, height=80)
            target.insert_text((5, 20), "Nested form", fontsize=9)
            target.insert_image(fitz.Rect(20, 30, 80, 70), stream=jpeg())
            nested.show_pdf_page(fitz.Rect(15, 20, 165, 140), inner, 0)
        document.save(path, garbage=0, deflate=True)


def state(path):
    value = path.stat()
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns, digest(path.read_bytes())


class ReadingProductionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tool_directory = tempfile.TemporaryDirectory(prefix="motionlab-reading-tool-")
        cls.tool = Path(cls.tool_directory.name) / "coefficients"
        subprocess.run(["cc", "-O2", str(VERIFIER), "-ljpeg", "-o", str(cls.tool)], check=True,
                       capture_output=True, timeout=30)

    @classmethod
    def tearDownClass(cls):
        cls.tool_directory.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="motionlab-reading-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "book.pdf"
        self.output = self.root / "published-input"
        fixture(self.source)

    def run_cli(self, *options, success=True):
        before = state(self.source)
        result = subprocess.run([sys.executable, "-B", str(SCRIPT), str(self.source),
                                 "--output", str(self.output), "--jpeg-tool", str(self.tool), *options],
                                text=True, capture_output=True, timeout=45)
        self.assertEqual(state(self.source), before, "the generator changed the original PDF")
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        events = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
        return result, events

    def manifest(self):
        return json.loads((self.output / "reading.json").read_text())

    def reconstruct(self, manifest):
        document = fitz.open(self.output / manifest["pdf"]["path"])
        for image in manifest["images"]:
            xref = int(image["id"][1:])
            filters = {key: document.xref_get_key(xref, key)[1] for key in ("Filter", "DecodeParms")}
            document.update_stream(xref, (self.output / image["path"]).read_bytes(), compress=False)
            for key, value in filters.items():
                document.xref_set_key(xref, key, value)
            document.xref_set_key(xref, "MotionLabImage", "null")
        return document

    def test_structure_preserves_text_geometry_paint_order_forms_and_masks(self):
        _, events = self.run_cli()
        manifest = self.manifest()
        self.assertEqual(manifest["source"], {"sha256": digest(self.source.read_bytes()),
                                             "size": self.source.stat().st_size, "pageCount": 2})
        self.assertEqual(manifest["version"], 1)
        with fitz.open(self.source) as original, fitz.open(self.output / manifest["pdf"]["path"]) as structure:
            self.assertEqual(structure.page_count, original.page_count)
            for image in manifest["images"]:
                xref = int(image["id"][1:])
                self.assertEqual(structure.xref_stream_raw(xref), b"")
                self.assertEqual(structure.xref_get_key(xref, "MotionLabImage"), ("string", image["id"]))
                self.assertEqual(image["originalSha256"], digest(original.xref_stream_raw(xref)))
                for key in original.xref_get_keys(xref):
                    if key != "Length":
                        self.assertEqual(structure.xref_get_key(xref, key), original.xref_get_key(xref, key))
            for left, right in zip(original, structure):
                self.assertEqual((list(left.mediabox), list(left.cropbox), left.rotation),
                                 (list(right.mediabox), list(right.cropbox), right.rotation))
                self.assertEqual(left.get_text("text", flags=0), right.get_text("text", flags=0))
                for xref in left.get_contents():
                    self.assertEqual(original.xref_stream(xref), structure.xref_stream(xref))
            with self.reconstruct(manifest) as restored:
                for left, right in zip(original, restored):
                    self.assertEqual(left.get_pixmap(alpha=True).samples, right.get_pixmap(alpha=True).samples,
                                     "native composition changed after lossless image extraction")
        self.assertEqual(events[-1]["event"], "complete")
        self.assertGreater(events[-1]["coverage"]["progressiveImages"], 0)
        self.assertGreater(events[-1]["coverage"]["originalImages"], 0)

    def test_shared_manifest_examples_match_the_browser_validator(self):
        examples = json.loads((SCRIPT.parent.parent / "src/test/fixtures/pdfReadingManifest.json").read_text())
        for example in examples["cases"]:
            with self.subTest(name=example["name"]):
                if example["valid"]:
                    READING.validate_manifest(example["manifest"], examples["identity"]["sha256"])
                else:
                    with self.assertRaises(READING.Failure):
                        READING.validate_manifest(example["manifest"], examples["identity"]["sha256"])

    def test_progressive_chunks_verify_each_complete_scan_without_later_bytes(self):
        self.run_cli()
        manifest = self.manifest()
        for image in manifest["images"]:
            data = (self.output / image["path"]).read_bytes()
            self.assertEqual((len(data), digest(data)), (image["bytes"], image["sha256"]))
            if image["encoding"] != "progressive-jpeg":
                self.assertNotIn("chunks", image)
                continue
            self.assertEqual(image["components"], 3)
            self.assertGreater(image["coefficientBytes"], 0)
            cursor = 0
            for scan, chunk in enumerate(image["chunks"], 1):
                self.assertEqual((chunk["offset"], chunk["scan"]), (cursor, scan))
                cursor += chunk["bytes"]
                self.assertEqual(chunk["sha256"], digest(data[chunk["offset"]:cursor]))
                self.assertEqual(data[cursor - 2], 255)
                self.assertNotIn(data[cursor - 1], [0, *range(208, 216)])
            self.assertEqual(cursor, len(data))
            self.assertEqual(data[-2:], b"\xff\xd9")
            self.assertGreater(len(image["chunks"]), 1)

    def test_adobe_rgb_and_pdf_color_transform_keep_native_pixels(self):
        fixture(self.source, rgb=True)
        self.run_cli()
        manifest = self.manifest()
        with fitz.open(self.source) as original, self.reconstruct(manifest) as restored:
            image = next(value for value in manifest["images"]
                         if original.xref_get_key(int(value["id"][1:]), "DecodeParms")[0] != "null")
            original_bytes = original.xref_stream_raw(int(image["id"][1:]))
            encoded = (self.output / image["path"]).read_bytes()
            self.assertIn(b"Adobe", original_bytes)
            self.assertIn(b"Adobe", encoded)
            self.assertEqual(image["encoding"], "progressive-jpeg")
            self.assertEqual(original[0].get_pixmap().samples, restored[0].get_pixmap().samples)

    def test_initial_dc_precision_uses_quantizers_with_a_two_level_component_bound(self):
        for quality, expected_al in ((100, 4), (95, 3), (90, 2), (75, 1), (40, 0)):
            with self.subTest(quality=quality):
                # Uniform components isolate DC precision from libjpeg's
                # synthesized inter-block AC smoothing on incomplete scans.
                picture = Image.new("RGB", (96, 64), (37, 163, 221))
                stream = io.BytesIO()
                picture.save(stream, "JPEG", quality=quality, keep_rgb=True, subsampling=0)
                picture.close()
                with fitz.open() as document:
                    page = document.new_page(width=96, height=64)
                    page.insert_image(page.rect, stream=stream.getvalue())
                    document.save(self.source)
                self.output = self.root / f"profile-{quality}"
                self.run_cli()
                image = self.manifest()["images"][0]
                encoded = (self.output / image["path"]).read_bytes()
                position = 2
                while encoded[position + 1] != 0xDA:
                    position += 2 + int.from_bytes(encoded[position + 2:position + 4], "big")
                length = int.from_bytes(encoded[position + 2:position + 4], "big")
                self.assertEqual(encoded[position + 1 + length] & 15, expected_al)
                end = image["chunks"][0]["bytes"]
                with Image.open(io.BytesIO(encoded[:end - 2] + b"\xff\xd9")) as first, \
                        Image.open(io.BytesIO(encoded)) as final, Image.open(io.BytesIO(stream.getvalue())) as original:
                    first_rgb, final_rgb, original_rgb = first.convert("RGB"), final.convert("RGB"), original.convert("RGB")
                    self.assertIsNone(ImageChops.difference(final_rgb, original_rgb).getbbox())
                    error = ImageStat.Stat(ImageChops.difference(first_rgb, final_rgb))
                    self.assertLessEqual(max(high for _, high in error.extrema), 2)
                    if expected_al == 0:
                        self.assertIsNone(ImageChops.difference(first_rgb, final_rgb).getbbox())

    def test_unused_quantization_table_does_not_block_lossless_reading(self):
        encoded = jpeg()
        unused_table = b"\xff\xdb\x00\x43\x02" + bytes([18] * 64)
        encoded = encoded[:2] + unused_table + encoded[2:]
        with Image.open(io.BytesIO(encoded)) as original:
            self.assertIn(2, original.quantization)
            self.assertNotIn(2, [component[3] for component in original.layer])
        with fitz.open() as document:
            page = document.new_page(width=96, height=64)
            page.insert_image(page.rect, stream=encoded)
            document.save(self.source)
        self.run_cli()
        image = self.manifest()["images"][0]
        self.assertEqual(image["encoding"], "progressive-jpeg")
        with Image.open(io.BytesIO(encoded)) as original, Image.open(self.output / image["path"]) as converted:
            self.assertNotIn(2, converted.quantization)
            self.assertEqual(original.layer, converted.layer)
            self.assertEqual(original.convert("RGB").tobytes(), converted.convert("RGB").tobytes())

    def test_verify_only_rejects_a_changed_referenced_quantizer(self):
        original = self.root / "original.jpg"
        converted = self.root / "converted.jpg"
        original.write_bytes(jpeg())
        subprocess.run([str(self.tool), str(original), str(converted), os.devnull],
                       check=True, capture_output=True, timeout=10)
        encoded = bytearray(converted.read_bytes())
        position = 2
        while encoded[position + 1] != 0xDB:
            position += 2 + int.from_bytes(encoded[position + 2:position + 4], "big")
        self.assertEqual(encoded[position + 4], 0)
        encoded[position + 5] += 1
        converted.write_bytes(encoded)
        result = subprocess.run([str(self.tool), str(original), str(converted), os.devnull, "--verify-only"],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 4, result.stderr)
        self.assertIn("referenced quantization mismatch", result.stderr)

    def test_changed_verifier_rechecks_cached_images_without_transcoding(self):
        self.run_cli()
        manifest = self.manifest()
        before = {image["path"]: state(self.output / image["path"]) for image in manifest["images"]}
        (self.output / "reading.json").unlink()
        (self.output / ".reading-state.json").write_text(json.dumps({
            "version": manifest["version"], "source": {key: manifest["source"][key] for key in ("sha256", "size")},
            "verifier": "0" * 64, "images": manifest["images"]}))
        calls = self.root / "verifier-calls.jsonl"
        tool = self.root / "record-verifier"
        tool.write_text("#!" + sys.executable + "\nimport json,os,sys\n"
                       "with open(" + repr(str(calls)) + ",'a') as out: out.write(json.dumps(sys.argv[4:])+'\\n')\n"
                       "os.execv(" + repr(str(self.tool)) + ", [" + repr(str(self.tool)) + "]+sys.argv[1:])\n")
        tool.chmod(0o700)
        self.run_cli("--jpeg-tool", str(tool))
        self.assertEqual(self.manifest(), manifest)
        self.assertEqual(before, {name: state(self.output / name) for name in before})
        self.assertEqual([json.loads(line) for line in calls.read_text().splitlines()],
                         [["--verify-only"] for image in manifest["images"] if image["encoding"] == "progressive-jpeg"])

    def test_cmyk_original_bytes_and_mask_dependencies_stay_exact(self):
        fixture(self.source, cmyk=True)
        self.run_cli()
        manifest = self.manifest()
        with fitz.open(self.source) as original, self.reconstruct(manifest) as restored:
            ids = {image["id"] for image in manifest["images"]}
            for image in manifest["images"]:
                xref = int(image["id"][1:])
                if image["encoding"] == "original":
                    self.assertEqual((self.output / image["path"]).read_bytes(), original.xref_stream_raw(xref))
                    self.assertTrue(image["fallbackReason"])
                kind, mask = original.xref_get_key(xref, "SMask")
                if kind == "xref":
                    self.assertIn("x" + mask.split()[0], ids)
            self.assertEqual(original[0].get_pixmap(alpha=True).samples, restored[0].get_pixmap(alpha=True).samples)

    def test_receipt_resume_and_corruption_preserve_published_manifest(self):
        receipt = self.root / "source.json"
        receipt.write_text(json.dumps({"version": 1, "pdf": self.source.name,
            "document": {"key": "compiled-build", "sha256": digest(self.source.read_bytes()),
                         "size": self.source.stat().st_size}, "outputDirectory": str(self.output)}))
        self.run_cli("--source-receipt", str(receipt))
        before = (self.output / "reading.json").read_bytes()
        manifest = self.manifest()
        states = {asset["path"]: state(self.output / asset["path"]) for asset in [manifest["pdf"], *manifest["images"]]}
        self.run_cli("--source-receipt", str(receipt))
        self.assertEqual((self.output / "reading.json").read_bytes(), before)
        self.assertEqual(states, {name: state(self.output / name) for name in states})
        broken = self.output / manifest["images"][0]["path"]
        broken.write_bytes(b"x" * broken.stat().st_size)
        self.run_cli(success=False)
        self.assertEqual((self.output / "reading.json").read_bytes(), before)

    def test_repeated_small_asset_ids_charge_checkpoint_bytes_before_partial_exit(self):
        with fitz.open() as document:
            document.new_page()
            for _ in range(600):
                xref = document.get_new_xref()
                document.update_object(xref, "<</Type/XObject/Subtype/Image/Width 1/Height 1/ColorSpace/DeviceRGB/BitsPerComponent 8>>")
                document.update_stream(xref, b"\x12\x34\x56", compress=False)
            document.save(self.source, garbage=0, deflate=False)
        quota = 128 * 1024
        result, _ = self.run_cli("--max-output-mib", str(quota / 1024 ** 2), success=False)
        self.assertEqual(result.returncode, 3, result.stdout + result.stderr)
        retained = sum(path.stat().st_size for path in self.output.rglob("*") if path.is_file())
        self.assertLessEqual(retained, quota, "checkpoint metadata escaped the output budget")
        saved = json.loads((self.output / ".reading-state.json").read_text())
        self.assertGreater(len(saved["images"]), 0)
        self.assertLess(len(saved["images"]), 600)
        self.assertEqual(len({image["path"] for image in saved["images"]}), 1)
        self.assertFalse((self.output / "reading.json").exists())
        self.assertFalse(list(self.output.glob(".reading-work-*")))
        self.assertFalse(list(self.output.rglob(".reading-pending-*")))

    def test_termination_releases_native_and_compiler_process_groups(self):
        for compilation in (False, True):
            with self.subTest(compilation=compilation):
                fifo = self.root / ("compiler-ready" if compilation else "native-ready")
                os.mkfifo(fifo)
                descriptor = os.open(fifo, os.O_RDWR | os.O_NONBLOCK)
                tool_root = self.root / ("compiler-bin" if compilation else "native-bin")
                tool_root.mkdir()
                tool = tool_root / ("cc" if compilation else "coefficients")
                tool.write_text("#!" + sys.executable + "\nimport json,os,signal,subprocess,sys\n"
                    "child=subprocess.Popen([sys.executable,'-c','import signal; signal.pause()'])\n"
                    "with open(" + repr(str(fifo)) + ", 'w') as stream: stream.write(json.dumps([os.getpid(),child.pid]))\n"
                    "signal.pause()\n")
                tool.chmod(0o700)
                arguments = [sys.executable, "-B", str(SCRIPT), str(self.source), "--output", str(self.output)]
                environment = dict(os.environ)
                if compilation:
                    environment["PATH"] = str(tool_root) + os.pathsep + environment["PATH"]
                else:
                    arguments += ["--jpeg-tool", str(tool)]
                process = subprocess.Popen(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment)
                try:
                    self.assertTrue(select.select([descriptor], [], [], 10)[0], "owned native process did not announce readiness")
                    owned = json.loads(os.read(descriptor, 4096))
                    process.send_signal(signal.SIGTERM)
                    stdout, stderr = process.communicate(timeout=5)
                    self.assertEqual(process.returncode, 143, stdout + stderr)
                    for pid in owned:
                        path = Path(f"/proc/{pid}/stat")
                        if path.exists():
                            self.assertEqual(path.read_text().split(") ", 1)[1].split()[0], "Z", "a cancelled native process is still running")
                    self.assertFalse(list(self.output.glob(".reading-work-*")))
                    self.assertFalse((self.output / "reading.json").exists())
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.communicate(timeout=5)
                    os.close(descriptor)

    def test_resume_reclaims_only_abandoned_reading_temporaries(self):
        self.run_cli()
        before = (self.output / "reading.json").read_bytes()
        pending = [self.output / ".reading-pending-abc12345", self.output / "reading/.reading-pending-abc12345"]
        for path in pending:
            path.write_bytes(b"interrupted owned temporary")
        unrelated = self.output / "unrelated.txt"
        unrelated.write_bytes(b"keep")
        self.run_cli()
        self.assertEqual((self.output / "reading.json").read_bytes(), before)
        self.assertTrue(unrelated.exists())
        self.assertTrue(all(not path.exists() for path in pending))

    def test_budget_stop_keeps_raster_manifest_and_leaves_no_advertised_reading(self):
        self.output.mkdir()
        existing = self.output / "manifest.json"
        existing.write_text('{"existing":"raster"}\n')
        before = existing.read_bytes()
        self.run_cli("--max-output-mib", "0.001", success=False)
        self.assertEqual(existing.read_bytes(), before)
        self.assertFalse((self.output / "reading.json").exists())
        self.assertEqual(list(self.output.glob(".reading-work-*")), [])


if __name__ == "__main__":
    unittest.main()
