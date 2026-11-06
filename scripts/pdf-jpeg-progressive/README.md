# Progressive JPEG experiment

This opt-in experiment converts a JPEG to progressive scans without changing its
quantized DCT coefficients. It compares the pinned PDF.js decoder's ordinary
full-prefix decoding with the production worker's retained-coefficient parser.
The same parser serves external image revisions in the structural reading PDF;
this command remains an isolated measurement tool for an explicitly chosen JPEG.

## Run

Requirements: Linux/POSIX, Python 3.9 or newer, Node 22 or newer, a C compiler, and
the installed libjpeg development headers and library. There is no package download.

Use an existing JPEG and a **new directory outside this checkout**:

~~~sh
python3 -B scripts/pdf-jpeg-progressive/run.py \
  --input /absolute/path/source.jpg \
  --output /tmp/pdf-jpeg-experiment-1 \
  --publish 1,5,10 \
  --save-images \
  --check-negative-control
~~~

Omit --publish to publish every complete scan. --max-dimension sets the preview's
longest side, from 128 through 2048 pixels; the default is 1024. --worker can point
to another copy of the same pinned PDF.js release.

The input must be an 8-bit, three-component JPEG. An embedded /DCTDecode image
can be extracted with an existing PyMuPDF installation by reading its exact xref
with document.xref_stream_raw(xref) and writing the returned bytes to the chosen
input path. The experiment reads the JPEG only. It does not rewrite a PDF.

## Output and checks

All generated files go to the requested output directory: the compiled C tool,
progressive JPEG, independent coefficient dump, an exported copy of the production
decoder, scan boundaries in config.json, logs, summary.json, and optional
PPM images. Existing output directories are rejected.

The C tool checks every DCT coefficient, referenced quantization table and component
sampling parameter after transcoding. The JS probe checks final RGB equality against the
original, intermediate equality against complete-prefix decoding, a split marker
that must wait for another received byte, cancellation, truncated input and
allocation caps. The optional negative control deliberately makes IDCT overwrite
retained coefficients, requires the invariant to fail, and then checks the
restored implementation.

Results separate entropy time, preview IDCT/conversion time, total pipeline
wall/CPU time, first-pixel received bytes and process peak RSS. Prefix decoding
appends a synthetic EOI only for that comparison. The retained-state decoder
waits for actual following marker bytes and decodes each complete scan once.

## Boundaries

Input is capped at 16 MiB, image dimensions at 16,777,216 pixels, and retained
coefficients at 64 MiB. The decoder retains its compressed input in a growing,
bounded buffer. Preview IDCT uses one sampled block row and a 64-value scratch
block while retaining the original coefficients. Production first-scan coverage
can pause with only exact DC entries, then expand the same state for later scans.
Synchronous work can be canceled between scan chunks;
there is no timer or idle loop. Each child has a 60-second CPU limit, the Node
heap limit is 512 MiB, and subprocess wall time is bounded.

The guarded export in prepare.py checks the package's pinned PDF.js version and
requires the production incremental decoder. The canonical vendor patch owns
that decoder; the experiment has no second parser or IDCT implementation. DNL
height reparsing and truncated input reject this retained-state path. Production
publication selects supported inputs and retains original encoded assets for
native full-decode fallback. Final native image revisions use the already
received complete bytes and the normal PDF.js color and adaptive-size path.

Keep image bytes, generated modules and measurements outside Git. Maintained
source here is sufficient to reproduce the experiment against another explicit
input.
