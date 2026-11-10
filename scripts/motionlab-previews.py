#!/usr/bin/env python3
"""Build bounded, versioned page previews without changing the source PDF."""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import errno
import fcntl
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import resource
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

MIB = 1024 * 1024
TIERS = (192, 512, 768, 1536)
MAX_SOURCE_BYTES = 4 * 1024 * MIB
MAX_MANIFEST_BYTES = 4 * MIB
MAX_ASSET_BYTES = 4 * MIB
MAX_PAGES = 10_000
MAX_ASSETS = 32_768
MAX_REGIONS_PER_PAGE = 256
MAX_REGIONS = 65_536
MIN_JOB_FILE_BYTES = 64 * 1024
MAX_DIRECTORY_ENTRIES = 100_000
HASH = re.compile(r"^[a-f0-9]{64}$")
SAFE_ASSET = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$")


class Failure(Exception):
    pass


class LimitReached(Exception):
    pass


class CommandParser(argparse.ArgumentParser):
    def error(self, message):
        print(json.dumps({"event": "error", "message": message}, separators=(",", ":")), file=sys.stderr)
        raise SystemExit(2)


class Deadline:
    def __init__(self, seconds: float):
        self.ends = time.monotonic() + seconds

    def remaining(self) -> float:
        left = self.ends - time.monotonic()
        if left <= 0:
            raise LimitReached("deadline")
        return left


def emit(event: str, **values):
    print(json.dumps({"event": event, **values}, separators=(",", ":")), flush=True)


def finite_positive(text: str) -> float:
    value = float(text)
    if not math.isfinite(value) or value <= 0:
        raise argparse.ArgumentTypeError("must be a finite positive number")
    return value


def fingerprint(path: Path) -> tuple[int, ...]:
    value = path.stat()
    if not stat.S_ISREG(value.st_mode):
        raise Failure("The source must be a regular PDF file")
    return stat_fingerprint(value)


def stat_fingerprint(value) -> tuple[int, ...]:
    return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


def check_source(path: Path, expected, fd: int | None = None):
    if fingerprint(path) != tuple(expected):
        raise Failure("The source changed during preview generation")
    if fd is not None and stat_fingerprint(os.fstat(fd)) != tuple(expected):
        raise Failure("The open source changed during preview generation")


def hash_stream(stream, deadline: Deadline) -> str:
    digest = hashlib.sha256()
    while True:
        deadline.remaining()
        block = stream.read(MIB)
        if not block:
            return digest.hexdigest()
        digest.update(block)


def read_json(path: Path, maximum: int):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > maximum:
        raise Failure(f"Invalid or oversized JSON file: {path.name}")
    try:
        return json.loads(path.read_bytes())
    except (ValueError, UnicodeError) as error:
        raise Failure(f"Invalid JSON in {path.name}") from error


def valid_key(value) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 512 and not re.search(r"[\x00-\x1f\x7f]", value)


def receipt_for(args):
    if not args.source_receipt:
        return None
    receipt = read_json(Path(args.source_receipt), 16 * 1024)
    document = receipt.get("document") if isinstance(receipt, dict) else None
    if not isinstance(document, dict) or type(receipt.get("version")) is not int or receipt["version"] != 1:
        raise Failure("Invalid source receipt")
    digest = document.get("sha256")
    if (not valid_key(document.get("key")) or type(document.get("size")) is not int
            or not 0 < document["size"] <= MAX_SOURCE_BYTES
            or not isinstance(digest, str) or not HASH.fullmatch(digest.lower())):
        raise Failure("Invalid source receipt identity")
    name = receipt.get("pdf")
    output = receipt.get("outputDirectory")
    if (not isinstance(name, str) or Path(name).name != name or name != Path(args.input).name
            or not isinstance(output, str) or not Path(output).is_absolute()):
        raise Failure("The receipt must name this PDF and an absolute outputDirectory")
    if args.output and Path(args.output).resolve() != Path(output).resolve():
        raise Failure("--output conflicts with the source receipt outputDirectory")
    if args.document_key and args.document_key != document["key"]:
        raise Failure("--document-key conflicts with the source receipt key")
    args.output = output
    args.document_key = document["key"]
    return {**document, "sha256": digest.lower()}


def page_list(text: str | None, count: int) -> list[int]:
    if not text:
        return list(range(1, count + 1))
    result = []
    seen = set()
    for part in text.split(","):
        match = re.fullmatch(r"([0-9]+)(?:-([0-9]+))?", part.strip())
        if not match:
            raise Failure(f"Invalid page selection: {part}")
        first, last = int(match[1]), int(match[2] or match[1])
        if not 1 <= first <= last <= count:
            raise Failure(f"Page selection is outside 1..{count}: {part}")
        for page in range(first, last + 1):
            if page not in seen:
                result.append(page)
                seen.add(page)
    return result


