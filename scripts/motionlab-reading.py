#!/usr/bin/env python3
"""Produce a small PDF reading document and verified external image streams."""
from __future__ import annotations

import argparse
import asyncio
import collections
import contextlib
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


_spec = importlib.util.spec_from_file_location("motionlab_preview_protocol", Path(__file__).with_name("motionlab-previews.py"))
PROTOCOL = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(PROTOCOL)
MIB = PROTOCOL.MIB
FORMAT_PATH = Path(__file__).resolve().parent.parent / "src" / "core" / "pdfReadingFormat.json"
if not FORMAT_PATH.is_file():
    FORMAT_PATH = Path(__file__).resolve().with_name("pdfReadingFormat.json")
FORMAT = json.loads(FORMAT_PATH.read_text())
LIMITS = FORMAT["limits"]
VERSION = FORMAT["version"]
MAX_MANIFEST_BYTES = LIMITS["manifestBytes"]
MAX_SOURCE_BYTES = LIMITS["sourceBytes"]
MAX_PAGES = LIMITS["pages"]
MAX_PDF_BYTES = LIMITS["pdfBytes"]
MAX_IMAGE_BYTES = LIMITS["assetBytes"]
MAX_IMAGES = LIMITS["images"]
MAX_DIMENSION = LIMITS["dimension"]
MAX_PIXELS = LIMITS["pixels"]
MAX_PROGRESSIVE_PIXELS = LIMITS["progressivePixels"]
MAX_COEFFICIENT_BYTES = LIMITS["coefficientBytes"]
MAX_CHUNKS = LIMITS["chunks"]
IMAGE_ID = re.compile(FORMAT["syntax"]["imageId"])
HASH = re.compile(FORMAT["syntax"]["sha256"])
PATH_SEGMENT = re.compile(FORMAT["syntax"]["pathSegment"])
MARKER = "MotionLabImage"
LOCK = ".motionlab-reading.lock"
STATE = ".reading-state.json"
STAGING = ".reading-work-"
PENDING = re.compile(r"^\.reading-pending-[a-z0-9_]{8}$")
VERIFIER_SOURCE = Path(__file__).parent / "pdf-jpeg-progressive" / "coefficients.c"


class Failure(PROTOCOL.Failure):
    pass


def sha(data):
    return hashlib.sha256(data).hexdigest()


def integer(value, maximum):
    return type(value) is int and 0 < value <= maximum


def asset_path(value):
    return (isinstance(value, str) and len(value) <= LIMITS["pathLength"]
            and value.startswith("reading/")
            and all(part not in ("", ".", "..") and PATH_SEGMENT.fullmatch(part) for part in value.split("/")))


def validate_asset(value, maximum):
    if (not isinstance(value, dict) or not asset_path(value.get("path"))
            or not integer(value.get("bytes"), maximum)
            or not isinstance(value.get("sha256"), str) or not HASH.fullmatch(value["sha256"])):
        raise Failure("Invalid reading asset metadata")


def validate_image(image):
    validate_asset(image, MAX_IMAGE_BYTES)
    if (not isinstance(image.get("id"), str) or not IMAGE_ID.fullmatch(image["id"])
            or not isinstance(image.get("originalSha256"), str) or not HASH.fullmatch(image["originalSha256"])
            or not integer(image.get("width"), MAX_DIMENSION) or not integer(image.get("height"), MAX_DIMENSION)
            or image["width"] * image["height"] > MAX_PIXELS):
        raise Failure("Invalid reading image identity or dimensions")
    if image.get("encoding") == "original":
        if image["sha256"] != image["originalSha256"] or "coefficientBytes" in image or "chunks" in image:
            raise Failure("An original encoded image cannot advertise progressive scans")
        if image.get("components") is not None and not integer(image["components"], LIMITS["components"]):
            raise Failure("Invalid original image component count")
        if image.get("fallbackReason") is not None and (not isinstance(image["fallbackReason"], str)
                or not 0 < len(image["fallbackReason"]) <= LIMITS["fallbackReasonLength"]):
            raise Failure("Invalid original image fallback reason")
        return
    chunks = image.get("chunks")
    if (image.get("encoding") != "progressive-jpeg" or image.get("components") != LIMITS["progressiveComponents"]
            or image["width"] * image["height"] > MAX_PROGRESSIVE_PIXELS
            or not integer(image.get("coefficientBytes"), MAX_COEFFICIENT_BYTES)
            or not isinstance(chunks, list) or not 1 <= len(chunks) <= MAX_CHUNKS):
        raise Failure("Invalid progressive JPEG metadata")
    cursor = 0
    for number, chunk in enumerate(chunks, 1):
        if (not isinstance(chunk, dict) or type(chunk.get("offset")) is not int or chunk["offset"] != cursor
                or not integer(chunk.get("bytes"), MAX_IMAGE_BYTES)
                or type(chunk.get("scan")) is not int or chunk["scan"] != number
                or not isinstance(chunk.get("sha256"), str) or not HASH.fullmatch(chunk["sha256"])):
            raise Failure("Progressive chunks must be an ordered, verified partition")
        cursor += chunk["bytes"]
    if cursor != image["bytes"]:
        raise Failure("Progressive chunk bytes differ from the encoded asset")


