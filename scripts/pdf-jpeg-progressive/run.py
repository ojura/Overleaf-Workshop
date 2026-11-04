#!/usr/bin/env python3
"""Run the opt-in progressive JPEG proof in a new directory outside the checkout."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True
from prepare import PINNED_RELEASE, prepare

MAX_INPUT_BYTES = 16 * 1024 * 1024


def scan_boundaries(data):
    """Find complete entropy scans, retaining stuffed bytes and restart markers."""
    if data[:2] != b"\xff\xd8":
        raise ValueError("Input is not a JPEG")
    position, scans = 2, []
    while position < len(data):
        if data[position] != 255:
            raise ValueError("Expected a JPEG marker")
        while position < len(data) and data[position] == 255:
            position += 1
        if position >= len(data):
            raise ValueError("Truncated marker")
        marker = data[position]
        position += 1
        if marker == 217:
            return scans
        if marker in (216, *range(208, 216)):
            continue
        if position + 2 > len(data):
            raise ValueError("Truncated marker length")
        length = int.from_bytes(data[position:position + 2], "big")
        end = position + length
        if length < 2 or end > len(data):
            raise ValueError("Invalid marker length")
        if marker != 218:
            position = end
            continue
        count = data[position + 2]
        fields = position + 3 + 2 * count
        if fields + 3 > end:
            raise ValueError("Invalid scan header")
        cursor = end
        while True:
            cursor = data.find(255, cursor)
            if cursor < 0:
                raise ValueError("Truncated entropy scan")
            after = cursor + 1
            while after < len(data) and data[after] == 255:
                after += 1
            if after >= len(data):
                raise ValueError("Truncated entropy marker")
            if data[after] == 0 or 208 <= data[after] <= 215:
                cursor = after + 1
                continue
            break
        scans.append({
            "scan": len(scans) + 1,
            "components": [data[position + 3 + 2 * i] for i in range(count)],
            "spectralStart": data[fields], "spectralEnd": data[fields + 1],
            "successiveHigh": data[fields + 2] >> 4, "successiveLow": data[fields + 2] & 15,
            "entropyStart": end, "boundary": cursor, "receivedToRecognize": after + 1,
        })
        position = cursor
    raise ValueError("Missing JPEG end marker")


def limited():
    os.nice(10)
    resource.setrlimit(resource.RLIMIT_CPU, (60, 60))


def run_command(command, output, label, timeout=75):
    result = subprocess.run(command, text=True, capture_output=True, timeout=timeout, preexec_fn=limited)
    (output / (label + ".stdout")).write_text(result.stdout)
    (output / (label + ".stderr")).write_text(result.stderr)
    if result.returncode:
        raise RuntimeError(label + " failed:\n" + result.stderr[-4000:])
    return result.stdout


def main():
    here = Path(__file__).resolve().parent
    repo = here.parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path, help="An existing JPEG file")
    parser.add_argument("--output", required=True, type=Path, help="A new output directory outside the checkout")
    parser.add_argument("--worker", type=Path, default=repo / "views/pdf-viewer/vendor" / ("pdfjs-" + PINNED_RELEASE) / "build/pdf.worker.mjs")
    parser.add_argument("--max-dimension", type=int, default=1024)
    parser.add_argument("--publish", default="all", help="all, or comma-separated scan numbers such as 1,5,10")
    parser.add_argument("--save-images", action="store_true", help="Write selected RGB previews as portable pixmap files")
    parser.add_argument("--check-negative-control", action="store_true", help="Verify that destructive IDCT is caught")
    args = parser.parse_args()
    source, output = args.input.resolve(strict=True), args.output.resolve()
    if not source.is_file() or not 0 < source.stat().st_size <= MAX_INPUT_BYTES:
        parser.error("Input must be a JPEG file of at most16MiB")
    if output.is_relative_to(repo) or output.exists():
        parser.error("Output must be a new directory outside the checkout")
    if not 128 <= args.max_dimension <= 2048:
        parser.error("max-dimension must be128 through2048")
    for tool in ("cc", "node"):
        if not shutil.which(tool):
            parser.error(tool + " is required")
    worker = args.worker.resolve(strict=True)
    output.mkdir(parents=True)
    run_command(["cc", "-O2", "-Wall", "-Wextra", "-Werror", str(here / "coefficients.c"),
                 "-ljpeg", "-o", str(output / "coefficients")], output, "compile", 20)
    encoded = run_command([str(output / "coefficients"), str(source),
                           str(output / "progressive.jpg"), str(output / "coefficients.bin")],
                          output, "transcode", 30)
    transcode = json.loads(encoded)
    data = (output / "progressive.jpg").read_bytes()
    if len(data) > MAX_INPUT_BYTES:
        raise ValueError("Progressive output exceeds16MiB")
    scans = scan_boundaries(data)
    selected = list(range(1, len(scans) + 1)) if args.publish == "all" else sorted(set(map(int, args.publish.split(","))))
    if not selected or selected[0] < 1 or selected[-1] > len(scans):
        raise ValueError("Publication scan is outside this JPEG")
    # Full output is always verified, even when the selected preview schedule omits the last scan.
    config = {
        "input": str(source), "originalBytes": source.stat().st_size,
        "inputSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "progressiveBytes": len(data), "progressiveSha256": hashlib.sha256(data).hexdigest(),
        "width": transcode["width"], "height": transcode["height"],
        "maxDimension": args.max_dimension, "publish": selected, "saveImages": args.save_images,
        "transcode": transcode, "scans": scans,
    }
    (output / "config.json").write_text(json.dumps(config, indent=2) + "\n")
    prepare(worker, output)
    node = ["node", "--max-old-space-size=512", "--expose-gc", str(here / "probe.mjs"), "--output", str(output)]
    report = json.loads(run_command(node, output, "probe"))
    if args.check_negative_control:
        module = output / "pinned-incremental.mjs"
        text = module.read_text()
        original = "blockData:component.blockData.slice()"
        if text.count(original) != 1:
            raise ValueError("Destructive-IDCT control no longer matches the helper")
        negative = output / "negative-incremental.mjs"
        try:
            negative.write_text(text.replace(original, "blockData:component.blockData"))
            failed = subprocess.run(node + ["--check-only", "--decoder", negative.name],
                                    text=True, capture_output=True, timeout=20, preexec_fn=limited)
            if failed.returncode == 0 or "IDCT mutated retained coefficients" not in failed.stderr:
                raise RuntimeError("The destructive-IDCT control did not fail at its invariant")
            run_command(node + ["--check-only"], output, "check-restored", 20)
            report["negativeControlDetected"] = True
        finally:
            negative.unlink(missing_ok=True)
    (output / "summary.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"output": str(output), "report": report}, indent=2))


if __name__ == "__main__":
    main()