def page_phases(args, count: int) -> list[list[int]]:
    selected = page_list(args.pages, count)
    allowed = set(selected)
    priority = []
    if args.priority_spreads:
        for pair in args.priority_spreads.split(","):
            match = re.fullmatch(r"([0-9]+):([0-9]+)", pair.strip())
            if not match:
                raise Failure("Priority spreads use adjacent pairs such as 99:100")
            pages = [int(match[1]), int(match[2])]
            if abs(pages[0] - pages[1]) != 1 or any(page not in allowed for page in pages):
                raise Failure("Both pages of a priority spread must be adjacent and selected")
            priority.extend(pages)
    if args.priority_pages:
        priority.extend(page_list(args.priority_pages, count))
    if any(page not in allowed for page in priority):
        raise Failure("Priority pages must be included in --pages")
    first = list(dict.fromkeys(priority))
    remaining = [page for page in selected if page not in set(first)]
    return [phase for phase in (first, remaining) if phase]


def ordered_pages(args, count: int) -> list[int]:
    return [page for phase in page_phases(args, count) for page in phase]


def selected_tiers(text: str) -> list[int]:
    try:
        values = [int(part) for part in text.split(",")]
    except ValueError as error:
        raise Failure("--tiers must be a subset of 192,512,768,1536") from error
    if not values or len(values) != len(set(values)) or any(value not in TIERS for value in values):
        raise Failure("--tiers must be a distinct subset of 192,512,768,1536")
    return sorted(values)


def backend_for(args):
    if importlib.util.find_spec("PIL") is None:
        raise Failure("Pillow is required")
    has_fitz = importlib.util.find_spec("fitz") is not None
    renderer = args.renderer
    if renderer == "auto":
        renderer = "pymupdf" if has_fitz else "poppler"
    if renderer == "pymupdf" and not has_fitz:
        raise Failure("The pymupdf renderer requires PyMuPDF")
    if renderer == "poppler" and not all(shutil.which(name) for name in ("pdfinfo", "pdftoppm")):
        raise Failure("The poppler renderer requires pdfinfo and pdftoppm")
    if args.require_image_regions and not has_fitz:
        raise Failure("--require-image-regions requires PyMuPDF")
    return renderer, has_fitz


def worker_limits(job):
    # A parser can retain or decode original images even while collecting placement metadata.
    # Enforce these limits outside the parser, before importing it.
    limits = (
        (resource.RLIMIT_AS, int(job["memory_mib"]) * MIB),
        (resource.RLIMIT_FSIZE, int(job["file_limit"])),
        (resource.RLIMIT_CPU, max(1, math.ceil(job["timeout"]) + 1)),
    )
    for kind, value in limits:
        _, hard = resource.getrlimit(kind)
        value = value if hard == resource.RLIM_INFINITY else min(value, hard)
        resource.setrlimit(kind, (value, value))


def pdfinfo(path: Path, page: int | None = None):
    command = ["pdfinfo"]
    if page is not None:
        command += ["-f", str(page), "-l", str(page), "-box"]
    command.append(str(path))
    # Poppler diagnostics go to the worker's bounded log. Metadata is small but may contain
    # long document properties, so capture it in a size-limited file rather than an unbounded pipe.
    info_path = Path("pdfinfo.txt")
    with info_path.open("wb") as output:
        result = subprocess.run(command, stdout=output, stderr=sys.stderr, check=False)
    if result.returncode == -signal.SIGXFSZ:
        raise LimitReached("output-limit")
    if result.returncode:
        raise Failure("pdfinfo could not inspect the source PDF")
    data = info_path.read_text(errors="replace")
    info_path.unlink()
    count = re.search(r"^Pages:\s+([0-9]+)\s*$", data, re.MULTILINE)
    if page is None:
        if not count:
            raise Failure("pdfinfo returned no page count")
        return int(count[1])
    crop = re.search(r"^Page\s+" + str(page) + r"\s+CropBox:\s+([-+.\d]+)\s+([-+.\d]+)\s+([-+.\d]+)\s+([-+.\d]+)", data, re.MULTILINE)
    rotation = re.search(r"^Page\s+" + str(page) + r"\s+rot:\s+(-?[0-9]+)", data, re.MULTILINE)
    if not crop or not rotation:
        raise Failure("pdfinfo returned no page CropBox or rotation")
    x0, y0, x1, y1 = map(float, crop.groups())
    angle = int(rotation[1]) % 360
    width, height = x1 - x0, y1 - y0
    if angle in (90, 270):
        width, height = height, width
    return {"pageNumber": page, "width": width, "height": height, "rotation": angle}