def validate_manifest(value, expected_sha=None, byte_budget=None):
    if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != VERSION:
        raise Failure("Unsupported reading manifest version")
    source = value.get("source")
    if (not isinstance(source, dict) or not isinstance(source.get("sha256"), str)
            or not HASH.fullmatch(source["sha256"])
            or expected_sha is not None and source["sha256"] != expected_sha
            or not integer(source.get("size"), MAX_SOURCE_BYTES)
            or not integer(source.get("pageCount"), MAX_PAGES)):
        raise Failure("Reading manifest source identity differs")
    pdf = value.get("pdf")
    validate_asset(pdf, MAX_PDF_BYTES)
    images = value.get("images")
    if not isinstance(images, list) or len(images) > MAX_IMAGES:
        raise Failure("Invalid reading image count")
    ids = set()
    assets = {pdf["path"]: pdf}
    for image in images:
        validate_image(image)
        if image["id"] in ids:
            raise Failure("Duplicate source image ID")
        ids.add(image["id"])
        old = assets.get(image["path"])
        if old is not None and any(old.get(key) != image.get(key) for key in ("sha256", "bytes", "encoding", "chunks")):
            raise Failure("A reading asset path has conflicting metadata")
        assets[image["path"]] = image
    for name in assets:
        parts = name.split("/")
        if any("/".join(parts[:end]) in assets for end in range(1, len(parts))):
            raise Failure("Reading asset paths conflict as files and directories")
    total = sum(asset["bytes"] for asset in assets.values())
    if byte_budget is not None and total > byte_budget:
        raise Failure("Reading assets exceed their explicit byte budget")
    return list(assets.values()), total


def regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise Failure("A reading asset must be a regular file")
    return info


def verified_asset(root, asset, deadline, chunks=None):
    path = root / asset["path"]
    if path.resolve() != path or root not in path.parents:
        raise Failure("A reading asset path leaves its owned directory")
    before = regular(path)
    if before.st_size != asset["bytes"]:
        raise Failure("Reading asset byte count differs")
    digest = hashlib.sha256()
    chunk_index, chunk_bytes = 0, 0
    chunk_digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(MIB):
            deadline.remaining()
            digest.update(block)
            if chunks:
                cursor = 0
                while cursor < len(block):
                    if chunk_index >= len(chunks):
                        raise Failure("Reading image exceeds its chunk partition")
                    part = min(len(block) - cursor, chunks[chunk_index]["bytes"] - chunk_bytes)
                    chunk_digest.update(block[cursor:cursor + part])
                    cursor += part
                    chunk_bytes += part
                    if chunk_bytes == chunks[chunk_index]["bytes"]:
                        if chunk_digest.hexdigest() != chunks[chunk_index]["sha256"]:
                            raise Failure("Reading image chunk checksum differs")
                        chunk_index += 1
                        chunk_bytes = 0
                        chunk_digest = hashlib.sha256()
        if PROTOCOL.stat_fingerprint(os.fstat(stream.fileno())) != PROTOCOL.stat_fingerprint(before):
            raise Failure("Reading asset changed while verified")
    if digest.hexdigest() != asset["sha256"] or chunks and chunk_index != len(chunks):
        raise Failure("Reading asset checksum differs")


def verify_manifest(root, value, deadline, quota):
    assets, total = validate_manifest(value, byte_budget=quota)
    for asset in assets:
        verified_asset(root, asset, deadline, asset.get("chunks"))
    return total


