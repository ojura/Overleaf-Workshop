// Apply the same native image-pass behavior to the full viewer and the component viewer.
// Each replacement is checked against the pinned release before either build is published.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { repo } from './viewer-protocol.mjs';

export function imageRevisionViewer(source, file = 'PDF.js viewer') {
    if (source.includes('// Verified external image passes')) { return publicationHooks(source); }
    const changes = [
        ['    const prevCanvas = this.canvas;\n    const updateOnFirstShow',
            '    const prevCanvas = this.canvas;\n    this._imageCanvasRetained = false;\n    this._imagePassComplete = false;\n    const updateOnFirstShow'],
        ['      if (prevCanvas) {\n        prevCanvas.replaceWith(canvas);',
            `      const monotoneImagePass = this._imagePassComplete && this._imagePassIntent
        && this._imagePassIntent === this._paintedImageIntent
        && this._imagePassGeometry === this._paintedImageGeometry
        && this._imagePassStatus?.discovered && this.paintedImageStatus?.discovered
        && this._imagePassStatus.total === this.paintedImageStatus.total
        && this._imagePassStatus.covered >= this.paintedImageStatus.covered
        && this._imagePassStatus.revision >= this.paintedImageStatus.revision;
      if (prevCanvas && (!this._imagePassComplete || !this.publishImageCandidate && this._imagePassStatus && !this._imagePassStatus.final && !monotoneImagePass
          && (!this._imagePassStatus.discovered || this._imagePassStatus.covered < this._imagePassStatus.total))) {
        canvas.remove();
        canvas.width = canvas.height = 0;
        this.canvas = prevCanvas;
        this._imageCanvasRetained = true;
        return;
      }
      if (prevCanvas) {
        prevCanvas.replaceWith(canvas);`],
        ['    const renderTask = this.renderTask = this.pdfPage.render(options);',
            `    const imageGeometry = JSON.stringify([options.viewport?.width, options.viewport?.height,
      options.viewport?.transform, options.transform || null, options.background || null,
      options.pageColors?.background, options.pageColors?.foreground]);
    const imageLogicalAppearance = this.imageAppearance;
    const renderTask = this.renderTask = this.pdfPage.render(options);`],
        ['      await renderTask.promise;\n      this.#showCanvas?.(true);',
            `      await renderTask.promise;
      this._imagePassComplete = true;
      this._imagePassStatus = renderTask.imageStatus;
      this._imagePassIntent = renderTask.imageIntent;
      this._imagePassGeometry = imageGeometry;
      this._imagePassAppearance = imageLogicalAppearance;
      this.imagePassStatus = renderTask.imageStatus;
      this.imagePassRevision = renderTask.imageRevision;
      this.#showCanvas?.(true);
      if (!this._imageCanvasRetained) {
        this.paintedImageStatus = renderTask.imageStatus;
        this.paintedImageRevision = renderTask.imageRevision;
        this._paintedImageIntent = renderTask.imageIntent;
        this._paintedImageGeometry = imageGeometry;
      }`],
        ['      error = e;\n      this.#showCanvas?.(true);',
            '      error = e;\n      this._imagePassStatus = renderTask.imageStatus;\n      this.#showCanvas?.(true);'],
        ['      isDetailView,\n      timestamp: performance.now(),',
            `      isDetailView,
      imageRevision: this.paintedImageRevision,
      imageStatus: this.paintedImageStatus,
      imagePassRevision: this.imagePassRevision,
      imagePassStatus: this.imagePassStatus,
      timestamp: performance.now(),`],
        ['  _getRenderingContext(canvasContext, transform) {',
            `  // Verified external image passes use the existing rendering queue and retain their layers.
  redrawImages() {
    if (this.renderingState !== RenderingStates.FINISHED) { return false; }
    this.renderingState = RenderingStates.INITIAL;
    return true;
  }
  _getRenderingContext(canvasContext, transform) {`],
        ['    if (!this.annotationLayer && this.#annotationMode !== AnnotationMode.DISABLE) {',
            `    const earlyImageText = pdfPage._externalImages && this.textLayer;
    if (earlyImageText) { this.structTreeLayer ||= new StructTreeLayerBuilder(pdfPage, viewport.rawDims); }
    const earlyTextPromise = earlyImageText ? this.#renderTextLayer() : null;
    if (!this.annotationLayer && this.#annotationMode !== AnnotationMode.DISABLE) {`],
        ['    this.#originalViewport = viewport;\n    const {\n      canvas,',
            '    const previousImageViewport = this.#originalViewport;\n    this.#originalViewport = viewport;\n    const {\n      canvas,'],
        ['      prevCanvas?.remove();\n      this._resetCanvas();\n    }, renderTask => {\n      this.#useThumbnailCanvas',
            `      if (pdfPage._externalImages && prevCanvas) {
        this._resetCanvas();
        this.canvas = prevCanvas;
        this.#originalViewport = previousImageViewport;
      } else {
        prevCanvas?.remove();
        this._resetCanvas();
      }
    }, renderTask => {
      if (this._imageCanvasRetained) { this.#originalViewport = previousImageViewport; }
      this.#useThumbnailCanvas`],
        ['      const textLayerPromise = this.#renderTextLayer();',
            '      const textLayerPromise = earlyTextPromise || this.#renderTextLayer();'],
    ];
    for (const [from, to] of changes) {
        if (source.split(from).length !== 2) {
            throw new Error(`${file}: the pinned image-pass hook expects ${JSON.stringify(from)} once`);
        }
        source = source.replace(from, to);
    }
    return publicationHooks(source);
}