def page_geometry(page, page_number: int, include_regions: bool):
    import fitz
    bounds = page.rect
    result = {"pageNumber": page_number, "width": bounds.width, "height": bounds.height, "rotation": page.rotation}
    if include_regions:
        regions = []
        complete = True
        source_regions = page.get_image_info(hashes=True, xrefs=False)
        # PyMuPDF 1.23 maps occurrence digests to the last matching xref, including
        # inline images. Only a unique resource digest on an inline-free content tree
        # is usable evidence. Unsupported/ambiguous pages retain geometry only.
        resource_digests = {}
        inline_or_unsupported = False
        try:
            content = [page.parent.xref_stream(xref) for xref in page.get_contents()]
            forms = [page.parent.xref_stream(entry[0]) for entry in page.get_xobjects()]
            if any(not isinstance(stream, bytes) for stream in content + forms):
                inline_or_unsupported = True
            else:
                # PDF content arrays are one token stream. PDF whitespace includes NUL;
                # comments and every delimiter can terminate the BI operator. False
                # positives are conservative: they only disable optional resource links.
                token_boundary = rb"[\x00\x09\x0a\x0c\x0d\x20()<>\[\]{}/%]"
                inline = re.compile(rb"(?:^|" + token_boundary + rb")BI(?=$|" + token_boundary + rb")")
                inline_or_unsupported = any(inline.search(stream) for stream in [b"\n".join(content), *forms])
            for entry in page.get_images(full=True):
                xref = entry[0]
                if type(xref) is int and xref > 0:
                    digest = fitz.Pixmap(page.parent, xref).digest
                    resource_digests.setdefault(digest, set()).add(xref)
        except (AttributeError, RuntimeError, ValueError):
            inline_or_unsupported = True
        complete = not inline_or_unsupported
        for ordinal, info in enumerate(source_regions):
            coordinates = info.get("bbox", ())
            if len(coordinates) != 4 or not all(math.isfinite(value) for value in coordinates):
                complete = False
                continue
            box = (fitz.Rect(coordinates) * page.rotation_matrix) & bounds
            if box.is_empty or not all(math.isfinite(value) for value in box):
                complete = False
                continue
            left = max(0.0, min(1.0, (box.x0 - bounds.x0) / bounds.width))
            top = max(0.0, min(1.0, (box.y0 - bounds.y0) / bounds.height))
            right = max(0.0, min(1.0, (box.x1 - bounds.x0) / bounds.width))
            bottom = max(0.0, min(1.0, (box.y1 - bounds.y0) / bounds.height))
            if right > left and bottom > top:
                region = {"id": f"p{page_number}-i{ordinal}", "x": left, "y": top,
                          "width": right - left, "height": bottom - top}
                candidates = resource_digests.get(info.get("digest"), set())
                if not inline_or_unsupported and len(candidates) == 1:
                    region["resourceId"] = f"x{next(iter(candidates))}"
                else:
                    complete = False
                regions.append(region)
            else:
                complete = False
        regions.sort(key=lambda item: (-item["width"] * item["height"], item["id"]))
        result["imageRegions"] = regions[:MAX_REGIONS_PER_PAGE]
        result["regionsOmitted"] = max(0, len(regions) - MAX_REGIONS_PER_PAGE)
        result["imageRegionsComplete"] = complete and len(regions) <= MAX_REGIONS_PER_PAGE
    return result


def worker_operation(job):
    from PIL import Image
    source = Path(job["source"])
    check_source(source, job["fingerprint"])
    document = None
    try:
        if job["has_fitz"]:
            import fitz
            document = fitz.open(source)
            if not document.is_pdf or document.needs_pass:
                raise Failure("The source must be an unencrypted PDF")
            count = document.page_count
        else:
            count = pdfinfo(source)
        if not 0 < count <= MAX_PAGES:
            raise Failure(f"The PDF page count must be within 1..{MAX_PAGES}")
        if job["operation"] == "inspect":
            result = {"pageCount": count}
        else:
            number, tier = job["page"], job["tier"]
            page = document.load_page(number - 1) if document is not None else None
            geometry = (page_geometry(page, number, job["regions"]) if page is not None
                        else pdfinfo(source, number))
            if (not all(math.isfinite(geometry[key]) and 0 < geometry[key] <= 1_000_000 for key in ("width", "height"))
                    or geometry["rotation"] not in (0, 90, 180, 270)):
                raise Failure("Invalid page geometry")
            if job["renderer"] == "pymupdf":
                scale = tier / max(geometry["width"], geometry["height"])
                pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB, alpha=False)
                image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
                del pixmap
            else:
                command = ["pdftoppm", "-f", str(number), "-l", str(number), "-singlefile",
                           "-cropbox", "-scale-to", str(tier), "-jpeg", "-jpegopt", "quality=82",
                           str(source), "rendered"]
                process = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=sys.stderr, check=False)
                if process.returncode == -signal.SIGXFSZ:
                    raise LimitReached("output-limit")
                if process.returncode:
                    raise Failure("pdftoppm could not render the requested page")
                with Image.open("rendered.jpg") as rendered:
                    if max(rendered.size) > tier + 2 or min(rendered.size) < 1:
                        raise Failure("Poppler returned an oversized preview")
                    image = rendered.convert("RGB")
                Path("rendered.jpg").unlink()
            try:
                expected = (max(1, round(geometry["width"] * tier / max(geometry["width"], geometry["height"]))),
                            max(1, round(geometry["height"] * tier / max(geometry["width"], geometry["height"]))))
                if image.size != expected:
                    smaller = image.resize(expected, Image.Resampling.LANCZOS)
                    image.close()
                    image = smaller
                image.save("preview.jpg", format="JPEG", quality=82, optimize=False)
                result = {"page": geometry, "width": image.width, "height": image.height}
            finally:
                image.close()
        check_source(source, job["fingerprint"])
        return result
    finally:
        if document is not None:
            document.close()


