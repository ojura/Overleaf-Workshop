export interface PdfImageDecodeHints { imageDecodeScale: number; imageDecodeMaxDimension: number }

/** Match the pinned native PageView's density without allocating its full canvas. */
export function nativePdfImageContext(page: any, view: any, pagesRotation = 0, ratio = 1) {
    const rotation = ((page.rotate || 0) + pagesRotation) % 360;
    const natural = page.getViewport({ scale: 1, rotation });
    const viewport = view?.viewport ?? page.getViewport({ scale: (view?.width || natural.width) / natural.width, rotation });
    let sx = view?.outputScale?.sx || ratio;
    let sy = view?.outputScale?.sy || ratio;
    if (!view?.outputScale) {
        if (view?.maxCanvasPixels === 0 && view.scale > 0) { sx /= view.scale; sy /= view.scale; }
        const maximum = Math.min(
            view?.maxCanvasPixels > 0 ? Math.sqrt(view.maxCanvasPixels / (viewport.width * viewport.height)) : Infinity,
            view?.maxCanvasDim > 0 ? view.maxCanvasDim / viewport.width : Infinity,
            view?.maxCanvasDim > 0 ? view.maxCanvasDim / viewport.height : Infinity,
        );
        sx = Math.min(sx, maximum);
        sy = Math.min(sy, maximum);
    }
    const transform = [sx, 0, 0, sy, 0, 0];
    const hints: PdfImageDecodeHints = page.getImageDecodeHints?.({ viewport, transform }) ?? {
        imageDecodeScale: viewport.scale * Math.max(sx, sy),
        imageDecodeMaxDimension: Math.max(viewport.width * sx, viewport.height * sy),
    };
    return { viewport, transform, ...hints };
}
