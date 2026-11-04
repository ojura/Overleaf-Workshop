import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

const { values } = parseArgs({ options: {
    output: { type: 'string' },
    decoder: { type: 'string', default: 'pinned-incremental.mjs' },
    'check-only': { type: 'boolean', default: false },
} });
assert(values.output, '--output is required');
assert(['pinned-incremental.mjs', 'negative-incremental.mjs'].includes(values.decoder));
const output = path.resolve(values.output);
const config = JSON.parse(fs.readFileSync(path.join(output, 'config.json'), 'utf8'));
const { JpegImage, IncrementalJpegImage, getBlockBufferOffset } =
    await import(pathToFileURL(path.join(output, values.decoder)).href);
const bytes = new Uint8Array(fs.readFileSync(path.join(output, 'progressive.jpg')));
const scans = config.scans;
const selected = new Set(config.publish);
const scale = Math.min(1, config.maxDimension / Math.max(config.width, config.height));
const width = Math.max(1, Math.round(config.width * scale));
const height = Math.max(1, Math.round(config.height * scale));
const hash = data => createHash('sha256').update(data).digest('hex');
const cpuMs = value => (value.user + value.system) / 1000;

function coefficientHash(decoder) {
    const digest = createHash('sha256');
    for (const component of decoder._frame.components) { digest.update(component.blockData); }
    return digest.digest('hex');
}

function checks() {
    const controller = new AbortController();
    const decoder = new IncrementalJpegImage({ signal: controller.signal });
    try {
        decoder.push(bytes.subarray(0, scans[0].boundary + 1));
        assert.equal(decoder.next().type, 'need');
        assert.equal(decoder.entropyCalls, 0, 'Entropy began before the received scan ended');
        decoder.push(bytes.subarray(scans[0].boundary + 1, scans[0].receivedToRecognize));
        assert.equal(decoder.next().type, 'scan');
        const before = coefficientHash(decoder);
        decoder.render({ width, height });
        assert.equal(coefficientHash(decoder), before, 'IDCT mutated retained coefficients');
        controller.abort();
        assert.throws(() => decoder.next(), { name: 'AbortError' });
        assert.throws(() => decoder.push(new Uint8Array(1)), { name: 'AbortError' });
    } finally {
        decoder.cancel();
        assert.equal(decoder.coefficientBytes, 0);
        assert.equal(decoder.inputCapacity, 0);
    }
    const truncated = new IncrementalJpegImage();
    truncated.push(bytes.subarray(0, scans[0].boundary + 1), { final: true });
    assert.throws(() => truncated.next(), /Truncated received JPEG/);
    assert.equal(truncated.entropyCalls, 0);
    assert.equal(truncated.coefficientBytes, 0);
    assert.equal(truncated.inputCapacity, 0);
    const tiny = new IncrementalJpegImage({ maxInputBytes: 100 });
    assert.throws(() => tiny.push(new Uint8Array(101)), /JPEG input limit/);
    assert.equal(tiny.inputCapacity, 0);
    tiny.cancel();
    const limited = new IncrementalJpegImage({ maxCoefficientBytes: 1024 });
    limited.push(bytes.subarray(0, scans[0].receivedToRecognize));
    assert.throws(() => limited.next(), /JPEG coefficient limit/);
    assert.equal(limited.coefficientBytes, 0);
    limited.cancel();
    return { splitMarkerWaited: true, coefficientsSurvivePreview: true,
        abortReleased: true, truncationReleased: true, inputAndCoefficientCaps: true };
}

function compareCoefficients(decoder) {
    const file = fs.openSync(path.join(output, 'coefficients.bin'), 'r');
    let position = 0, count = 0;
    try {
        for (const component of decoder._frame.components) {
            const length = component.blocksPerLine * 64 * 2;
            const row = Buffer.alloc(length);
            for (let y = 0; y < component.blocksPerColumn; y++) {
                assert.equal(fs.readSync(file, row, 0, length, position), length);
                const offset = getBlockBufferOffset(component, y, 0);
                const actual = Buffer.from(component.blockData.buffer,
                    component.blockData.byteOffset + offset * 2, length);
                assert(actual.equals(row), 'Independent libjpeg coefficient mismatch');
                position += length;
                count += length / 2;
            }
        }
        assert.equal(position, fs.fstatSync(file).size);
    } finally { fs.closeSync(file); }
    return count;
}

function decode(data, outWidth, outHeight) {
    const started = performance.now(), cpu = process.cpuUsage();
    const image = new JpegImage();
    image.parse(data);
    const rgb = image.getData({ width: outWidth, height: outHeight, forceRGB: true, isSourcePDF: true });
    return { rgb, wallMs: performance.now() - started, cpuMs: cpuMs(process.cpuUsage(cpu)) };
}

function saveImage(name, rgb) {
    if (!config.saveImages) { return; }
    const header = Buffer.from('P6\n' + width + ' ' + height + '\n255\n');
    const data = new Uint8Array(rgb.buffer, rgb.byteOffset, rgb.byteLength);
    fs.writeFileSync(path.join(output, name), Buffer.concat([header, data]));
}

