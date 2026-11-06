#!/usr/bin/env python3
"""Publish one verified preview or reading manifest into its public SHA namespace."""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import secrets
import signal
import stat
import sys


# Keep the protocol limits shared with the producer. Importing it uses only the
# standard library; PDF and image dependencies are loaded inside its worker calls.
_spec = importlib.util.spec_from_file_location(
    "motionlab_preview_protocol", Path(__file__).resolve().with_name("motionlab-previews.py"))
_protocol = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_protocol)
_reading_spec = importlib.util.spec_from_file_location(
    "motionlab_reading_protocol", Path(__file__).resolve().with_name("motionlab-reading.py"))
READING = importlib.util.module_from_spec(_reading_spec)
_reading_spec.loader.exec_module(READING)

DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
READ_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
MAX_ASSET_DIMENSION = 4096
MAX_ASSETS_PER_PAGE = 6
REGION_ID = re.compile(r"^[a-zA-Z0-9._:-]{1,128}$")


class Failure(Exception):
    pass


class Terminated(Exception):
    pass


class Cancellation:
    def __init__(self):
        self.signal = None

    def request(self, signum, frame):
        # Record the request without interrupting descriptor acquisition or cleanup.
        if self.signal is None:
            self.signal = signum

    def check(self):
        if self.signal == signal.SIGTERM:
            raise Terminated()
        if self.signal == signal.SIGINT:
            raise KeyboardInterrupt()


class Deadline(_protocol.Deadline):
    def __init__(self, seconds, cancellation):
        super().__init__(seconds)
        self.cancellation = cancellation

    def remaining(self):
        self.cancellation.check()
        return super().remaining()


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise Failure(message)


def emit(event, **values):
    print(json.dumps({"event": event, **values}, separators=(",", ":")), flush=True)


def number(value, maximum, integer=False):
    return (type(value) is int if integer else type(value) in (int, float)) and 0 < value <= maximum and math.isfinite(value)


def finite_number(value):
    return type(value) is int or type(value) is float and math.isfinite(value)


def canonical_asset(value):
    return (isinstance(value, str) and _protocol.SAFE_ASSET.fullmatch(value) is not None
            and not _protocol.reading_path(value)
            and all(part not in ("", ".", "..") for part in value.split("/"))
            and value.split("/")[0] != "manifest.json")


def validate_manifest(value, expected_sha, byte_budget):
    if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1:
        raise Failure("Invalid preview manifest version")
    document = value.get("document")
    if (not isinstance(document, dict) or document.get("sha256") != expected_sha
            or document.get("key") != "sha256:" + expected_sha
            or not number(document.get("size"), _protocol.MAX_SOURCE_BYTES, True)
            or not number(document.get("pageCount"), _protocol.MAX_PAGES, True)):
        raise Failure("The manifest does not match the expected source SHA namespace")
    pages = value.get("pages")
    if not isinstance(pages, list) or not pages or len(pages) > document["pageCount"]:
        raise Failure("The manifest must contain bounded, nonempty page coverage")
    assets, seen_pages, paths = [], set(), set()
    region_count, total_bytes = 0, 0
    for page in pages:
        if (not isinstance(page, dict)
                or not number(page.get("pageNumber"), document["pageCount"], True)
                or page["pageNumber"] in seen_pages
                or not all(number(page.get(key), 1_000_000) for key in ("width", "height"))
                or type(page.get("rotation")) not in (int, float) or page["rotation"] not in (0, 90, 180, 270)):
            raise Failure("Invalid preview page")
        seen_pages.add(page["pageNumber"])
        levels = page.get("assets")
        if not isinstance(levels, list) or not 1 <= len(levels) <= MAX_ASSETS_PER_PAGE:
            raise Failure("Invalid preview asset count")
        for asset in levels:
            if (not isinstance(asset, dict) or not canonical_asset(asset.get("path"))
                    or asset["path"] in paths
                    or not all(number(asset.get(key), MAX_ASSET_DIMENSION, True) for key in ("width", "height"))
                    or not number(asset.get("bytes"), _protocol.MAX_ASSET_BYTES, True)
                    or not isinstance(asset.get("sha256"), str) or not _protocol.HASH.fullmatch(asset["sha256"])
                    or asset.get("mime") not in ("image/jpeg", "image/png", "image/webp")
                    or abs(asset["width"] * page["height"] - asset["height"] * page["width"])
                    > 2 * max(page["width"], page["height"])):
                raise Failure("Invalid preview asset metadata or path")
            assets.append(asset)
            paths.add(asset["path"])
            total_bytes += asset["bytes"]
            if len(assets) > _protocol.MAX_ASSETS or total_bytes > byte_budget:
                raise Failure("The manifest exceeds the incoming asset budget")
        regions = page.get("imageRegions", [])
        if not isinstance(regions, list) or len(regions) > _protocol.MAX_REGIONS_PER_PAGE:
            raise Failure("Invalid preview image-region count")
        region_count += len(regions)
        if region_count > _protocol.MAX_REGIONS:
            raise Failure("The manifest exceeds its total image-region bound")
        ids = set()
        for region in regions:
            if (not isinstance(region, dict) or not isinstance(region.get("id"), str)
                    or not REGION_ID.fullmatch(region["id"]) or region["id"] in ids
                    or not all(finite_number(region.get(key)) for key in ("x", "y", "width", "height"))
                    or not 0 <= region["x"] < 1 or not 0 <= region["y"] < 1
                    or not 0 < region["width"] <= 1 - region["x"] + 0.000001
                    or not 0 < region["height"] <= 1 - region["y"] + 0.000001):
                raise Failure("Invalid preview image region")
            ids.add(region["id"])
    # A file cannot also be a directory for another asset in this namespace.
    for name in paths:
        parts = name.split("/")
        if any("/".join(parts[:length]) in paths for length in range(1, len(parts))):
            raise Failure("Preview asset paths conflict as files and directories")
    return assets, total_bytes