def worker_main() -> int:
    try:
        raw = sys.stdin.buffer.read(32 * 1024 + 1)
        if len(raw) > 32 * 1024:
            raise Failure("Worker input exceeds its bound")
        job = json.loads(raw)
        worker_limits(job)
        result = worker_operation(job)
        Path("result.json").write_text(json.dumps(result, separators=(",", ":")))
        return 0
    except MemoryError:
        return 4
    except LimitReached:
        return 3
    except OSError as error:
        if error.errno == errno.EFBIG:
            return 3
        print(str(error)[:2000], file=sys.stderr)
        return 1
    except Exception as error:
        print(str(error)[:2000], file=sys.stderr)
        return 1


async def invoke_worker(job, folder: Path, deadline: Deadline, timeout: float):
    left = deadline.remaining()
    bound = min(left, timeout)
    job = {**job, "timeout": bound}
    process = None
    with (folder / "stderr.txt").open("wb") as errors:
        try:
            process = await asyncio.create_subprocess_exec(
                sys.executable, str(Path(__file__).resolve()), "--_worker",
                cwd=folder, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL,
                stderr=errors, start_new_session=True)
            # The wall limit is a last resort for native parsers or renderers that never return.
            await asyncio.wait_for(process.communicate(json.dumps(job).encode()), timeout=bound)
            if process.returncode == 3 or process.returncode == -signal.SIGXFSZ:
                raise LimitReached("output-limit")
            if process.returncode == 4:
                raise LimitReached("worker-memory-limit")
            if process.returncode == -signal.SIGXCPU:
                raise LimitReached("worker-cpu-limit")
            if process.returncode:
                with (folder / "stderr.txt").open("rb") as stream:
                    detail = stream.read(2000).decode(errors="replace").strip()
                detail = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", " ", detail)
                raise Failure(f"PDF worker failed ({process.returncode})" + (f": {detail}" if detail else ""))
            return read_json(folder / "result.json", min(job["file_limit"], MAX_MANIFEST_BYTES))
        except asyncio.TimeoutError as error:
            if left <= timeout:
                raise LimitReached("deadline") from error
            raise LimitReached("job-deadline") from error
        finally:
            if process is not None:
                # A crashed parser can leave a Poppler descendant in the owned process group.
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                if process.returncode is None:
                    await process.wait()


def reading_path(value: str) -> bool:
    first = value.split("/", 1)[0]
    return (first in ("reading", "reading.json", ".reading-state.json", ".motionlab-reading.lock")
            or first.startswith((".reading-work-", ".reading-pending-")))


def directory_bytes(root: Path, deadline: Deadline, *, exclude_reading=False) -> int:
    total, entries = 0, 0
    def unreadable(error):
        raise Failure(f"Could not count all existing output files: {error}") from error
    for folder, directories, files in os.walk(root, followlinks=False, onerror=unreadable):
        deadline.remaining()
        for name in directories + files:
            entries += 1
            if entries > MAX_DIRECTORY_ENTRIES:
                raise Failure("The output directory contains too many entries")
            path = Path(folder) / name
            value = path.lstat()
            if stat.S_ISLNK(value.st_mode):
                raise Failure("The output directory must not contain symlinks")
            if stat.S_ISREG(value.st_mode):
                if not exclude_reading or not reading_path(path.relative_to(root).as_posix()):
                    total += value.st_size
            elif not stat.S_ISDIR(value.st_mode):
                raise Failure("The output directory contains a nonregular entry")
    return total


