"""Write a large test book as two builds, with the `ranges` Overleaf's compile server lists.

Usage: python3 -I make_book.py OUTDIR [PAGES] [IMAGE_KB]

Writes OUTDIR/build-a.pdf and OUTDIR/build-b.pdf and OUTDIR/builds.json. Every page carries
text lines and one image of IMAGE_KB kilobytes of random data (so Flate cannot shrink it);
pages 5 and 6 are landscape. Build B changes the text of page 2 only, so its images are the
same bytes at other offsets, as after an edit to a book's text. builds.json lists for each
build its size, startXRefTable, and `ranges`: the image objects as Overleaf's compile server
describes them (objectId, start just after the object id, end, SHA-256 of bytes[start:end]).
Last it writes OUTDIR/book.json, what the scripts check against: the number of pages, "text",
which every page's text lines hold, and "chapters", the outline's entries with their pages.
"""
import hashlib
import json
import os
import random
import sys
import zlib

outdir = sys.argv[1]
pages = int(sys.argv[2]) if len(sys.argv) > 2 else 120
image_kb = int(sys.argv[3]) if len(sys.argv) > 3 else 1024
os.makedirs(outdir, exist_ok=True)

side = int((image_kb * 1024 / 3) ** 0.5)
# text that every page's text lines hold
TEXT = b"quick brown"
# the outline: one chapter every CHAPTER_PAGES pages, from page 1
CHAPTER_PAGES = 10
chapters = [{"title": "Chapter %d" % (n + 1), "page": start + 1} for n, start in enumerate(range(0, pages, CHAPTER_PAGES))]
rng_seed = b"overleaf-workshop-book"
images = []
for i in range(pages):
    # deterministic pseudo-random bytes per image, so both builds embed identical images
    raw = random.Random(rng_seed + str(i).encode()).randbytes(side * side * 3)
    images.append((side, zlib.compress(raw, 1)))


def build(variant: str):
    objs = []

    def add(body: bytes) -> int:
        objs.append(body)
        return len(objs)

    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    contents = []
    for i in range(pages):
        landscape = i in (4, 5)
        h = 612 if landscape else 792
        lines = [b"Page %d of the test book" % (i + 1)]
        if i == 1:
            lines.append(b"This line differs between builds: build " + (b"A" if variant == "a" else b"B, with a longer sentence than build A has"))
        for k in range(12):
            lines.append(b"Line %d of page %d: the %s fox jumps over the lazy dog." % (k + 1, i + 1, TEXT))
        ops = b"BT /F1 12 Tf 72 %d Td 14 TL\n" % (h - 72)
        for line in lines:
            ops += b"(" + line + b") Tj T*\n"
        ops += b"ET\nq 300 0 0 300 72 %d cm /Im%d Do Q\n" % (h - 72 - 14 * len(lines) - 320, i)
        contents.append(add(b"<< /Length %d >>\nstream\n" % len(ops) + ops + b"\nendstream"))
    image_ids = []
    for side_px, data in images:
        image_ids.append(add(
            b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB "
            b"/BitsPerComponent 8 /Filter /FlateDecode /Length %d >>\nstream\n" % (side_px, side_px, len(data))
            + data + b"\nendstream"))
    page_ids = []
    pages_id = len(objs) + pages + 1
    for i in range(pages):
        landscape = i in (4, 5)
        w, h = (792, 612) if landscape else (612, 792)
        content = contents[i]
        page_ids.append(add(
            b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %d %d] /Resources << /Font << /F1 %d 0 R >> "
            b"/XObject << /Im%d %d 0 R >> >> /Contents %d 0 R >>" % (pages_id, w, h, font, i, image_ids[i], content)))
    assert len(objs) + 1 == pages_id
    add(b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % p for p in page_ids), pages))
    outlines_id = len(objs) + 1
    first_item = outlines_id + 1
    add(b"<< /Type /Outlines /First %d 0 R /Last %d 0 R /Count %d >>" % (first_item, first_item + len(chapters) - 1, len(chapters)))
    for n, chapter in enumerate(chapters):
        item = first_item + n
        links = b""
        if n > 0:
            links += b" /Prev %d 0 R" % (item - 1)
        if n < len(chapters) - 1:
            links += b" /Next %d 0 R" % (item + 1)
        add(b"<< /Title (%s) /Parent %d 0 R /Dest [%d 0 R /XYZ 0 792 null]%s >>" % (chapter["title"].encode(), outlines_id, page_ids[chapter["page"] - 1], links))
    catalog = add(b"<< /Type /Catalog /Pages %d 0 R /Outlines %d 0 R /PageMode /UseOutlines >>" % (pages_id, outlines_id))

    buf = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(buf))
        buf += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(buf)
    buf += b"xref\n0 %d\n" % (len(objs) + 1)
    buf += b"0000000000 65535 f \n"
    for off in offsets:
        buf += b"%010d 00000 n \n" % off
    doc_id = hashlib.md5(variant.encode() + rng_seed).hexdigest().encode()  # differs per build, as pdfTeX's /ID does
    buf += b"trailer\n<< /Size %d /Root %d 0 R /ID [<%s> <%s>] >>\n" % (len(objs) + 1, catalog, doc_id, doc_id)
    buf += b"startxref\n%d\n%%%%EOF\n" % xref

    ranges = []
    for oid in image_ids:
        start_obj = offsets[oid - 1]
        object_id = b"%d 0 obj" % oid
        start = start_obj + len(object_id)
        end = offsets[oid] if oid < len(offsets) else xref
        ranges.append({
            "objectId": object_id.decode(),
            "start": start,
            "end": end,
            "hash": hashlib.sha256(bytes(buf[start:end])).hexdigest(),
        })
    path = os.path.join(outdir, f"build-{variant}.pdf")
    with open(path, "wb") as f:
        f.write(buf)
    return {"file": os.path.basename(path), "size": len(buf), "startXRefTable": xref, "ranges": ranges}


builds = {"a": build("a"), "b": build("b")}
with open(os.path.join(outdir, "builds.json"), "w") as f:
    json.dump(builds, f)
# last: the harness takes a book folder with book.json as complete (common.mjs)
with open(os.path.join(outdir, "book.json"), "w") as f:
    json.dump({"pages": pages, "text": TEXT.decode(), "chapters": chapters}, f)
for name, b in builds.items():
    print(f"build {name}: {b['size']} bytes, {len(b['ranges'])} ranges, startXRefTable {b['startXRefTable']}")
same = sum(1 for x, y in zip(builds["a"]["ranges"], builds["b"]["ranges"]) if x["hash"] == y["hash"])
print(f"ranges with the same hash in both builds: {same}")
