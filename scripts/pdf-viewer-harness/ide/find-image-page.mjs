// Lists the first three pages with images in the PDF of the newest viewer in the hidden IDE
// (ide.mjs), with the number of images and of form XObjects on each, from the pages' drawing
// operators: pages for drive-build.mjs --theme-page and for probe-page-colors.mjs.
//   node ide/find-image-page.mjs [--from 1] [--to <last page>] [--step 1]
// When the instance does not show a viewer that draws, it prints the error and exits with 1.
import { scriptOptions } from '../../lib/options.mjs';
import { instance, INSTANCE_OPTION, newestViewer, workbench } from './ide.mjs';

const options = scriptOptions({ ...INSTANCE_OPTION, from: 'number', to: 'number', step: 'number' });

const from = options.get('from', 1);
const step = options.get('step', 1);
const wb = await workbench(instance(options));
try {
    const { view, V } = await newestViewer(wb);
    const to = options.get('to') ?? await view.E(`${V}.pagesCount`);
    console.log(JSON.stringify(await view.E(`(async () => {
        const d = ${V}.pdfDocument; const OPS = globalThis.pdfjsLib.OPS; const found = [];
        for (let n = ${from}; n <= ${to} && found.length < 3; n += ${step}) {
            const ops = await (await d.getPage(n)).getOperatorList();
            const images = ops.fnArray.filter(f => f === OPS.paintImageXObject || f === OPS.paintInlineImageXObject || f === OPS.paintImageXObjectRepeat).length;
            if (images) { found.push({ page: n, images, forms: ops.fnArray.filter(f => f === OPS.paintFormXObjectBegin).length }); }
        }
        return found;
    })()`)));
} finally {
    wb.close();
}