def validate_reading(value, expected_sha, byte_budget):
    try:
        return READING.validate_manifest(value, expected_sha, byte_budget)
    except READING.Failure as error:
        raise Failure(str(error)) from error


def absolute_directory(value, require_absolute=False):
    path = Path(value).expanduser()
    if require_absolute and not path.is_absolute():
        raise Failure("--web-root must be an explicit absolute directory")
    return Path(os.path.abspath(path))


def open_child_directory(parent, name, create=False):
    created = False
    try:
        descriptor = os.open(name, DIR_FLAGS, dir_fd=parent)
    except FileNotFoundError:
        if not create:
            raise
        try:
            os.mkdir(name, 0o755, dir_fd=parent)
            created = True
        except FileExistsError:
            pass
        descriptor = os.open(name, DIR_FLAGS, dir_fd=parent)
    if created:
        try:
            os.fchmod(descriptor, 0o755)
            os.fsync(descriptor)
            os.fsync(parent)
        except BaseException:
            os.close(descriptor)
            raise
    return descriptor


@contextlib.contextmanager
def directory(path: Path, create=False):
    descriptor = os.open(os.path.sep, DIR_FLAGS)
    try:
        for component in path.parts[1:]:
            child = open_child_directory(descriptor, component, create)
            os.close(descriptor)
            descriptor = child
        yield descriptor
    finally:
        os.close(descriptor)


@contextlib.contextmanager
def asset_parent(root, relative, create=False):
    components = relative.split("/")
    descriptor = os.dup(root)
    try:
        for component in components[:-1]:
            child = open_child_directory(descriptor, component, create)
            os.close(descriptor)
            descriptor = child
        yield descriptor, components[-1]
    finally:
        os.close(descriptor)


@contextlib.contextmanager
def regular_file(parent, name):
    descriptor = os.open(name, READ_FLAGS, dir_fd=parent)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise Failure(f"Expected a regular file: {name}")
        yield descriptor, info
    finally:
        os.close(descriptor)


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def directory_identity(descriptor):
    info = os.fstat(descriptor)
    return info.st_dev, info.st_ino


def snapshot_identity(info):
    # Atomic manifest replacement unlinks the held old inode and changes ctime.
    # Its descriptor still supplies the complete original snapshot.
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def no_json_constant(value):
    raise Failure(f"Invalid JSON constant: {value}")


def bounded_integer(value):
    if len(value.lstrip("-")) > 16:
        raise Failure("A manifest integer exceeds its numeric bound")
    return int(value)


def snapshot_manifest(source, deadline, name="manifest.json"):
    with regular_file(source, name) as (descriptor, before):
        if not 0 < before.st_size <= _protocol.MAX_MANIFEST_BYTES:
            raise Failure("The manifest is empty or exceeds its byte limit")
        pieces, remaining = [], before.st_size
        while remaining:
            deadline.remaining()
            block = os.read(descriptor, min(_protocol.MIB, remaining))
            if not block:
                raise Failure("The manifest changed while its snapshot was read")
            pieces.append(block)
            remaining -= len(block)
        if os.read(descriptor, 1) or snapshot_identity(os.fstat(descriptor)) != snapshot_identity(before):
            raise Failure("The manifest changed while its snapshot was read")
    payload = b"".join(pieces)
    try:
        value = json.loads(payload, parse_constant=no_json_constant, parse_int=bounded_integer)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise Failure("The manifest snapshot is not valid JSON") from error
    return payload, value


