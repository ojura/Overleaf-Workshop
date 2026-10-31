// Runs both viewers through drive.mjs and prints a side-by-side table.
//   node compare.mjs [--ext <views/pdf-viewer dir>] [--overleaf DIR] [--pdfjs DIR] [--port 8785]
//                    [--engines overleaf,pdfjs] [--runs frame:40,frame:150,plain:40] [--out DIR]
// --ext defaults to the checkout's views/pdf-viewer; --overleaf and --pdfjs take one viewer from
// another folder, for example another checkout's. By default each viewer runs as VS Code shows it
// (frame) at 40 and 150 ms per request, and as a plain page at 40 ms. The results go to --out, by
// default compare/ in the work folder (common.mjs): <engine>-<mode>-<latency>.json and .log for
// each run, and table.md.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { arg, defaultExt, here, work } from './common.mjs';

const ext = arg('ext', defaultExt);
const exts = { overleaf: arg('overleaf', ext), pdfjs: arg('pdfjs', ext) };
const engines = (arg('engines', 'overleaf,pdfjs')).split(',');
const port = Number(arg('port', '8785'));
const runs = (arg('runs', 'frame:40,frame:150,plain:40')).split(',').map(r => {
    const [mode, latency] = r.split(':');
    return { framed: mode === 'frame', latency: Number(latency) };
});
const outDir = path.resolve(arg('out', path.join(work, 'compare')));
fs.mkdirSync(outDir, { recursive: true });

const all = {};
for (const engine of engines) {
    for (const run of runs) {
        const name = `${engine}-${run.framed ? 'frame' : 'plain'}-${run.latency}`;
        const json = path.join(outDir, `${name}.json`);
        fs.rmSync(json, { force: true });
        const args = [path.join(here, 'drive.mjs'), '--ext', path.resolve(exts[engine]), '--engine', engine, '--latency', String(run.latency),
            '--port', String(port), '--cdp', String(port + 1568), '--json', json, '--shots', path.join(outDir, `shots-${name}`)];
        if (run.framed) { args.push('--frame'); }
        console.log(`running ${name} ...`);
        const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 600000 });
        fs.writeFileSync(path.join(outDir, `${name}.log`), `${result.stdout}\n${result.stderr}`);
        all[name] = fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : { error: result.stderr || 'drive.mjs did not write a result' };
    }
}

const cell = (r, f) => {
    try { const v = f(r); return v === undefined ? 'n/a' : String(v); } catch { return 'n/a'; }
};
const check = (r, name) => {
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
    ['reload: old pages stay during the load', r => check(r, 'reload: the old pages stay while the new build loads')],
    ['reload: same page and offset on screen', r => check(r, 'reload: same page, same offset on screen')],
    ['find: asks before downloading', r => check(r, 'find: the viewer asks before a search downloads the PDF')],
    ['Ctrl+P reaches VS Code', r => check(r, 'Ctrl+P (Quick Open) reaches VS Code')],
    ['Ctrl+Shift+P reaches VS Code', r => check(r, 'Ctrl+Shift+P (Command Palette) reaches VS Code')],
    ['Ctrl+= zooms only the PDF', r => check(r, 'Ctrl+= stays with the viewer (VS Code would zoom its window too)')],
    ['Ctrl+S does not download the PDF', r => check(r, 'Ctrl+S does not download the PDF through the bridge')],
    ['find: MB downloaded in 10 s', r => r.metrics.find10sBridgeMB],
    ['checks passed', r => `${r.results.filter(x => x.ok).length}/${r.results.length}`],
    ['console errors and warnings', r => r.problems.length],
];
const names = Object.keys(all);
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