def safe_asset_path(root: Path, value):
    if (not isinstance(value, str) or not SAFE_ASSET.fullmatch(value)
            or reading_path(value)
            or any(part in ("", ".", "..") for part in value.split("/"))):
        raise Failure("Invalid existing preview asset path")
    result = root / value
    if result.is_symlink() or not result.is_file():
        raise Failure("An existing preview asset is missing or is a symlink")
    return result


def existing_manifest(root: Path, identity, page_count: int, deadline: Deadline):
    path = root / "manifest.json"
    if not path.exists():
        return {"version": 1, "document": {**identity, "pageCount": page_count}, "pages": []}
    value = read_json(path, MAX_MANIFEST_BYTES)
    if (not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1
            or value.get("document") != {**identity, "pageCount": page_count}
            or type(value["document"].get("pageCount")) is not int
            or not isinstance(value.get("pages"), list)):
        raise Failure("The output directory contains a manifest for a different document")
    seen_pages, seen_assets = set(), set()
    region_count = 0
    for page in value["pages"]:
        number = page.get("pageNumber") if isinstance(page, dict) else None
        if (type(number) is not int or not 1 <= number <= page_count or number in seen_pages
                or not all(type(page.get(key)) in (int, float) and math.isfinite(page[key])
                           and 0 < page[key] <= 1_000_000 for key in ("width", "height"))
                or type(page.get("rotation")) not in (int, float) or page["rotation"] not in (0, 90, 180, 270)
                or not isinstance(page.get("assets"), list) or len(page["assets"]) > 6):
            raise Failure("Invalid existing preview page")
        seen_pages.add(number)
        regions = page.get("imageRegions", [])
        if not isinstance(regions, list) or len(regions) > MAX_REGIONS_PER_PAGE:
            raise Failure("Invalid existing image regions")
        if "imageRegionsComplete" in page and type(page["imageRegionsComplete"]) is not bool:
            raise Failure("Invalid existing occurrence completeness")
        if page.get("imageRegionsComplete") and "imageRegions" not in page:
            raise Failure("Complete occurrence inventory is missing")
        region_count += len(regions)
        region_ids = set()
        for region in regions:
            if (not isinstance(region, dict) or not isinstance(region.get("id"), str)
                    or not re.fullmatch(r"[a-zA-Z0-9._:-]{1,128}", region["id"])
                    or region["id"] in region_ids
                    or not all(type(region.get(key)) in (int, float) and math.isfinite(region[key])
                               for key in ("x", "y", "width", "height"))
                    or not 0 <= region["x"] < 1 or not 0 <= region["y"] < 1
                    or not 0 < region["width"] <= 1 - region["x"] + 0.000001
                    or not 0 < region["height"] <= 1 - region["y"] + 0.000001):
                raise Failure("Invalid existing image region")
            if "resourceId" in region and (not isinstance(region["resourceId"], str) or not re.fullmatch(r"x[1-9][0-9]*", region["resourceId"])):
                raise Failure("Invalid existing image resource")
            if page.get("imageRegionsComplete") and "resourceId" not in region:
                raise Failure("Complete occurrence inventory has an unlinked image")
            region_ids.add(region["id"])
        for asset in page["assets"]:
            if not isinstance(asset, dict):
                raise Failure("Invalid existing preview asset")
            asset_path = safe_asset_path(root, asset.get("path"))
            if asset["path"] in seen_assets:
                raise Failure("Duplicate existing preview asset")
            seen_assets.add(asset["path"])
            if (not all(type(asset.get(key)) is int and 0 < asset[key] <= 4096 for key in ("width", "height"))
                    or asset.get("mime") != "image/jpeg"
                    or type(asset.get("bytes")) is not int or not 0 < asset["bytes"] <= MAX_ASSET_BYTES
                    or not isinstance(asset.get("sha256"), str) or not HASH.fullmatch(asset["sha256"])
                    or asset_path.stat().st_size != asset["bytes"]
                    or abs(asset["width"] * page["height"] - asset["height"] * page["width"]) > 2 * max(page["width"], page["height"])):
                raise Failure("Invalid existing preview asset")
            with asset_path.open("rb") as stream:
                if hash_stream(stream, deadline) != asset["sha256"]:
                    raise Failure("An existing preview asset checksum differs")
            from PIL import Image
            try:
                with Image.open(asset_path) as image:
                    if image.format != "JPEG" or image.size != (asset["width"], asset["height"]):
                        raise Failure("An existing preview image's encoded dimensions or format differ")
                    image.verify()
            except Failure:
                raise
            except Exception as error:
                raise Failure("An existing preview image is invalid") from error
    if len(seen_assets) > MAX_ASSETS or region_count > MAX_REGIONS:
        raise Failure("The existing manifest exceeds its bounds")
    return value


