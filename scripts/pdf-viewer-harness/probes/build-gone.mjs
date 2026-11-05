// What a viewer shows about its build (src/core/projectBuilds.ts, views/pdf-viewer/src/common/banner.ts):
// a build that Overleaf's compile server has deleted is drawn from Overleaf's cache of compile
// outputs, without a line about it; a build gone from the cache as well shows the 'gone' line and
// tells the host once, naming the build; the host's build states show as lines, with Recompile
// only where nothing more happens on its own; the host's next build removes the line.
// Every wait is for an event in the page: a change of its DOM (whenTruthy in scripts/lib/devtools.mjs)
// or a message to the host (the stub's log). Each has a limit of 60 s, the last resort for a page
// that never gets there.
//   node probes/build-gone.mjs [--ext DIR] [--engine pdfjs|overleaf] [--port N]
import { whenTruthy } from '../../lib/devtools.mjs';
import { scriptOptions } from '../../lib/options.mjs';
import { book, checker, openHarness } from '../common.mjs';
import { BANNER, DEFAULT_ENGINE, ENGINES, SHOWN_BUILD } from '../viewers.mjs';

const options = scriptOptions({ engine: ENGINES, ext: 'value', port: 'number' });

/** The last resort for each wait of the probe. */
const LIMIT_MS = 60000;
const engine = options.get('engine', DEFAULT_ENGINE);
const h = await openHarness({ name: `gone-${engine}`, port: options.get('port'), ext: options.get('ext'), bookDir: book('book-20', 20, 64), latency: 10 });
const { page, origin } = h;
const { check: checkOne, summary } = checker();
const check = (name, ok, detail) => checkOne(`${engine}: ${name}`, ok, detail);
const stats = async () => (await fetch(`${origin}/stats`)).json();
async function gone(build, from) {
    const res = await fetch(`${origin}/gone?build=${build}&from=${from}`, { method: 'POST' });
    if (res.status !== 204) { throw new Error(`the server did not take /gone: ${res.status}`); }
}
const builds = await (await fetch(`${origin}/builds`)).json();
const id = { a: builds.a.file.build, b: builds.b.file.build };

/** The value of `test`, an expression for the page, once it is truthy; fails naming `what` after LIMIT_MS. */
const until = async (test, what) => {
    const value = await page.evaluate(whenTruthy(test, LIMIT_MS));
    if (!value) { throw new Error(`the page did not show ${what} within ${LIMIT_MS / 1000} s`); }
    return value;
};
const shown = (build) => until(`${SHOWN_BUILD} === ${JSON.stringify(build)}`, `build ${build}`);
const line = (state) => until(`(${BANNER})?.dataset.state === ${JSON.stringify(state)}`, `the line '${state}'`);
const noLine = () => until(`!${BANNER} && 'none'`, 'no line');
/** The stub's first event of `type`: logged already, or the next one; fails after LIMIT_MS. */
const first = (type) => page.evaluate(`Promise.race([
    harness.first(${JSON.stringify(type)}),
    new Promise((_, reject) => setTimeout(() => reject(new Error('the page did not post ' + ${JSON.stringify(type)} + ' within ${LIMIT_MS / 1000} s')), ${LIMIT_MS})),
])`);
const hasRecompile = () => page.evaluate(`[...((${BANNER})?.querySelectorAll('button') ?? [])].some(b => b.textContent === 'Recompile')`);

let loaded;
page.on('Page.loadEventFired', () => { loaded?.(); loaded = undefined; });
/** Open the viewer page on a document of its own, and wait for its load event. */
async function open(doc) {
    const fired = new Promise(resolve => { loaded = resolve; });
    await page.send('Page.navigate', { url: `${origin}/page?engine=${engine}&doc=${doc}` });
    await fired;
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
    check('without a line about it', !(await page.evaluate(`Boolean(${BANNER})`)));
    check('without telling the host that the build is gone', (await page.evaluate(`harness.messages('buildGone').length`)) === 0);
    const shownA = await page.evaluate(`harness.messages('buildShown').map(m => m.build)`);
    check('and the page tells the host which build it shows', shownA.includes(id.a), JSON.stringify(shownA));

    // 2. gone from the cache as well
    await gone('a', 'everywhere');
    await open(`gone-${engine}-2`);
    await line('gone');
    const told = await first('buildGone');
    check('a build gone everywhere shows the gone line and tells the host, naming the build', told.build === id.a, `build ${told.build}`);
    check('the gone line offers Recompile', await hasRecompile());

    // 3. the host's states: what it does about the missing build
    await page.evaluate(`harness.buildState('checking'); true`);
    await line('checking');
    check('the host checking shows its line, without Recompile', !(await hasRecompile()));
    await page.evaluate(`harness.buildState('compiling'); true`);
    await line('compiling');
    check('the host compiling shows its line, without Recompile', !(await hasRecompile()));
    await page.evaluate(`harness.buildState('unchecked', 'fetch failed'); true`);
    await line('unchecked');
    check('a failed check over a PDF shows quietly, without Recompile', !(await hasRecompile()) && await page.evaluate(`${BANNER}.classList.contains('under-way')`));
    await page.evaluate(`harness.buildState('compile-failed', 'Overleaf\\'s status is "failure"'); true`);
    await line('compile-failed');
    const text = await page.evaluate(`${BANNER}.textContent`);
    check('a failed compile shows why, and offers Recompile', text.includes('Overleaf\'s status is "failure"') && await hasRecompile(), text.slice(0, 90));
    await page.evaluate(`[...${BANNER}.querySelectorAll('button')].find(b => b.textContent === 'Recompile').click(); true`);
    await first('recompile');
    check('Recompile asks the host to compile', true);

    // 4. the host's next build, and its state
    await page.evaluate(`harness.buildState('compiling'); true`);
    await line('compiling');
    await page.evaluate(`harness.load('b'); harness.buildState('ready'); true`);
    await shown(id.b);
    await noLine();
    check('the next build is shown, and the line goes', true);
    const shownB = await page.evaluate(`harness.messages('buildShown').map(m => m.build)`);
    check('the page tells the host that it shows the next build', shownB.includes(id.b), JSON.stringify(shownB));
    const reports = await page.evaluate(`harness.messages('buildGone').map(m => m.build)`);
    check('the host was told once that the build is gone', reports.length === 1 && reports[0] === id.a, JSON.stringify(reports));
} catch (error) {
    check('run', false, String(error?.message ?? error));
} finally {
    console.log(`${engine}: exceptions in the page:`, problems.length ? problems : 'none');
    summary();
    await h.close();
}
