// Which colors does each color theme change? Draws the page of theme_book.py in a viewer, then
// steps through the themes with the theme button and counts the pixel colors in the box of each
// thing on the page, from the book's book.json. Saves a screenshot per theme as
// shots/theme-<engine>-<theme>.png in the work folder.
//   node probes/theme-colors.mjs [--ext DIR] [--engine pdfjs|overleaf] [--port N]
// It prints the colors it counts, for a person to read; its exit status says only whether it ran to its end.
import { bookFacts, openHarness, shotPath, themeBook } from '../common.mjs';
import { areaColorsFunction, buttonOf, DEFAULT_ENGINE, ENGINES, pageDrawn, switchThemeFunction } from '../viewers.mjs';
import { scriptOptions } from '../../lib/options.mjs';

const options = scriptOptions({ engine: ENGINES, ext: 'value', port: 'number' });

const engine = options.get('engine', DEFAULT_ENGINE);
const bookDir = themeBook();
const h = await openHarness({ name: `theme-${engine}`, port: options.get('port'), ext: options.get('ext'), bookDir, latency: 5 });
const { page } = h;
const problems = [];
page.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error' || p.type === 'warning') { problems.push(p.args.map(a => a.value ?? a.description).join(' ').slice(0, 200)); } });
page.on('Runtime.exceptionThrown', (p) => problems.push(`exception: ${p.exceptionDetails.exception?.description?.slice(0, 200)}`));
await page.send('Page.navigate', { url: `${h.origin}/frame?engine=${engine}&doc=theme-${engine}` });
await page.useFrame();
await page.waitFor(pageDrawn(engine, 1), 60000);

// the boxes of the things on the page (theme_book.py), each sampled 2 points inside its edges
const sample = `(${areaColorsFunction(engine)})(1, ${JSON.stringify(bookFacts(bookDir).elements)})`;
/** the colors of each box as "#rrggbb 87%, ..." */
const colors = async () => Object.fromEntries(Object.entries(await page.evaluate(sample))
    .map(([name, list]) => [name, list.map(([color, share]) => `${color} ${Math.round(100 * share)}%`).join(', ')]));
console.log(`theme ${await page.evaluate(`${buttonOf(engine, 'theme')}?.dataset.theme`)}:`, JSON.stringify(await colors(), null, 1));
for (let i = 0; i < 3; i++) {
    // the next theme, once page 1 is drawn in it
    const name = await page.evaluate(`(${switchThemeFunction(engine)})(1)`);
    console.log(`theme ${name}:`, JSON.stringify(await colors(), null, 1));
    await page.screenshot(shotPath(`theme-${engine}-${name}.png`));
}
console.log('console problems:', problems.length ? problems : 'none');
await h.close();