function publicationHooks(source) {
    source = source.replace('      case RenderingStates.RUNNING:\n        this.div.classList.add("loadingIcon");',
        '      case RenderingStates.RUNNING:\n        if (this.hasUsefulPresentation) { this.div.classList.remove("loadingIcon", "loading"); break; }\n        this.div.classList.add("loadingIcon");');
    if (source.includes('this.publishImageCandidate({ canvas,')) { return source; }
    source = source.replace('const updateOnFirstShow = !prevCanvas && !hasHCM && !hideUntilComplete;',
        'const updateOnFirstShow = !prevCanvas && !hasHCM && !hideUntilComplete && !this.publishImageCandidate;');
    source = source.replace('      if (prevCanvas) {\n        prevCanvas.replaceWith(canvas);\n        prevCanvas.width = prevCanvas.height = 0;\n      } else {\n        onShow(canvas);\n      }',
        `      const commit = () => {
        if (prevCanvas) { prevCanvas.replaceWith(canvas); prevCanvas.width = prevCanvas.height = 0; }
        else { onShow(canvas); }
      };
      if (this.publishImageCandidate) {
        const accepted = this._imagePassComplete && this.publishImageCandidate({ canvas,
          status: this._imagePassStatus, intent: this._imagePassIntent, geometry: this._imagePassGeometry, appearance: this._imagePassAppearance }, commit);
        if (!accepted) { canvas.remove(); canvas.width = canvas.height = 0; this.canvas = prevCanvas || null; this._imageCanvasRetained = true; }
      } else { commit(); }`);
    return source;
}

export function imageRevisionFormat(source, format) {
    const marker = /^const PDF_READING_FORMAT = .*; \/\/ PDF_READING_FORMAT_INPUT$/m;
    if (!marker.test(source)) { throw new Error('The worker has no external-image format input'); }
    return source.replace(marker, `const PDF_READING_FORMAT = ${JSON.stringify(format)}; // PDF_READING_FORMAT_INPUT`);
}

export function installImageRevisions(release) {
    const worker = path.join(release, 'build/pdf.worker.mjs');
    const viewer = path.join(release, 'web/viewer.mjs');
    const format = JSON.parse(readFileSync(path.join(repo, 'src/core/pdfReadingFormat.json'), 'utf8'));
    writeFileSync(worker, imageRevisionFormat(readFileSync(worker, 'utf8'), format));
    writeFileSync(viewer, imageRevisionViewer(readFileSync(viewer, 'utf8'), viewer));
}