def sync_directory(path: Path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class Publisher:
    def __init__(self, root: Path, identity, page_count, quota: int, deadline: Deadline):
        self.root = root
        self.quota = quota
        self.deadline = deadline
        self.used = directory_bytes(root, deadline, exclude_reading=True)
        if self.used > quota:
            raise LimitReached("output-limit")
        self.manifest = existing_manifest(root, identity, page_count, deadline)
        self.pages = {page["pageNumber"]: page for page in self.manifest["pages"]}
        self.manifest_size = (root / "manifest.json").stat().st_size if (root / "manifest.json").exists() else 0
        self.reserve = min(MAX_MANIFEST_BYTES, max(MIN_JOB_FILE_BYTES, quota // 16))
        self.assets = sum(len(page["assets"]) for page in self.pages.values())
        self.regions = sum(len(page.get("imageRegions", [])) for page in self.pages.values())

    def has(self, page: int, tier: int) -> bool:
        return any(max(asset["width"], asset["height"]) == tier for asset in self.pages.get(page, {}).get("assets", []))

    def file_limit(self, reservations: int) -> int:
        # Each child may simultaneously hold a renderer image, metadata file and diagnostic log.
        return max(0, min(MAX_ASSET_BYTES, (self.quota - self.used - self.reserve - reservations) // 3))

    def publish(self, result, folder: Path, page_number: int, tier: int, reservations: int):
        self.deadline.remaining()
        source = folder / "preview.jpg"
        size = source.stat().st_size
        if not 0 < size <= MAX_ASSET_BYTES:
            raise Failure("The renderer produced an invalid asset size")
        with source.open("rb") as stream:
            digest = hash_stream(stream, self.deadline)
        width, height = result["width"], result["height"]
        if type(width) is not int or type(height) is not int or min(width, height) < 1 or max(width, height) != tier:
            raise Failure("The renderer produced invalid preview dimensions")
        geometry = result["page"]
        if geometry.get("pageNumber") != page_number:
            raise Failure("The renderer returned a different page")
        current = self.pages.get(page_number)
        if current:
            # pdfinfo formats CropBox coordinates to two decimals; native PyMuPDF keeps floats.
            # Allow that bounded rounding when adding placement metadata to Poppler previews.
            same_size = all(math.isclose(current[key], geometry[key], rel_tol=1e-7, abs_tol=0.02)
                            for key in ("width", "height"))
            if current["rotation"] != geometry["rotation"] or not same_size:
                raise Failure("Page geometry differs from the existing manifest")
        replacing = bool(current and any(max(asset["width"], asset["height"]) == tier for asset in current["assets"]))
        if self.assets >= MAX_ASSETS and not replacing:
            raise LimitReached("manifest-limit")
        candidate = dict(current) if current else {key: geometry[key] for key in ("pageNumber", "width", "height", "rotation")}
        candidate["assets"] = [asset for asset in current["assets"] if max(asset["width"], asset["height"]) != tier] if current else []
        if len(candidate["assets"]) >= 6:
            raise LimitReached("manifest-limit")
        omitted = geometry.get("regionsOmitted", 0)
        if "imageRegionsComplete" not in candidate and "imageRegions" in geometry:
            candidate["imageRegions"] = geometry["imageRegions"][:max(0, MAX_REGIONS - self.regions + len(candidate.get("imageRegions", [])))]
            omitted += len(geometry["imageRegions"]) - len(candidate["imageRegions"])
            candidate["imageRegionsComplete"] = geometry.get("imageRegionsComplete") is True and omitted == 0
        relative = f"assets/p{page_number:05d}-{tier}-{digest}.jpg"
        asset = {"path": relative, "width": width, "height": height, "bytes": size, "sha256": digest, "mime": "image/jpeg"}
        candidate["assets"].append(asset)
        candidate["assets"].sort(key=lambda item: max(item["width"], item["height"]))
        pages = {**self.pages, page_number: candidate}
        manifest = {**self.manifest, "pages": [pages[number] for number in sorted(pages)]}
        payload = json.dumps(manifest, separators=(",", ":"), ensure_ascii=True).encode() + b"\n"
        if len(payload) > min(MAX_MANIFEST_BYTES, self.reserve):
            raise LimitReached("manifest-limit")
        target = self.root / relative
        added = 0 if target.exists() else size
        if self.used + added + len(payload) + reservations > self.quota:
            raise LimitReached("output-limit")
        target.parent.mkdir(exist_ok=True)
        if target.exists():
            if target.is_symlink() or target.stat().st_size != size:
                raise Failure("An immutable asset path contains different data")
            with target.open("rb") as stream:
                if hash_stream(stream, self.deadline) != digest:
                    raise Failure("An immutable asset path checksum differs")
            source.unlink()
        else:
            with source.open("rb") as stream:
                os.fsync(stream.fileno())
            os.replace(source, target)
            sync_directory(target.parent)
        self.used += added
        temporary = self.root / ".manifest.pending"
        if temporary.exists() or temporary.is_symlink():
            raise Failure("A previous manifest publication file must be inspected before retrying")
        try:
            with temporary.open("xb") as output:
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, self.root / "manifest.json")
            sync_directory(self.root)
        finally:
            temporary.unlink(missing_ok=True)
        self.used += len(payload) - self.manifest_size
        self.manifest_size = len(payload)
        self.pages = pages
        self.manifest = manifest
        self.assets += 0 if replacing else 1
        self.regions = sum(len(page.get("imageRegions", [])) for page in pages.values())
        emit("asset", pageNumber=page_number, tier=tier, path=relative, bytes=size,
             regions=len(candidate.get("imageRegions", [])), regionsOmitted=omitted)


async def generate(args, source: Path, source_fd: int, expected, identity, page_count, renderer, has_fitz, deadline: Deadline):
    root = Path(args.output).expanduser().resolve()
    if root == source or root.is_file():
        raise Failure("The output must be a directory separate from the PDF")
    root.mkdir(parents=True, exist_ok=True)
    lock = os.open(root / ".motionlab.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    active = {}
    staging = None
    publisher = None
    completed = 0
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Failure("Another preview generator owns this output directory") from error
        publisher = Publisher(root, identity, page_count, int(args.max_output_mib * MIB), deadline)
        phases = page_phases(args, page_count)
        pages = [page for phase in phases for page in phase]
        tiers = selected_tiers(args.tiers)
        staging = Path(tempfile.mkdtemp(prefix=".motionlab-work-", dir=root))
        emit("start", document=identity, pageCount=page_count, selectedPages=pages, tiers=tiers,
             priorityPages=phases[0] if args.priority_pages or args.priority_spreads else [],
             renderer=renderer, imageRegions=has_fitz, workers=args.workers)
        reservations = 0
        ordinal = 0
        for phase, tier in ((phase, tier) for phase in phases for tier in tiers):
            queue = [page for page in phase if not publisher.has(page, tier)
                     or has_fitz and "imageRegionsComplete" not in publisher.pages.get(page, {})]
            index = 0
            while index < len(queue) or active:
                deadline.remaining()
                while index < len(queue) and len(active) < args.workers:
                    cap = publisher.file_limit(reservations)
                    if cap < MIN_JOB_FILE_BYTES:
                        break
                    number = queue[index]
                    index += 1
                    ordinal += 1
                    folder = staging / str(ordinal)
                    folder.mkdir()
                    job = {"operation": "render", "source": str(source), "fingerprint": expected,
                           "page": number, "tier": tier, "renderer": renderer, "has_fitz": has_fitz,
                           "regions": has_fitz and "imageRegionsComplete" not in publisher.pages.get(number, {}),
                           "memory_mib": args.max_worker_mib, "file_limit": cap}
                    task = asyncio.create_task(invoke_worker(job, folder, deadline, args.job_timeout_seconds))
                    active[task] = (number, folder, cap * 3, ordinal)
                    reservations += cap * 3
                if not active:
                    raise LimitReached("output-limit")
                done, _ = await asyncio.wait(active, timeout=deadline.remaining(), return_when=asyncio.FIRST_COMPLETED)
                if not done:
                    raise LimitReached("deadline")
                for task in sorted(done, key=lambda value: active[value][3]):
                    number, folder, reserved, _ = active.pop(task)
                    reservations -= reserved
                    try:
                        result = task.result()
                        check_source(source, expected, source_fd)
                        # Retire metadata/log files before transferring the completed asset's reservation.
                        (folder / "result.json").unlink(missing_ok=True)
                        (folder / "stderr.txt").unlink(missing_ok=True)
                        publisher.publish(result, folder, number, tier, reservations)
                        completed += 1
                    finally:
                        shutil.rmtree(folder, ignore_errors=True)
        check_source(source, expected, source_fd)
        emit("complete", manifest=str(root / "manifest.json"), pages=len(publisher.pages),
             assets=publisher.assets, publishedAssets=completed, outputBytes=publisher.used)
        return 0
    except LimitReached as error:
        emit("partial", reason=str(error), manifest=str(root / "manifest.json") if (root / "manifest.json").is_file() else None,
             publishedAssets=completed, assets=publisher.assets if publisher else 0,
             outputBytes=publisher.used if publisher else 0)
        return 3
    finally:
        for task in active:
            task.cancel()
        if active:
            await asyncio.gather(*active, return_exceptions=True)
        if staging is not None:
            shutil.rmtree(staging, ignore_errors=True)
        os.close(lock)


async def run(args):
    deadline = Deadline(args.deadline_seconds)
    receipt = receipt_for(args)
    if not args.output:
        raise Failure("--output is required without a source receipt")
    if args.document_key is not None and not valid_key(args.document_key):
        raise Failure("Invalid document key")
    selected_tiers(args.tiers)
    renderer, has_fitz = backend_for(args)
    source = Path(args.input).expanduser().absolute()
    expected = fingerprint(source)
    if not 0 < expected[2] <= MAX_SOURCE_BYTES:
        raise Failure("The source must be nonempty and at most 4 GiB")
    if receipt and receipt["size"] != expected[2]:
        raise Failure("The source size differs from its receipt")
    with source.open("rb") as stream:
        if stat_fingerprint(os.fstat(stream.fileno())) != expected:
            raise Failure("The source changed before hashing")
        digest = hash_stream(stream, deadline)
        check_source(source, expected, stream.fileno())
        if receipt and digest != receipt["sha256"]:
            raise Failure("The source SHA-256 differs from its receipt")
        identity = {"key": args.document_key or "sha256:" + digest, "size": expected[2], "sha256": digest}
        with tempfile.TemporaryDirectory(prefix="motionlab-inspect-") as directory:
            job = {"operation": "inspect", "source": str(source), "fingerprint": expected,
                   "renderer": renderer, "has_fitz": has_fitz,
                   "memory_mib": args.max_worker_mib, "file_limit": MIN_JOB_FILE_BYTES}
            result = await invoke_worker(job, Path(directory), deadline, args.job_timeout_seconds)
        count = result["pageCount"]
        ordered_pages(args, count)
        check_source(source, expected, stream.fileno())
        return await generate(args, source, stream.fileno(), expected, identity, count, renderer, has_fitz, deadline)


async def run_with_signals(args):
    loop = asyncio.get_running_loop()
    current = asyncio.current_task()
    previous = signal.getsignal(signal.SIGTERM)
    loop.add_signal_handler(signal.SIGTERM, current.cancel)
    try:
        return await run(args)
    finally:
        loop.remove_signal_handler(signal.SIGTERM)
        signal.signal(signal.SIGTERM, previous)


def parser():
    result = CommandParser(description=__doc__)
    result.add_argument("input", help="Local, unencrypted source PDF")
    result.add_argument("--output", help="Directory for manifest.json and immutable assets")
    result.add_argument("--source-receipt", help="Exact-build export receipt; supplies output and document key")
    result.add_argument("--pages", help="Selected one-based pages, for example 1,5-8")
    result.add_argument("--priority-pages", help="Selected pages whose whole pyramid is prepared before other pages")
    result.add_argument("--priority-spreads", help="Adjacent selected pairs to prepare first, for example 99:100,101:102")
    result.add_argument("--tiers", default=",".join(map(str, TIERS)), help="Subset of 192,512,768,1536; longest pixel edge")
    result.add_argument("--document-key", help="Exact external representation key; default sha256:<source digest>")
    result.add_argument("--workers", type=int, choices=(1, 2), default=1, help="Renderer processes; default 1")
    result.add_argument("--max-output-mib", type=finite_positive, default=512, help="Total file-byte budget in the output directory")
    result.add_argument("--deadline-seconds", type=finite_positive, default=600, help="Whole invocation wall deadline, including hashing")
    result.add_argument("--job-timeout-seconds", type=finite_positive, default=60, help="Last-resort wall deadline per native PDF job")
    result.add_argument("--max-worker-mib", type=int, default=4096, help="Address-space limit per native PDF worker")
    result.add_argument("--renderer", choices=("auto", "pymupdf", "poppler"), default="auto")
    result.add_argument("--require-image-regions", action="store_true", help="Fail before generation unless PyMuPDF placement metadata is available")
    return result


def main():
    args = parser().parse_args()
    if not 128 <= args.max_worker_mib <= 16 * 1024:
        parser().error("--max-worker-mib must be within 128..16384")
    if args.max_output_mib > 1024 * 1024:
        parser().error("--max-output-mib must be at most 1048576")
    if args.deadline_seconds > 86400 or args.job_timeout_seconds > 3600:
        parser().error("The whole deadline is at most 86400 seconds and the job deadline at most 3600")
    try:
        return asyncio.run(run_with_signals(args))
    except asyncio.CancelledError:
        print(json.dumps({"event": "error", "message": "Preview generation terminated"}), file=sys.stderr)
        return 143
    except LimitReached as error:
        emit("partial", reason=str(error), manifest=None, publishedAssets=0)
        return 3
    except (Failure, OSError, ValueError) as error:
        print(json.dumps({"event": "error", "message": str(error)}, separators=(",", ":")), file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print(json.dumps({"event": "error", "message": "Preview generation interrupted"}), file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(worker_main() if sys.argv[1:] == ["--_worker"] else main())
