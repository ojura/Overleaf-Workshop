"""Write a one-page PDF for the color theme probes, as both builds of a harness book.

Usage: python3 -I theme_book.py OUTDIR

The page has, at fixed places (PDF points, origin at the bottom left):
- black text "IIII" in Helvetica 96 pt at (72, 640)
- a black line 8 pt wide from (72, 600) to (540, 600)
- a black filled rectangle (72, 540) to (272, 570)
- red text "IIII" in Helvetica 96 pt at (72, 420)
- an image of two solid colors at (320, 380), 200 x 200 pt: blue in its top half, green below
- a form XObject drawn at (72, 180) with black text "IIII" at 96 pt and a black line 8 pt wide

It writes OUTDIR/build-a.pdf, OUTDIR/builds.json, which lists the PDF as builds a and b for
server.mjs, and last OUTDIR/book.json: the number of pages, the text on the page, and "elements",
the box [x0, y0, x1, y1] in PDF points of each thing on the page, and of an area where the page
draws nothing ("background"), for the probes that sample the page's colors.
"""
import json
import os
import sys
import zlib

outdir = sys.argv[1]
os.makedirs(outdir, exist_ok=True)

TEXT = b"IIII"
SIZE = 96
# Helvetica's advance width of the letter I and its cap height, per point of size (from its AFM metrics)
I_ADVANCE, CAP_HEIGHT = 0.278, 0.718
LINE_WIDTH = 8
BLACK_TEXT = (72, 640)
LINE = (72, 600, 540)  # from (72, 600) to (540, 600)
RECT = (72, 540, 200, 30)  # x, y, width, height
RED_TEXT = (72, 420)
IMAGE = (320, 380, 200)  # x, y, side
FORM = (72, 180)  # where the form XObject is drawn
FORM_TEXT = (0, 30)  # in the form
FORM_LINE = 468  # from (0, 0) to (468, 0) in the form


def text_box(x, y):
    """The box of TEXT set at (x, y): its advance widths, from the baseline to the cap height."""
    assert set(TEXT) == {ord("I")}
    return [x, y, round(x + len(TEXT) * I_ADVANCE * SIZE, 2), round(y + CAP_HEIGHT * SIZE, 2)]


def line_box(x0, y, x1):
    """The box of a line LINE_WIDTH wide from (x0, y) to (x1, y), with butt caps."""
    return [x0, y - LINE_WIDTH // 2, x1, y + LINE_WIDTH // 2]


side = 64
rows = []
for y in range(side):
    color = b"\x00\x00\xff" if y < side // 2 else b"\x00\xff\x00"
    rows.append(color * side)
image = zlib.compress(b"".join(rows))

form_ops = b"BT /F1 %d Tf %d %d Td (%s) Tj ET 0 G %d w 0 0 m %d 0 l S" % (SIZE, *FORM_TEXT, TEXT, LINE_WIDTH, FORM_LINE)
page_ops = (
    b"BT /F1 %d Tf %d %d Td (%s) Tj ET\n" % (SIZE, *BLACK_TEXT, TEXT)
    + b"0 G %d w %d %d m %d %d l S\n" % (LINE_WIDTH, LINE[0], LINE[1], LINE[2], LINE[1])
    + b"0 g %d %d %d %d re f\n" % RECT
    + b"1 0 0 rg BT /F1 %d Tf %d %d Td (%s) Tj ET 0 g\n" % (SIZE, *RED_TEXT, TEXT)
    + b"q %d 0 0 %d %d %d cm /Im1 Do Q\n" % (IMAGE[2], IMAGE[2], IMAGE[0], IMAGE[1])
    + b"q 1 0 0 1 %d %d cm /Fm1 Do Q\n" % FORM
)
elements = {
    "background": [560, 740, 600, 780],
    "blackText": text_box(*BLACK_TEXT),
    "blackLine": line_box(*LINE),
    "blackRect": [RECT[0], RECT[1], RECT[0] + RECT[2], RECT[1] + RECT[3]],
    "redText": text_box(*RED_TEXT),
    "imageBlue": [IMAGE[0], IMAGE[1] + IMAGE[2] // 2, IMAGE[0] + IMAGE[2], IMAGE[1] + IMAGE[2]],
    "imageGreen": [IMAGE[0], IMAGE[1], IMAGE[0] + IMAGE[2], IMAGE[1] + IMAGE[2] // 2],
    "formText": text_box(FORM[0] + FORM_TEXT[0], FORM[1] + FORM_TEXT[1]),
    "formLine": line_box(FORM[0], FORM[1], FORM[0] + FORM_LINE),
}

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
# last: the harness takes a book folder with book.json as complete (common.mjs)
with open(os.path.join(outdir, "book.json"), "w") as f:
    json.dump({"pages": 1, "text": TEXT.decode(), "elements": elements}, f)
print(f"wrote {len(buf)} bytes")