def write_all(descriptor, block, deadline):
    view = memoryview(block)
    while view:
        deadline.remaining()
        written = os.write(descriptor, view)
        if written <= 0:
            raise Failure("The destination stopped accepting file data")
        view = view[written:]


def checked_asset(descriptor, before, asset, deadline, output=None):
    if before.st_size != asset["bytes"]:
        raise Failure(f"Asset byte count differs: {asset['path']}")
    digest = hashlib.sha256()
    remaining = asset["bytes"]
    chunks = asset.get("chunks")
    chunk_index, chunk_bytes = 0, 0
    chunk_digest = hashlib.sha256()
    while remaining:
        deadline.remaining()
        block = os.read(descriptor, min(_protocol.MIB, remaining))
        if not block:
            raise Failure(f"Asset ended before its advertised size: {asset['path']}")
        digest.update(block)
        if chunks:
            cursor = 0
            while cursor < len(block):
                if chunk_index >= len(chunks):
                    raise Failure("Reading asset exceeds its verified chunk partition")
                take = min(len(block) - cursor, chunks[chunk_index]["bytes"] - chunk_bytes)
                chunk_digest.update(block[cursor:cursor + take])
                cursor += take
                chunk_bytes += take
                if chunk_bytes == chunks[chunk_index]["bytes"]:
                    if chunk_digest.hexdigest() != chunks[chunk_index]["sha256"]:
                        raise Failure("Reading asset scan checksum differs")
                    chunk_index += 1
                    chunk_bytes = 0
                    chunk_digest = hashlib.sha256()
        if output is not None:
            write_all(output, block, deadline)
        remaining -= len(block)
    if os.read(descriptor, 1) or file_identity(os.fstat(descriptor)) != file_identity(before):
        raise Failure(f"Asset changed while it was read: {asset['path']}")
    if digest.hexdigest() != asset["sha256"]:
        raise Failure(f"Asset checksum differs: {asset['path']}")
    if chunks and chunk_index != len(chunks):
        raise Failure("Reading asset ended before its verified chunk partition")


@contextlib.contextmanager
def temporary_file(parent):
    name = ".publish-" + secrets.token_hex(16) + ".tmp"
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                         0o600, dir_fd=parent)
    try:
        yield descriptor, name
    finally:
        os.close(descriptor)
        with contextlib.suppress(FileNotFoundError):
            os.unlink(name, dir_fd=parent)


def public_mode(descriptor):
    if stat.S_IMODE(os.fstat(descriptor).st_mode) != 0o644:
        os.fchmod(descriptor, 0o644)


def existing_asset(parent, name, asset, deadline):
    try:
        with regular_file(parent, name) as (descriptor, info):
            checked_asset(descriptor, info, asset, deadline)
            return True
    except FileNotFoundError:
        return False


def copy_asset(source_root, namespace, asset, deadline):
    with asset_parent(source_root, asset["path"]) as (source_parent, source_name):
        with regular_file(source_parent, source_name) as (source, before):
            with asset_parent(namespace, asset["path"], create=True) as (target_parent, target_name):
                # Reuse never rewrites an immutable path. Both the captured source reference
                # and an existing public copy must match the manifest before it is advertised.
                if existing_asset(target_parent, target_name, asset, deadline):
                    checked_asset(source, before, asset, deadline)
                    return False
                with temporary_file(target_parent) as (output, temporary):
                    checked_asset(source, before, asset, deadline, output)
                    public_mode(output)
                    os.fsync(output)
                    deadline.remaining()
                    try:
                        os.link(temporary, target_name, src_dir_fd=target_parent,
                                dst_dir_fd=target_parent, follow_symlinks=False)
                    except FileExistsError:
                        if not existing_asset(target_parent, target_name, asset, deadline):
                            raise Failure("The immutable asset disappeared during publication")
                        return False
                os.fsync(target_parent)
                return True


def replace_manifest(namespace, payload, deadline, destination="manifest.json"):
    try:
        info = os.stat(destination, dir_fd=namespace, follow_symlinks=False)
        if not stat.S_ISREG(info.st_mode):
            raise Failure("The destination manifest is not a regular file")
    except FileNotFoundError:
        pass
    with temporary_file(namespace) as (descriptor, name):
        write_all(descriptor, payload, deadline)
        public_mode(descriptor)
        os.fsync(descriptor)
        deadline.remaining()
        os.replace(name, destination, src_dir_fd=namespace, dst_dir_fd=namespace)
    os.fsync(namespace)