if (values['check-only']) {
    console.log(JSON.stringify(checks()));
} else {
    const original = new Uint8Array(fs.readFileSync(config.input));
    const report = { inputBytes: original.length, progressiveBytes: bytes.length,
        width: config.width, height: config.height, previewWidth: width, previewHeight: height,
        publish: [...selected], transcode: config.transcode, prefixes: [] };
    let full = decode(original, config.width, config.height);
    report.originalFull = { wallMs: full.wallMs, cpuMs: full.cpuMs, sha256: hash(full.rgb) };
    full = null;
    global.gc?.();
    full = decode(bytes, config.width, config.height);
    report.progressiveFull = { wallMs: full.wallMs, cpuMs: full.cpuMs, sha256: hash(full.rgb) };
    assert.equal(report.originalFull.sha256, report.progressiveFull.sha256);
    full = null;
    global.gc?.();
    const prefixStart = performance.now(), prefixCpu = process.cpuUsage();
    for (const scan of scans) {
        if (!selected.has(scan.scan)) { continue; }
        const prefix = new Uint8Array(scan.boundary + 2);
        prefix.set(bytes.subarray(0, scan.boundary));
        prefix.set([255, 217], scan.boundary);
        let decoded = decode(prefix, width, height);
        report.prefixes.push({ scan: scan.scan, received: scan.boundary,
            syntheticEndMarkerBytes: 2, wallMs: decoded.wallMs, cpuMs: decoded.cpuMs,
            sha256: hash(decoded.rgb) });
        saveImage('scan-' + scan.scan + '.ppm', decoded.rgb);
        decoded = null;
        global.gc?.();
    }
    report.prefixPipelineWallMs = performance.now() - prefixStart;
    report.prefixPipelineCpuMs = cpuMs(process.cpuUsage(prefixCpu));
    const expected = new Map(report.prefixes.map(entry => [entry.scan, entry.sha256]));
    const decoder = new IncrementalJpegImage();
    const incremental = { chunkBytes: 65537, scans: [] };
    report.incremental = incremental;
    let position = 0, waiting = decoder.next();
    const started = performance.now(), cpu = process.cpuUsage();
    function drain() {
        for (;;) {
            const event = decoder.next();
            if (event.type !== 'scan') { waiting = event; return; }
            let pixels;
            const renderStart = performance.now();
            if (selected.has(event.scan)) { pixels = decoder.render({ width, height }); }
            const renderMs = pixels ? performance.now() - renderStart : 0;
            const pixelsReadyMs = performance.now() - started;
            if (pixels) {
                incremental.firstPixelsWallMs ??= pixelsReadyMs;
                incremental.firstPixelsReceivedBytes ??= event.received;
                assert.equal(hash(pixels), expected.get(event.scan), 'Incremental scan raster differs');
            }
            incremental.scans.push({ ...event, published: !!pixels, renderMs, pixelsReadyMs });
            pixels = null;
            global.gc?.();
        }
    }
    function feedUntil(end, final = false) {
        while (position < end) {
            const next = Math.min(end, position + incremental.chunkBytes);
            decoder.push(bytes.subarray(position, next), { final: final && next === end });
            position = next;
            drain();
        }
    }
    try {
        feedUntil(scans[0].boundary + 1);
        assert.equal(decoder.entropyCalls, 0);
        assert.equal(waiting.type, 'need');
        feedUntil(scans[0].receivedToRecognize);
        assert.equal(decoder.entropyCalls, 1);
        feedUntil(bytes.length, true);
        assert.equal(waiting.type, 'done');
        assert.equal(decoder.entropyCalls, scans.length);
        incremental.pipelineWallMs = performance.now() - started;
        incremental.pipelineCpuMs = cpuMs(process.cpuUsage(cpu));
        incremental.entropyMs = decoder.entropyMs;
        incremental.previewRenderMs = decoder.renderMs;
        incremental.coefficientBytes = decoder.coefficientBytes;
        incremental.inputCapacity = decoder.inputCapacity;
        incremental.coefficientsChecked = compareCoefficients(decoder);
        const before = coefficientHash(decoder);
        full = decoder.render({ width: config.width, height: config.height });
        assert.equal(hash(full), report.originalFull.sha256, 'Final incremental raster differs');
        assert.equal(coefficientHash(decoder), before, 'Final IDCT mutated retained coefficients');
        full = null;
        incremental.peakAccountedBytes = decoder.peakAccountedBytes;
        incremental.exactCoefficients = true;
        incremental.exactFinalRaster = true;
    } finally {
        decoder.cancel();
        assert.equal(decoder.inputCapacity, 0);
        assert.equal(decoder.coefficientBytes, 0);
    }
    global.gc?.();
    report.checks = checks();
    global.gc?.();
    report.peakRssKiB = process.resourceUsage().maxRSS;
    console.log(JSON.stringify(report));
}
