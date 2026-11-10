import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { bundleOptions } from '../build-pdf-viewer.mjs';
const here = path.dirname(fileURLToPath(import.meta.url)), repo = path.resolve(here, '../..'), output = process.argv[2];
if (!path.isAbsolute(output ?? '')) throw new Error('An absolute owned output directory is required');
const fixture = JSON.parse(await fs.readFile(path.join(repo, 'src/test/fixtures/progressive-jpeg.json'), 'utf8'));
const regions = [
    { id: 'photo-a', resource: 'x5', x: 20, y: 245, width: 144, height: 96 },
    { id: 'photo-b', resource: 'x6', x: 205, y: 245, width: 144, height: 96 },
    { id: 'photo-c', resource: 'x7', x: 390, y: 245, width: 144, height: 96 },
    { id: 'photo-d', resource: 'x8', x: 20, y: 100, width: 144, height: 96 },
    { id: 'photo-a-repeat', resource: 'x5', x: 205, y: 100, width: 144, height: 96 },
];
const stream = (dict, data) => `<< ${dict} /Length ${Buffer.byteLength(data, 'latin1')} >>\nstream\n${data}\nendstream`;
const commands = 'BT /F1 14 Tf 20 375 Td (Native text remains readable) Tj ET\n'
    + regions.map(r => `q ${r.width} 0 0 ${r.height} ${r.x} ${r.y} cm /${r.resource} Do Q`).join('\n')
    + '\n0 0 1 rg 60 270 16 18 re f';
const objects = ['', '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 560 400] /Resources << /XObject << /x5 5 0 R /x6 6 0 R /x7 7 0 R /x8 8 0 R >> /Font << /F1 9 0 R >> >> /Contents 4 0 R >>', stream('', commands),
    ...[5, 6, 7, 8].map(id => stream(`/Type /XObject /Subtype /Image /Width 96 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /MotionLabImage (x${id})`, '')),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
let pdf = '%PDF-1.7\n'; const offsets = [0];
for (let i = 1; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf, 'latin1')); pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
const start = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n` + offsets.slice(1).map(v => String(v).padStart(10, '0') + ' 00000 n \n').join('')
    + `trailer\n<< /Root 1 0 R /Size ${objects.length} >>\nstartxref\n${start}\n%%EOF\n`;
await fs.writeFile(path.join(output, 'native-image.pdf'), Buffer.from(pdf, 'latin1'));
await fs.writeFile(path.join(output, 'native-image-data.json'), JSON.stringify({ ...fixture, regions, page: { width: 560, height: 400 }, pdfBytes: Buffer.byteLength(pdf, 'latin1') }));
await fs.copyFile(path.join(here, 'native-image.html'), path.join(output, 'native-image.html'));
await build({ ...bundleOptions, entryPoints: [path.join(here, 'native-image-fixture.ts')], outfile: path.join(output, 'native-image.js') });
console.log('Built native image fixture in ' + output);
