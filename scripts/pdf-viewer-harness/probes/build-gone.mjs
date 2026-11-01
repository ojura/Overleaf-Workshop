// What a viewer shows about its build (src/core/projectBuilds.ts, views/pdf-viewer/src/common/banner.ts):
// a build that Overleaf's compile server has deleted is drawn from Overleaf's cache of compile
// outputs, without a line about it; a build gone from the cache as well shows the 'gone' line and
// tells the host once, naming the build; the host's build states show as lines, with Recompile
// only where nothing more happens on its own; the host's next build removes the line.
// Every wait is for an event in the page: a change of its DOM (a MutationObserver) or a message to
// the host (the stub's log). Each has a limit of 60 s, the last resort for a page that never gets there.
//   node probes/build-gone.mjs [--ext DIR] [--engine pdfjs|overleaf] [--port 8900]
import { arg, book, openHarness } from '../common.mjs';

const engine = arg('engine', 'pdfjs');
const h = await openHarness({ name: `gone-${engine}`, port: Number(arg('port', '8900')), ext: arg('ext'), bookDir: book('book-20', 20, 64), latency: 10 });
const { page, origin } = h;
const results = [];
const check = (name, ok, detail = '') => {
    results.push(Boolean(ok));
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${engine}: ${name}${detail ? `  (${detail})` : ''}`);
};
const stats = async () => (await fetch(`${origin}/stats`)).json();
async function gone(build, from) {
    const res = await fetch(`${origin}/gone?build=${build}&from=${from}`, { method: 'POST' });
    if (res.status !== 204) { throw new Error(`the server did not take /gone: ${res.status}`); }
}
const builds = await (await fetch(`${origin}/builds`)).json();
const id = { a: builds.a.file.build, b: builds.b.file.build };

/** Installed in each page: a promise that settles when `test()` holds, checked now and at each change of the DOM. */
const helpers = `window.__until = (test, what) => new Promise((resolve, reject) => {
    let timer;
    const observer = new MutationObserver(() => { settle(); });
    const settle = () => {
        const value = test();
        if (!value) { return false; }
        observer.disconnect();
        clearTimeout(timer);
        resolve(value);
        return true;
    };
    if (settle()) { return; }
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    timer = setTimeout(() => { observer.disconnect(); reject(new Error('the page did not show ' + what + ' within 60 s')); }, 60000);
});
window.__first = (type) => Promise.race([
    harness.first(type),
    new Promise((_, reject) => setTimeout(() => reject(new Error('the page did not post ' + type + ' within 60 s')), 60000)),
]);
true`;
const banner = `document.getElementById('viewer-banner')`;
const until = (test, what) => page.evaluate(`window.__until(() => ${test}, ${JSON.stringify(what)})`);
const shown = (build) => until(`document.documentElement.dataset.shownBuild === ${JSON.stringify(build)}`, `build ${build}`);
const line = (state) => until(`${banner}?.dataset.state === ${JSON.stringify(state)}`, `the line '${state}'`);
const noLine = () => until(`!${banner} && 'none'`, 'no line');
const first = (type) => page.evaluate(`window.__first(${JSON.stringify(type)})`);
const hasRecompile = () => page.evaluate(`[...(${banner}?.querySelectorAll('button') ?? [])].some(b => b.textContent === 'Recompile')`);

let loaded;
page.on('Page.loadEventFired', () => { loaded?.(); loaded = undefined; });
/** Open the viewer page on a document of its own, with the helpers installed. */
async function open(doc) {
    const fired = new Promise(resolve => { loaded = resolve; });
    await page.send('Page.navigate', { url: `${origin}/page?engine=${engine}&doc=${doc}` });
    await fired;
    await page.evaluate(helpers);
}

const problems = [];
page.on('Runtime.exceptionThrown', (p) => problems.push(`exception: ${p.exceptionDetails.exception?.description?.slice(0, 200) ?? p.exceptionDetails.text}`));
try {
    // 1. deleted from the compile server only
    await gone('a', 'server');
    await open(`gone-${engine}-1`);
    await shown(id.a);
    const s = await stats();
    check('a build deleted from the compile server is shown from Overleaf\'s cache', s.cacheRequests > 0, `${s.cacheRequests} requests to the cache`);
    check('without a line about it', !(await page.evaluate(`Boolean(${banner})`)));
    check('without telling the host that the build is gone', (await page.evaluate(`harness.messages('buildGone').length`)) === 0);

    // 2. gone from the cache as well
    await gone('a', 'everywhere');
    await open(`gone-${engine}-2`);
    await line('gone');
    const told = await first('buildGone');
    check('a build gone everywhere shows the gone line and tells the host, naming the build', told.build === id.a, `build ${told.build}`);

    // 3. the host's states: what it does about the missing build
    await page.evaluate(`harness.buildState('checking'); true`);
    await line('checking');
    check('the host checking shows its line, without Recompile', !(await hasRecompile()));
    await page.evaluate(`harness.buildState('compiling'); true`);
    await line('compiling');
    check('the host compiling shows its line, without Recompile', !(await hasRecompile()));
    await page.evaluate(`harness.buildState('compile-failed', 'Overleaf\\'s status is "failure"'); true`);
    await line('compile-failed');
    const text = await page.evaluate(`${banner}.textContent`);
    check('a failed compile shows why, and offers Recompile', text.includes('Overleaf\'s status is "failure"') && await hasRecompile(), text.slice(0, 90));
    await page.evaluate(`[...${banner}.querySelectorAll('button')].find(b => b.textContent === 'Recompile').click(); true`);
    await first('recompile');
    check('Recompile asks the host to compile', true);

    // 4. the host's next build, and its state
    await page.evaluate(`harness.buildState('compiling'); true`);
    await line('compiling');
    await page.evaluate(`harness.load('b'); harness.buildState('ready'); true`);
    await shown(id.b);
    await noLine();
    check('the next build is shown, and the line goes', true);
    const reports = await page.evaluate(`harness.messages('buildGone').map(m => m.build)`);
    check('the host was told once that the build is gone', reports.length === 1 && reports[0] === id.a, JSON.stringify(reports));
} catch (error) {
    check('run', false, String(error?.message ?? error));
} finally {
    console.log(`${engine}: exceptions in the page:`, problems.length ? problems : 'none');
    await h.close();
    process.exitCode = results.length && results.every(Boolean) ? 0 : 1;
}
