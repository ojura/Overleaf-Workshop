"""Guarded extraction for the opt-in JPEG experiment; no production file is written."""
from pathlib import Path
import difflib, re

PINNED_RELEASE = "5.1.91"

def prepare(worker, output):
    root=Path(output)
    source=Path(worker).read_text()
    assert source.count('const pdfjsVersion = "'+PINNED_RELEASE+'";') == 1, 'Pinned PDF.js release differs'
    def once(text,old,new):
        assert text.count(old)==1,old[:100]
        return text.replace(old,new)
    start=source.index('  parse(data, {\n    dnlScanLines = null\n  } = {}) {')
    end=source.index('  _getLinearizedBlockData(',start)
    original=source[start:end]
    parser=once(original,'  parse(data, {\n    dnlScanLines = null\n  } = {}) {','  *_parse() {\n    let data;\n    const dnlScanLines = null;')
    parser=once(parser,'    let fileMarker = readUint16(data, offset);','    data = yield* this._need(offset + 2);\n    let fileMarker = readUint16(data, offset);')
    parser=re.sub(r'(?m)^(\s*)fileMarker = readUint16\(data, offset\);',r'\1data = yield* this._need(offset + 2);\n\1fileMarker = readUint16(data, offset);',parser)
    parser=once(parser,'      let i, j, l;','''      if (fileMarker !== 0xffff) {
            data = yield* this._need(offset + 2);
            const length = readUint16(data, offset);
            if (length < 2) { throw new JpegError("Invalid segment length"); }
            data = yield* this._need(offset + length + 2);
          }
          let i, j, l;''')
    parser=once(parser,'          prepareComponents(frame);','          this._validateFrame(frame);\n          prepareComponents(frame);\n          this._frame = frame;')
    parser=once(parser,'          const parseDNLMarker = ++numSOSMarkers === 1 && !dnlScanLines;','          ++numSOSMarkers;\n          const parseDNLMarker = false;')
    parser=once(parser,'          try {\n            const processed = decodeScan(','''          const available = yield* this._scan(offset);
              data = available.data;
              const entropyStarted = performance.now();
              this.entropyCalls++;
              try {
                const processed = decodeScanBounded(''')
    parser=once(parser,'            offset += processed;','''            offset += processed;
                if (offset !== available.end) { throw new JpegError("Entropy boundary differs"); }
                this.entropyMs += performance.now() - entropyStarted;
                this.width = frame.samplesPerLine;
                this.height = frame.scanLines;
                this.jfif = jfif; this.adobe = adobe;
                this.numComponents = frame.components.length;
                this._quantizationTables = quantizationTables;
                yield { type: "scan", scan: numSOSMarkers, received: this._length,
                  boundary: available.end, entropyMs: this.entropyMs,
                  coefficientsBytes: this.coefficientBytes };''')
    first=parser.index('            if (ex instanceof DNLMarkerError)')
    last=parser.index('            throw ex;',first)
    parser=parser[:first]+parser[last:]
    first=parser.index('    this.width = frame.samplesPerLine;',parser.index('    if (!frame) {'))
    parser=parser[:first]+'''    return { type: "done", scans: numSOSMarkers, received: this._length };
      }
    '''
    start=source.index('function decodeScan(');end=source.index('function quantizeAndInverse(',start)
    entropy=source[start:end].replace('function decodeScan(','function decodeScanBounded(',1)
    entropy=once(entropy,'    bitsData = data[offset++];','    if (offset >= data.length) { throw new JpegError("Entropy read beyond received bytes"); }\n    bitsData = data[offset++];')
    entropy=once(entropy,'      const nextByte = data[offset++];','      if (offset >= data.length) { throw new JpegError("Marker read beyond received bytes"); }\n      const nextByte = data[offset++];')
    helper=Path(__file__).with_name('incremental-template.mjs').read_text()
    result=source+'\n'+entropy+'\n'+helper.replace('/* RESUMABLE_PARSE */',parser)+'\nexport { JpegImage, IncrementalJpegImage, getBlockBufferOffset };\n'
    (root/'pinned-incremental.mjs').write_text(result)
    (root/'incremental-parser.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True),parser.splitlines(True),fromfile='pinned-JpegImage.parse',tofile='private-IncrementalJpegImage._parse')))
    print('prepared resumable parser with guarded pinned entropy decoder')
