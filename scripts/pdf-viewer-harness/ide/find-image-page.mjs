// Lists the first three pages with images in the PDF of the newest viewer in the hidden IDE
// (ide.mjs), with the number of images and of form XObjects on each, from the pages' drawing
// operators: pages for drive-build.mjs --theme-page and for probe-page-colors.mjs.
//   node ide/find-image-page.mjs [--from 1] [--to <last page>] [--step 1]
import { arg } from '../common.mjs';
import { instance, viewerFrames, viewerOf, viewerPage, workbench } from './ide.mjs';

const inst = instance();
const wb = await workbench(inst);
const frame = (await viewerFrames(wb)).at(-1);
if (!frame) { console.error('the instance does not show a PDF viewer'); wb.close(); process.exit(1); }
const view = await viewerPage(wb, frame);
const shown = await view.drawn(undefined, 30000);
if (!shown) { console.error('the webview does not show a drawn viewer page'); wb.close(); process.exit(1); }
const V = viewerOf(shown.engine);
const from = Number(arg('from', '1'));
const step = Number(arg('step', '1'));
const to = arg('to') ? Number(arg('to')) : await view.E(`${V}.pagesCount`);
console.log(JSON.stringify(await view.E(`(async () => {
    const d = ${V}.pdfDocument; const OPS = globalThis.pdfjsLib.OPS; const found = [];
    for (let n = ${from}; n <= ${to} && found.length < 3; n += ${step}) {
        const ops = await (await d.getPage(n)).getOperatorList();
        const images = ops.fnArray.filter(f => f === OPS.paintImageXObject || f === OPS.paintInlineImageXObject || f === OPS.paintImageXObjectRepeat).length;
        if (images) { found.push({ page: n, images, forms: ops.fnArray.filter(f => f === OPS.paintFormXObjectBegin).length }); }
    }
    return found;
})()`)));
wb.close();