def jpeg_structure(data, *, allow_trailing=False):
    """Read one JPEG; generated scan chunks include their next marker.

    A PDF's original DCT stream may contain camera metadata, padding or another
    image after EOI. Native decoding ends at that EOI. Generated assets instead
    require EOI to end the file so their verified scan table covers every byte.
    """
    if data[:2] != b"\xff\xd8":
        raise Failure("JPEG has no SOI marker")
    position, scan, frame, chunks, start = 2, 0, None, [], 0
    color_markers = []
    while position < len(data):
        marker_start = position
        if data[position] != 255:
            raise Failure("JPEG marker is missing")
        while position < len(data) and data[position] == 255:
            position += 1
        if position == len(data):
            raise Failure("JPEG marker is truncated")
        marker = data[position]
        position += 1
        if marker == 0xD9:
            if (position != len(data) and not allow_trailing) or frame is None or not chunks:
                raise Failure("JPEG end or trailing bytes are invalid")
            return {**frame, "chunks": chunks, "scans": scan, "colorMarkers": color_markers}
        if marker in (0, 0xD8) or 0xD0 <= marker <= 0xD7:
            raise Failure("Unexpected JPEG marker outside entropy")
        if marker == 1:
            continue
        if position + 2 > len(data):
            raise Failure("JPEG segment length is truncated")
        length = int.from_bytes(data[position:position + 2], "big")
        end = position + length
        if length < 2 or end > len(data):
            raise Failure("JPEG segment exceeds the encoded input")
        if 0xE0 <= marker <= 0xEF:
            color_markers.append((marker, sha(data[position + 2:end])))
        if marker in (0xC0, 0xC1, 0xC2):
            body = data[position + 2:end]
            if frame is not None or len(body) < 6 or len(body) != 6 + 3 * body[5]:
                raise Failure("JPEG frame components are invalid")
            components = body[5]
            width, height = int.from_bytes(body[3:5], "big"), int.from_bytes(body[1:3], "big")
            sampling = [(body[7 + 3 * i] >> 4, body[7 + 3 * i] & 15) for i in range(components)]
            if not sampling or any(not 1 <= h <= 4 or not 1 <= v <= 4 for h, v in sampling):
                raise Failure("JPEG component sampling is invalid")
            mx = math.ceil(width / (8 * max(h for h, _ in sampling)))
            my = math.ceil(height / (8 * max(v for _, v in sampling)))
            frame = {"width": width, "height": height, "components": components, "precision": body[0],
                     "coefficientBytes": sum(64 * my * v * (mx * h + 1) * LIMITS["coefficientElementBytes"] for h, v in sampling),
                     "progressive": marker == 0xC2}
        elif marker in (0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            raise Failure("JPEG frame encoding is unsupported")
        position = end
        if marker != 0xDA:
            continue
        if frame is None:
            raise Failure("JPEG scan precedes its frame")
        scan += 1
        if scan > MAX_CHUNKS:
            raise Failure("JPEG scan count exceeds its bound")
        while True:
            boundary = data.find(b"\xff", position)
            if boundary < 0:
                raise Failure("JPEG entropy scan is truncated")
            following = boundary + 1
            while following < len(data) and data[following] == 255:
                following += 1
            if following == len(data):
                raise Failure("JPEG entropy marker is truncated")
            code = data[following]
            if code == 0 or 0xD0 <= code <= 0xD7:
                position = following + 1
                continue
            boundary_end = following + 1
            chunks.append({"offset": start, "bytes": boundary_end - start,
                           "sha256": sha(data[start:boundary_end]), "scan": scan})
            start = boundary_end
            position = boundary
            break
    raise Failure("JPEG has no EOI marker")


def progressive_reason(frame):
    if frame["precision"] != LIMITS["progressivePrecision"]:
        return "precision"
    if frame["components"] != LIMITS["progressiveComponents"]:
        return "components"
    if frame["width"] * frame["height"] > MAX_PROGRESSIVE_PIXELS:
        return "pixels"
    if frame["coefficientBytes"] > MAX_COEFFICIENT_BYTES:
        return "coefficients"
    return None


def owned_bytes(root, deadline):
    total = 0
    image_root = root / "reading"
    if image_root.exists() or image_root.is_symlink():
        if image_root.is_symlink() or not image_root.is_dir():
            raise Failure("The reading asset directory is not an ordinary directory")
        total = PROTOCOL.directory_bytes(image_root, deadline)
    for name in ("reading.json", STATE):
        path = root / name
        if path.exists() or path.is_symlink():
            total += regular(path).st_size
    return total


def json_bytes(value, maximum=MAX_MANIFEST_BYTES):
    payload = json.dumps(value, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode() + b"\n"
    if len(payload) > maximum:
        raise Failure("Reading metadata exceeds its byte bound")
    return payload


def atomic_bytes(path, payload, deadline):
    fd, pending = tempfile.mkstemp(prefix=".reading-pending-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        deadline.remaining()
        os.replace(pending, path)
        PROTOCOL.sync_directory(path.parent)
    finally:
        Path(pending).unlink(missing_ok=True)
    return len(payload)


def atomic_json(path, value, deadline, maximum=MAX_MANIFEST_BYTES):
    return atomic_bytes(path, json_bytes(value, maximum), deadline)


class Output:
    def __init__(self, root, quota, deadline):
        self.root, self.quota, self.deadline = root, quota, deadline
        self.used = owned_bytes(root, deadline)
        if self.used > quota:
            raise PROTOCOL.LimitReached("reading-output-limit")
        (root / "reading").mkdir(exist_ok=True)

    def asset(self, data, kind, suffix, maximum):
        self.deadline.remaining()
        if not 0 < len(data) <= maximum:
            raise Failure("Reading asset exceeds its encoded byte bound")
        value = {"path": f"reading/{kind}-{sha(data)}.{suffix}", "sha256": sha(data), "bytes": len(data)}
        target = self.root / value["path"]
        if target.exists() or target.is_symlink():
            verified_asset(self.root, value, self.deadline)
            return value
        if self.used + len(data) > self.quota:
            raise PROTOCOL.LimitReached("reading-output-limit")
        fd, pending = tempfile.mkstemp(prefix=".reading-pending-", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            self.deadline.remaining()
            os.link(pending, target)
            PROTOCOL.sync_directory(target.parent)
        finally:
            Path(pending).unlink(missing_ok=True)
        self.used += len(data)
        return value

    def metadata(self, name, value):
        path = self.root / name
        payload = json_bytes(value)
        previous = regular(path).st_size if path.exists() or path.is_symlink() else 0
        # The old checkpoint remains owned until the replacement is committed.
        # Account for both bytes before creating its temporary file.
        if self.used + len(payload) > self.quota:
            raise PROTOCOL.LimitReached("reading-output-limit")
        atomic_bytes(path, payload, self.deadline)
        self.used += len(payload) - previous


def coverage(images, inventory=None):
    modes = collections.Counter(image["encoding"] for image in images)
    reasons = collections.Counter(image["fallbackReason"] for image in images if image["encoding"] == "original")
    def distribution(field, rows=images):
        values = sorted(image[field] for image in rows if field in image)
        return {name: values[min(len(values) - 1, math.ceil(fraction * len(values)) - 1)] if values else 0
                for name, fraction in (("median", .5), ("p95", .95), ("p99", .99), ("max", 1))}
    result = {"images": len(images), "progressiveImages": modes["progressive-jpeg"],
            "originalImages": modes["original"], "fallbackReasons": dict(reasons),
            "progressiveBytes": sum(image["bytes"] for image in images if image["encoding"] == "progressive-jpeg"),
            "originalBytes": sum(image["bytes"] for image in images if image["encoding"] == "original"),
            "encodedBytes": distribution("bytes"), "coefficientBytes": distribution("coefficientBytes"),
            "largestPixels": max((image["width"] * image["height"] for image in images), default=0)}
    if inventory is not None:
        result.update(sourceEncodedBytes=distribution("bytes", inventory),
                      sourceCoefficientBytes=distribution("coefficientBytes", inventory),
                      jpegImages=sum(item["jpeg"] for item in inventory),
                      eligibleJpegImages=sum(item["eligible"] for item in inventory),
                      eligibleJpegBytes=sum(item["bytes"] for item in inventory if item["eligible"]),
                      fallbackEncodedBytes={reason: sum(item["bytes"] for item in inventory if item["reason"] == reason)
                                            for reason in reasons})
    return result


def verify_jpeg(job, original, converted, deadline, *, transcode):
    error_path = Path(job["staging"]) / "verifier-error.txt"
    with error_path.open("wb") as errors:
        try:
            result = subprocess.run([job["tool"], str(original), str(converted), os.devnull,
                                     "--early-dc" if transcode else "--verify-only"],
                                    stdout=subprocess.PIPE, stderr=errors,
                                    timeout=min(job["job_timeout"], deadline.remaining()), check=False)
        except subprocess.TimeoutExpired as error:
            raise Failure("Lossless JPEG verification exceeded its native job deadline") from error
    if result.returncode or len(result.stdout) > 16 * 1024:
        detail = error_path.read_bytes()[:1000].decode(errors="replace").strip()
        raise Failure("Lossless JPEG coefficient/color verification failed" + (": " + detail if detail else ""))
    proof = json.loads(result.stdout)
    if not all(proof.get(field) is True for field in ("referencedQuantTablesEqual", "componentSamplingEqual", "coefficientsEqual")):
        raise Failure("Lossless JPEG verifier did not confirm all source coefficients")
    error_path.unlink()


def checked_progressive(encoded, original):
    converted = jpeg_structure(encoded)
    if (original is None or not converted["progressive"] or progressive_reason(converted) is not None
            or any(converted[key] != original[key] for key in ("width", "height", "components", "coefficientBytes", "colorMarkers"))):
        raise Failure("Verified progressive JPEG metadata differs")
    return converted


def reusable_images(root, job):
    """Resume a checkpoint against the completed manifest it is refreshing."""
    cached, recheck = {}, set()
    revision = job.get("refresh_revision")
    if revision is not None:
        completed = PROTOCOL.read_json(root / "reading.json", MAX_MANIFEST_BYTES)
        if sha(json_bytes(completed)) != revision:
            raise Failure("The completed reading manifest changed before refresh")
        validate_manifest(completed, job["identity"]["sha256"], job["quota"])
        for image in completed["images"]:
            cached[image["id"]] = image
            if image["encoding"] == "progressive-jpeg":
                recheck.add(image["id"])
    state_path = root / STATE
    if state_path.exists():
        saved = PROTOCOL.read_json(state_path, MAX_MANIFEST_BYTES)
        if (saved.get("version") != VERSION or saved.get("source") != job["identity"]
                or not isinstance(saved.get("verifier"), str) or not HASH.fullmatch(saved["verifier"])
                or not isinstance(saved.get("images"), list)
                or saved.get("baseManifest") is not None and (not isinstance(saved["baseManifest"], str)
                    or not HASH.fullmatch(saved["baseManifest"]))):
            raise Failure("Partial reading work belongs to a different source or producer")
        # A crash after manifest replacement can leave the previous checkpoint.
        # Its old base must not overwrite the newly completed representation.
        if saved.get("baseManifest") != revision:
            return cached, recheck
        seen = set()
        for image in saved["images"]:
            validate_image(image)
            identifier = image["id"]
            if identifier in seen:
                raise Failure("Duplicate partial reading image")
            seen.add(identifier)
            cached[identifier] = image
            recheck.discard(identifier)
            if image["encoding"] == "progressive-jpeg" and saved["verifier"] != job["verifier"]:
                recheck.add(identifier)
    return cached, recheck


def prepare(job):
    import fitz
    source, root, staging = Path(job["source"]), Path(job["output"]), Path(job["staging"])
    deadline = PROTOCOL.Deadline(job["timeout"])
    output = Output(root, job["quota"], deadline)
    PROTOCOL.check_source(source, job["fingerprint"])
    images, inventory = [], []
    cached, recheck = reusable_images(root, job)
    with source.open("rb") as source_stream, fitz.open(source) as document:
        if not document.is_pdf or document.needs_pass or not 0 < document.page_count <= MAX_PAGES:
            raise Failure("The reading source must be an unencrypted PDF with a bounded page count")
        PROTOCOL.check_source(source, job["fingerprint"], source_stream.fileno())
        for xref in range(1, document.xref_length()):
            deadline.remaining()
            if document.xref_get_key(xref, "Subtype") != ("name", "/Image"):
                continue
            if len(images) >= MAX_IMAGES or document.xref_get_key(xref, MARKER)[0] != "null":
                raise Failure("Source image count or reserved marker is invalid")
            keys = {key: document.xref_get_key(xref, key) for key in document.xref_get_keys(xref) if key != "Length"}
            if any(keys.get(key, (None,))[0] != "int" for key in ("Width", "Height")):
                raise Failure("Image dimensions must be explicit PDF integers")
            width, height = int(keys["Width"][1]), int(keys["Height"][1])
            if not integer(width, MAX_DIMENSION) or not integer(height, MAX_DIMENSION) or width * height > MAX_PIXELS:
                raise Failure("Source image dimensions exceed the reading representation bound")
            length = document.xref_get_key(xref, "Length")
            if length[0] == "int" and not integer(int(length[1]), MAX_IMAGE_BYTES):
                raise Failure("Source image encoded bytes exceed the reading representation bound")
            encoded = document.xref_stream_raw(xref)
            if not encoded or len(encoded) > MAX_IMAGE_BYTES:
                raise Failure("Source image encoded bytes exceed the reading representation bound")
            identifier, original_sha = "x" + str(xref), sha(encoded)
            frame, reason = None, "original-filter"
            is_jpeg = keys.get("Filter") == ("name", "/DCTDecode")
            if is_jpeg:
                try:
                    frame = jpeg_structure(encoded, allow_trailing=True)
                    reason = progressive_reason(frame)
                    if (frame["width"], frame["height"]) != (width, height):
                        reason = "jpeg-dimensions"
                except Failure:
                    reason = "jpeg-structure"
            inventory.append({"bytes": len(encoded), "jpeg": is_jpeg, "eligible": reason is None,
                              "reason": reason, **({"coefficientBytes": frame["coefficientBytes"]} if frame else {})})
            image = cached.get(identifier)
            if image is not None:
                if (image["originalSha256"], image["width"], image["height"]) != (original_sha, width, height):
                    raise Failure("Partial reading image differs from the exact source")
                verified_asset(root, image, deadline, image.get("chunks"))
                if identifier in recheck:
                    original_file = staging / "input.jpg"
                    original_file.write_bytes(encoded)
                    verify_jpeg(job, original_file, root / image["path"], deadline, transcode=False)
                    checked_progressive((root / image["path"]).read_bytes(), frame)
                    original_file.unlink()
                if image["encoding"] == "original":
                    if reason is None:
                        image = None
                    else:
                        image = {**image, "fallbackReason": reason}
                        if frame:
                            image["components"] = frame["components"]
                        else:
                            image.pop("components", None)
            if image is None:
                if reason is None:
                    original_file, progressive_file = staging / "input.jpg", staging / "progressive.jpg"
                    original_file.write_bytes(encoded)
                    verify_jpeg(job, original_file, progressive_file, deadline, transcode=True)
                    encoded = progressive_file.read_bytes()
                    converted = checked_progressive(encoded, frame)
                    image = {**output.asset(encoded, "image", "jpg", MAX_IMAGE_BYTES),
                             "encoding": "progressive-jpeg", "components": converted["components"],
                             "coefficientBytes": converted["coefficientBytes"], "chunks": converted["chunks"]}
                    original_file.unlink()
                    progressive_file.unlink()
                else:
                    image = {**output.asset(encoded, "image", "bin", MAX_IMAGE_BYTES),
                             "encoding": "original", "fallbackReason": reason}
                    if frame:
                        image["components"] = frame["components"]
                image.update(id=identifier, originalSha256=original_sha, width=width, height=height)
                validate_image(image)
            images.append(image)
            document.update_stream(xref, b"", compress=False)
            for key in ("Filter", "DecodeParms"):
                if key in keys:
                    document.xref_set_key(xref, key, keys[key][1])
            document.xref_set_key(xref, MARKER, "(" + identifier + ")")
            PROTOCOL.check_source(source, job["fingerprint"], source_stream.fileno())
            output.metadata(STATE, {"version": VERSION, "source": job["identity"],
                                    "verifier": job["verifier"], "baseManifest": job.get("refresh_revision"),
                                    "images": images})
        layout = document.tobytes(garbage=0, deflate=False, no_new_id=True)
        pdf = output.asset(layout, "layout", "pdf", MAX_PDF_BYTES)
        manifest = {"version": VERSION, "source": {**job["identity"], "pageCount": document.page_count},
                    "pdf": pdf, "images": images}
        validate_manifest(manifest, byte_budget=job["quota"])
        PROTOCOL.check_source(source, job["fingerprint"], source_stream.fileno())
    return {"manifest": manifest, "coverage": coverage(images, inventory)}


def worker_main():
    try:
        data = sys.stdin.buffer.read(32 * 1024 + 1)
        if len(data) > 32 * 1024:
            raise Failure("Reading worker input exceeds its bound")
        job = json.loads(data)
        PROTOCOL.worker_limits({"memory_mib": job["memory_mib"], "file_limit": MAX_IMAGE_BYTES,
                                "timeout": job["timeout"]})
        result = prepare(job)
        atomic_json(Path(job["staging"]) / "result.json", result, PROTOCOL.Deadline(10), MAX_MANIFEST_BYTES + MIB)
        return 0
    except PROTOCOL.LimitReached:
        return 3
    except MemoryError:
        return 4
    except Exception as error:
        print(str(error)[:2000], file=sys.stderr)
        return 1


async def compile_tool(staging, supplied, deadline):
    if supplied:
        tool = Path(supplied).expanduser().resolve()
        if not tool.is_file() or not os.access(tool, os.X_OK):
            raise Failure("--jpeg-tool must name the maintained coefficient verifier executable")
        return tool
    compiler = shutil.which("cc")
    if compiler is None or not VERIFIER_SOURCE.is_file():
        raise Failure("The reading producer requires cc/libjpeg or an installed --jpeg-tool")
    tool = staging / "coefficients"
    process = None
    with (staging / "compiler.txt").open("wb") as errors:
        try:
            process = await asyncio.create_subprocess_exec(compiler, "-O2",
                                    f"-DMOTIONLAB_MAX_PIXELS={MAX_PROGRESSIVE_PIXELS}",
                                    f"-DMOTIONLAB_MAX_COEFFICIENT_BYTES={MAX_COEFFICIENT_BYTES}",
                                    str(VERIFIER_SOURCE), "-ljpeg", "-o", str(tool),
                                    stdout=errors, stderr=errors, start_new_session=True)
            await asyncio.wait_for(process.wait(), timeout=min(30, deadline.remaining()))
        except asyncio.TimeoutError as error:
            raise Failure("Coefficient verifier compilation did not finish") from error
        finally:
            if process is not None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                if process.returncode is None:
                    await process.wait()
    if process.returncode:
        raise Failure("Could not build the maintained coefficient verifier; install libjpeg development headers")
    return tool


async def invoke(job, deadline):
    process = None
    staging = Path(job["staging"])
    with (staging / "worker-error.txt").open("wb") as errors:
        try:
            job = {**job, "timeout": deadline.remaining()}
            process = await asyncio.create_subprocess_exec(sys.executable, "-B", str(Path(__file__).resolve()), "--_worker",
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=errors, start_new_session=True)
            # A native parser or verifier can stop answering. The process-group
            # deadline is the last resort; ordinary completion follows child exit.
            await asyncio.wait_for(process.communicate(json.dumps(job).encode()), timeout=deadline.remaining())
            if process.returncode == 3:
                raise PROTOCOL.LimitReached("reading-output-limit")
            if process.returncode:
                message = (staging / "worker-error.txt").read_bytes()[:2000].decode(errors="replace")
                message = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", " ", message).strip()
                raise Failure("Reading worker failed" + (": " + message if message else ""))
            return PROTOCOL.read_json(staging / "result.json", MAX_MANIFEST_BYTES + MIB)
        except asyncio.TimeoutError as error:
            raise PROTOCOL.LimitReached("reading-deadline") from error
        finally:
            if process is not None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                if process.returncode is None:
                    await process.wait()


async def run(args):
    deadline = PROTOCOL.Deadline(args.deadline_seconds)
    receipt = PROTOCOL.receipt_for(args)
    if not args.output:
        raise Failure("--output or an exact source receipt is required")
    source, root = Path(args.input).expanduser().absolute(), Path(args.output).expanduser().resolve()
    expected = PROTOCOL.fingerprint(source)
    if not integer(expected[2], MAX_SOURCE_BYTES):
        raise Failure("The source must be a nonempty PDF within 4 GiB")
    quota = int(args.max_output_mib * MIB)
    root.mkdir(parents=True, exist_ok=True)
    lock = os.open(root / LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    staging = None
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise Failure("Another reading generator owns this output") from error
        if not stat.S_ISREG(os.fstat(lock).st_mode) or os.fstat(lock).st_size:
            raise Failure("The reading lock must be an empty regular file")
        for folder, maximum in ((root, MAX_MANIFEST_BYTES), (root / "reading", MAX_IMAGE_BYTES)):
            if not folder.exists():
                continue
            if folder.is_symlink() or not folder.is_dir():
                raise Failure("The reading temporary directory is not an ordinary directory")
            for path in folder.iterdir():
                deadline.remaining()
                if PENDING.fullmatch(path.name):
                    if regular(path).st_size > maximum:
                        raise Failure("An abandoned reading temporary exceeds its bound")
                    path.unlink()
        with source.open("rb") as stream:
            digest = PROTOCOL.hash_stream(stream, deadline)
            PROTOCOL.check_source(source, expected, stream.fileno())
            identity = {"sha256": digest, "size": expected[2]}
            if receipt and (receipt["sha256"], receipt["size"]) != (digest, expected[2]):
                raise Failure("The reading source differs from its exact export receipt")
            manifest_path = root / "reading.json"
            refresh_revision = None
            if manifest_path.exists() or manifest_path.is_symlink():
                value = PROTOCOL.read_json(manifest_path, MAX_MANIFEST_BYTES)
                if {key: value.get("source", {}).get(key) for key in identity} != identity:
                    raise Failure("The output contains a reading manifest for another source")
                total = verify_manifest(root, value, deadline, quota)
                Output(root, quota, deadline)
                PROTOCOL.check_source(source, expected, stream.fileno())
                if not args.refresh:
                    PROTOCOL.emit("complete", manifest=str(manifest_path), source=value["source"], pdfBytes=value["pdf"]["bytes"],
                                  assetBytes=total, coverage=coverage(value["images"]), reused=True)
                    return 0
                refresh_revision = sha(json_bytes(value))
            # Only this generator's exact staging names are removed under its lock.
            for old in root.glob(STAGING + "*"):
                if old.is_symlink() or not old.is_dir():
                    raise Failure("Unexpected abandoned reading work path")
                shutil.rmtree(old)
            staging = Path(tempfile.mkdtemp(prefix=STAGING, dir=root))
            tool = await compile_tool(staging, args.jpeg_tool, deadline)
            verifier = sha(VERIFIER_SOURCE.read_bytes() + FORMAT_PATH.read_bytes())
            PROTOCOL.emit("start", source=identity, output=str(root), maxOutputBytes=quota)
            result = await invoke({"source": str(source), "output": str(root), "staging": str(staging),
                "fingerprint": expected, "identity": identity, "tool": str(tool), "verifier": verifier,
                "refresh_revision": refresh_revision, "quota": quota, "memory_mib": args.max_worker_mib,
                "job_timeout": args.job_timeout_seconds}, deadline)
            PROTOCOL.check_source(source, expected, stream.fileno())
            value = result["manifest"]
            if {key: value.get("source", {}).get(key) for key in identity} != identity:
                raise Failure("Reading worker returned a different source")
            total = verify_manifest(root, value, deadline, quota)
            PROTOCOL.check_source(source, expected, stream.fileno())
            Output(root, quota, deadline).metadata("reading.json", value)
            (root / STATE).unlink(missing_ok=True)
            PROTOCOL.sync_directory(root)
            PROTOCOL.emit("complete", manifest=str(manifest_path), source=value["source"], pdfBytes=value["pdf"]["bytes"],
                          assetBytes=total, coverage=result["coverage"], reused=False)
            return 0
    finally:
        if staging is not None:
            shutil.rmtree(staging, ignore_errors=True)
        os.close(lock)


async def run_with_signals(args):
    loop, current = asyncio.get_running_loop(), asyncio.current_task()
    previous = signal.getsignal(signal.SIGTERM)
    loop.add_signal_handler(signal.SIGTERM, current.cancel)
    try:
        return await run(args)
    finally:
        loop.remove_signal_handler(signal.SIGTERM)
        signal.signal(signal.SIGTERM, previous)


def parser():
    result = PROTOCOL.CommandParser(description=__doc__)
    result.add_argument("input", help="Exact local source PDF; remains unchanged")
    result.add_argument("--output", help="Directory shared with an optional raster manifest")
    result.add_argument("--source-receipt", help="Existing exact-build PDF export receipt")
    result.add_argument("--document-key", help="Checked against the existing export receipt when supplied")
    result.add_argument("--refresh", action="store_true",
                        help="Reconsider completed original-image fallbacks while preserving the current manifest until completion")
    result.add_argument("--jpeg-tool", help="Prebuilt maintained coefficients.c verifier; otherwise compile it once")
    result.add_argument("--max-output-mib", type=PROTOCOL.finite_positive, default=2048,
                        help="Reading assets and metadata only, separate from raster preview bytes")
    result.add_argument("--deadline-seconds", type=PROTOCOL.finite_positive, default=3600)
    result.add_argument("--job-timeout-seconds", type=PROTOCOL.finite_positive, default=60)
    result.add_argument("--max-worker-mib", type=int, default=4096)
    return result


def main():
    args = parser().parse_args()
    if (not 128 <= args.max_worker_mib <= 16384 or args.max_output_mib > 65536
            or args.deadline_seconds > 86400 or args.job_timeout_seconds > 3600):
        parser().error("Reading process resource limits exceed their supported bounds")
    try:
        return asyncio.run(run_with_signals(args))
    except asyncio.CancelledError:
        print(json.dumps({"event": "error", "message": "Reading generation terminated"}), file=sys.stderr)
        return 143
    except KeyboardInterrupt:
        return 130
    except PROTOCOL.LimitReached as error:
        PROTOCOL.emit("partial", reason=str(error))
        return 3
    except (Failure, PROTOCOL.Failure, OSError, ValueError) as error:
        print(json.dumps({"event": "error", "message": str(error)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(worker_main() if sys.argv[1:] == ["--_worker"] else main())