def publish(args, cancellation=None):
    cancellation = cancellation or Cancellation()
    cancellation.check()
    expected = args.sha256.lower()
    if not _protocol.HASH.fullmatch(expected):
        raise Failure("--sha256 must be a complete 64-character SHA-256")
    asset_budget = args.max_assets_mib if args.max_assets_mib is not None else (2048 if args.reading else 512)
    if asset_budget > 1024 * 1024 or args.deadline_seconds > 86400:
        raise Failure("The asset budget is at most 1048576 MiB and deadline at most 86400 seconds")
    source_path = absolute_directory(args.generated_directory)
    web_path = absolute_directory(args.web_root, require_absolute=True)
    namespace_path = web_path / expected
    if (source_path in (web_path, namespace_path) or source_path in web_path.parents
            or namespace_path in source_path.parents):
        raise Failure("The generated directory and publication destination must be separate")
    deadline = Deadline(args.deadline_seconds, cancellation)
    manifest_name = "reading.json" if args.reading else "manifest.json"
    validate = validate_reading if args.reading else validate_manifest
    with directory(source_path) as source:
        payload, value = snapshot_manifest(source, deadline, manifest_name)
        assets, total_bytes = validate(value, expected, int(asset_budget * _protocol.MIB))
        deadline.remaining()
        with directory(web_path, create=True) as web:
            if directory_identity(source) == directory_identity(web):
                raise Failure("The web root is an alias of the generated directory")
            namespace = open_child_directory(web, expected, create=True)
            try:
                if directory_identity(source) == directory_identity(namespace):
                    raise Failure("The SHA namespace is an alias of the generated directory")
                created_lock = False
                lock_flags = os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
                try:
                    lock = os.open(".publish.lock", lock_flags | os.O_CREAT | os.O_EXCL, 0o644, dir_fd=namespace)
                    created_lock = True
                except FileExistsError:
                    lock = os.open(".publish.lock", lock_flags, dir_fd=namespace)
                try:
                    lock_info = os.fstat(lock)
                    if not stat.S_ISREG(lock_info.st_mode) or lock_info.st_size != 0:
                        raise Failure("The namespace publication lock is not an empty regular file")
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError as error:
                        raise Failure("Another publisher owns this SHA namespace") from error
                    if created_lock:
                        public_mode(lock)
                        os.fsync(lock)
                    copied, reused = 0, 0
                    for asset in assets:
                        deadline.remaining()
                        changed = copy_asset(source, namespace, asset, deadline)
                        copied += int(changed)
                        reused += int(not changed)
                        emit("asset", path=asset["path"], bytes=asset["bytes"], copied=changed)
                    deadline.remaining()
                    replace_manifest(namespace, payload, deadline, manifest_name)
                    emit("complete", namespace=str(namespace_path), manifest=str(namespace_path / manifest_name),
                         sha256=expected, assets=len(assets), copiedAssets=copied, reusedAssets=reused,
                         assetBytes=total_bytes, manifestBytes=len(payload))
                finally:
                    os.close(lock)
            finally:
                os.close(namespace)
    return 0


def parser():
    result = Parser(description=__doc__)
    result.add_argument("generated_directory", help="Directory containing the generated manifest and assets")
    result.add_argument("--reading", action="store_true", help="Publish reading.json and its verified structural PDF and encoded images")
    result.add_argument("--web-root", required=True, help="Explicit absolute destination, for example /var/www/html/spomenar-previews")
    result.add_argument("--sha256", required=True, help="Expected source PDF SHA; the lowercase digest names the public namespace")
    result.add_argument("--max-assets-mib", type=_protocol.finite_positive,
                        help="Maximum referenced asset bytes in MiB (preview default 512; reading default 2048)")
    result.add_argument("--deadline-seconds", type=_protocol.finite_positive, default=120,
                        help="Whole publication deadline; the previous manifest remains until the final replace")
    return result


def main(argv=None):
    previous = {}
    try:
        args = parser().parse_args(argv)
        cancellation = Cancellation()
        for kind in (signal.SIGTERM, signal.SIGINT):
            previous[kind] = signal.signal(kind, cancellation.request)
        return publish(args, cancellation)
    except Terminated:
        print(json.dumps({"event": "error", "message": "Publication terminated"}), file=sys.stderr)
        return 143
    except KeyboardInterrupt:
        print(json.dumps({"event": "error", "message": "Publication interrupted"}), file=sys.stderr)
        return 130
    except (_protocol.LimitReached, Failure, OSError, ValueError) as error:
        print(json.dumps({"event": "error", "message": str(error)}, separators=(",", ":")), file=sys.stderr)
        return 2
    finally:
        for kind, handler in previous.items():
            signal.signal(kind, handler)


if __name__ == "__main__":
    raise SystemExit(main())
