import { config } from './config';

/**
 * pdf.js's worker, started from the page's own origin. The webview's resources come from
 * another origin, so `new Worker(url)` on pdf.worker.mjs fails; a blob made of its text is the
 * page's own. pdf.worker.mjs imports nothing, so it runs from a blob unchanged.
 * Set the result once as pdfjsLib.GlobalWorkerOptions.workerPort, so that every document uses
 * this one worker.
 */
export async function createWorkerPort(): Promise<Worker> {
    const res = await fetch(`${config.pdfjs.build}pdf.worker.mjs`);
    if (!res.ok) {
        throw new Error(`pdf.worker.mjs: ${res.status} ${res.statusText}`);
    }
    const blob = new Blob([await res.text()], { type: 'text/javascript' });
    return new Worker(URL.createObjectURL(blob), { type: 'module' });
}
