"""Write a one-page PDF for the color theme probe, as both builds of a harness book.

Usage: python3 -I theme_book.py OUTDIR

The page has, at fixed places (PDF points, origin at the bottom left):
- black text "IIII" in Helvetica 96 pt at (72, 640)
- a black line 8 pt wide from (72, 600) to (540, 600)
- a black filled rectangle (72, 540) to (272, 570)
- red text "IIII" in Helvetica 96 pt at (72, 420)
- an image of two solid colors at (320, 380), 200 x 200 pt: blue in its top half, green below
- a form XObject drawn at (72, 180) with black text "IIII" at 96 pt and a black line 8 pt wide
"""
import json
import os
import sys
import zlib

outdir = sys.argv[1]
os.makedirs(outdir, exist_ok=True)

side = 64
rows = []
for y in range(side):
    color = b"\x00\x00\xff" if y < side // 2 else b"\x00\xff\x00"
    rows.append(color * side)
image = zlib.compress(b"".join(rows))

form_ops = b"BT /F1 96 Tf 0 30 Td (IIII) Tj ET 0 G 8 w 0 0 m 468 0 l S"
page_ops = (
    b"BT /F1 96 Tf 72 640 Td (IIII) Tj ET\n"
    b"0 G 8 w 72 600 m 540 600 l S\n"
    b"0 g 72 540 200 30 re f\n"
    b"1 0 0 rg BT /F1 96 Tf 72 420 Td (IIII) Tj ET 0 g\n"
    b"q 200 0 0 200 320 380 cm /Im1 Do Q\n"
    b"q 1 0 0 1 72 180 cm /Fm1 Do Q\n"
)

objs = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
    b"/Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R /Fm1 7 0 R >> >> >>",
    b"<< /Length %d >>\nstream\n" % len(page_ops) + page_ops + b"\nendstream",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceRGB "
    b"/BitsPerComponent 8 /Filter /FlateDecode /Length %d >>\nstream\n" % (side, side, len(image)) + image + b"\nendstream",
    b"<< /Type /XObject /Subtype /Form /BBox [0 -10 480 150] /Resources << /Font << /F1 5 0 R >> >> "
    b"/Length %d >>\nstream\n" % len(form_ops) + form_ops + b"\nendstream",
]

buf = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
offsets = []
for i, body in enumerate(objs, start=1):
    offsets.append(len(buf))
    buf += b"%d 0 obj\n" % i + body + b"\nendobj\n"
xref = len(buf)
buf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
for off in offsets:
    buf += b"%010d 00000 n \n" % off
buf += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)

with open(os.path.join(outdir, "build-a.pdf"), "wb") as f:
    f.write(buf)
entry = {"file": "build-a.pdf", "size": len(buf), "startXRefTable": xref, "ranges": []}
with open(os.path.join(outdir, "builds.json"), "w") as f:
    json.dump({"a": entry, "b": dict(entry)}, f)
print(f"wrote {len(buf)} bytes")
