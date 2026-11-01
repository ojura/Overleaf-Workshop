// Runs both viewers through drive.mjs and prints a side-by-side table: drive.mjs's measurements, and
// each check that a run reported, by its name, with n/a for a run that did not report it (a check
// of one viewer only).
//   node compare.mjs [--ext <views/pdf-viewer dir>] [--overleaf DIR] [--pdfjs DIR] [--port 8785]
//                    [--engines overleaf,pdfjs] [--runs frame:40,frame:150,plain:40] [--out DIR]
// --ext defaults to the checkout's views/pdf-viewer; --overleaf and --pdfjs take one viewer from
// another folder, for example another checkout's. By default each viewer runs as VS Code shows it
// (frame) at 40 and 150 ms per request, and as a plain page at 40 ms. The results go to --out, by
// default compare/ in the work folder (common.mjs): <engine>-<mode>-<latency>.json and .log for
// each run, and table.md. Exit status 0 when every run passed all its checks, 1 when a run failed
// a check, failed itself or did not write a result; a run that a signal ended stops the comparison, with
// that run's status.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EXIT_CODES } from '../lib/cleanup.mjs';
import { scriptOptions } from '../lib/options.mjs';
import { defaultExt, here, work } from './common.mjs';

const options = scriptOptions({ ext: 'value', overleaf: 'value', pdfjs: 'value', engines: 'value', port: 'number', runs: 'value', out: 'value' });

/**
 * The last resort for a drive that never ends: drive.mjs ends on its own, also when the viewer
 * hangs, since each of its waits has a limit; a run takes about a minute.
 */
const RUN_LIMIT_MS = 600000;

const ext = options.get('ext', defaultExt);
const exts = { overleaf: options.get('overleaf', ext), pdfjs: options.get('pdfjs', ext) };
const engines = (options.get('engines', 'overleaf,pdfjs')).split(',');
const port = options.get('port', 8785);
const runs = (options.get('runs', 'frame:40,frame:150,plain:40')).split(',').map(r => {
    const [mode, latency] = r.split(':');
    return { framed: mode === 'frame', latency: Number(latency) };
});
const outDir = path.resolve(options.get('out', path.join(work, 'compare')));
fs.mkdirSync(outDir, { recursive: true });

const all = {};
/** the runs that failed, with why */
const failures = [];
for (const engine of engines) {
    for (const run of runs) {
        const name = `${engine}-${run.framed ? 'frame' : 'plain'}-${run.latency}`;
        const json = path.join(outDir, `${name}.json`);
        fs.rmSync(json, { force: true });
        const args = [path.join(here, 'drive.mjs'), '--ext', path.resolve(exts[engine]), '--engine', engine, '--latency', String(run.latency),
            '--port', String(port), '--json', json, '--shots', path.join(outDir, `shots-${name}`)];
        if (run.framed) { args.push('--frame'); }
        console.log(`running ${name} ...`);
        // at the limit drive.mjs gets SIGTERM, ends as on Ctrl+C (scripts/lib/cleanup.mjs) and stops its Chrome
        const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: RUN_LIMIT_MS });
        fs.writeFileSync(path.join(outDir, `${name}.log`), `${result.stdout}\n${result.stderr}`);
        all[name] = fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : { error: result.stderr || 'drive.mjs did not write a result' };
        if (result.error?.code === 'ETIMEDOUT') {
            failures.push(`${name}: still running after ${RUN_LIMIT_MS / 1000} s, ended with SIGTERM`);
        } else if (Object.values(EXIT_CODES).includes(result.status)) {
            console.log(`${name} ended by a signal (exit status ${result.status}); the comparison stops`);
            process.exit(result.status);
        } else if (result.error) {
            failures.push(`${name}: could not run drive.mjs: ${result.error.message}`);
        } else if (result.status !== 0) {
            failures.push(`${name}: drive.mjs exited with ${result.signal ?? `status ${result.status}`}`);
        } else if (all[name].error) {
            failures.push(`${name}: ${all[name].error}`);
        }
    }
}

const cell = (r, f) => {
    try { const v = f(r); return v === undefined ? 'n/a' : String(v); } catch { return 'n/a'; }
};
const names = Object.keys(all);
/** the checks that the runs reported, by name, in the order in which they first appear */
const checkNames = [...new Set(names.flatMap(n => (all[n].results ?? []).map(c => c.name)))];
const checkCell = (r, name) => {
    const c = r.results?.find(x => x.name === name);
    return c ? (c.ok ? 'yes' : 'NO') : 'n/a';
};
const rows = [
    ['first page (ms)', r => r.metrics.firstPageMs],
    ['first page, MB through the bridge', r => r.metrics.firstPageBridgeMB],
    ['page 60 (ms)', r => r.metrics.page60Ms],
    ['reload: swap (ms)', r => r.metrics.reloadSwapMs],
    ['reload: page 60 drawn (ms)', r => r.metrics.reloadRenderedMs],
    ['reload: MB through the bridge / from the server', r => `${r.metrics.reloadBridgeMB} / ${r.metrics.reloadServerMB}`],
    ['find: MB downloaded in 10 s', r => r.metrics.find10sBridgeMB],
    ...checkNames.map(name => [name, r => checkCell(r, name)]),
    ['checks passed', r => `${r.results.filter(x => x.ok).length}/${r.results.length}`],
    ['console errors and warnings', r => r.problems.length],
];
let table = `| | ${names.join(' | ')} |\n|---|${names.map(() => '---').join('|')}|\n`;
for (const [label, f] of rows) {
    table += `| ${label} | ${names.map(n => all[n].error ? 'error' : cell(all[n], f)).join(' | ')} |\n`;
}
fs.writeFileSync(path.join(outDir, 'table.md'), table);
console.log(`\n${table}\nresults in ${outDir}`);
for (const n of names) {
    const failed = all[n].results?.filter(x => !x.ok) ?? [];
    if (failed.length || all[n].error) {
        console.log(`${n}: ${all[n].error ?? failed.map(f => `${f.name} (${f.detail})`).join('; ')}`);
    }
}
if (failures.length) {
    console.log(`\n${failures.length} of ${names.length} runs failed:\n${failures.map(f => `  ${f}`).join('\n')}`);
}
process.exitCode = failures.length ? 1 : 0;
