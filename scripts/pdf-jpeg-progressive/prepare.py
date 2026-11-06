"""Export the pinned production decoder for the isolated JPEG measurement tool."""
from pathlib import Path
import json

PINNED_RELEASE = json.loads((Path(__file__).resolve().parents[2] / "package.json").read_text())["devDependencies"]["pdfjs-dist"]

def prepare(worker, output):
    source = Path(worker).read_text()
    expected = ('const pdfjsVersion = "' + PINNED_RELEASE + '";',
                'class IncrementalJpegImage extends JpegImage {',
                'quantizeAndInverse(component, getBlockBufferOffset(component, blockRow, blockCol), scratch, row, rowOffset);')
    for text in expected:
        if source.count(text) != 1:
            raise ValueError("Pinned production decoder differs: " + text)
    result = source + "\nexport { JpegImage, IncrementalJpegImage, getBlockBufferOffset };\n"
    (Path(output) / 'pinned-incremental.mjs').write_text(result)
    print('exported the pinned production incremental JPEG decoder')
