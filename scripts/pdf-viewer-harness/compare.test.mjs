import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
test('comparison rejects malformed run mode, arity and latency before launching any child', (t) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-compare-test-'));
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    for (const runs of ['fram:40', 'frame:40:extra', 'frame', 'frame:', 'plain:NaN', 'plain:-1', 'plain:Infinity']) {
        const result = spawnSync(process.execPath, ['--import', path.join(here, '../lib/fixtures/no-comparison-child.mjs'),
            path.join(here, 'compare.mjs'), '--runs', runs, '--out', path.join(scratch, 'out')],
        { encoding: 'utf8', env: { ...process.env, PDF_VIEWER_HARNESS_WORK: scratch } });
        assert.equal(result.status, 64, `${runs}: ${result.stderr}`);
        assert.match(result.stderr, /--runs/);
        assert.ok(!result.stderr.includes('reached a child launch'), runs);
        assert.ok(!fs.existsSync(path.join(scratch, 'out')), runs);
    }
});
