(() => {
  const viewer = () => window.PDFViewerApplication?.pdfViewer ?? window.overleafViewer?.wrapper.viewer;
  const rect = node => {
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  };
  const canvas = (node, reader) => {
    const box = rect(node), css = getComputedStyle(node), opacity = Number(css.opacity);
    return { id: Number(node.dataset.courier) || null, payloadId: Number(node.dataset.payload) || null,
      qualityId: Number(node.dataset.quality) || null, page: Number(node.dataset.page) || null, imageId: node.dataset.imageId ?? null,
      className: node.className, width: node.width, height: node.height, bytes: node.width * node.height * 4,
      cssWidth: parseFloat(css.width), cssHeight: parseFloat(css.height), opacity, rect: box,
      connected: node.isConnected, transform: css.transform, translate: css.translate,
      displayed: node.isConnected && node.width > 0 && node.height > 0 && box.width > 0 && box.height > 0
        && opacity > 0.2 && css.display !== 'none' && css.visibility !== 'hidden'
        && window.__labZoomVisible(box, reader, { width: innerWidth, height: innerHeight }, document.visibilityState === 'visible') };
  };
  const canvases = (selector, reader) => Array.from(document.querySelectorAll(selector), node => canvas(node, reader));
  window.__labZoomSample = () => {
    const v = viewer(), controller = window.pdfPrefetch;
    if (!v?.pagesCount || !controller) {throw new Error('Zoom fixture reader is not ready');}
    const state = controller.snapshot(), robots = state.robots, reader = rect(v.container);
    const vehicles = canvases('.pdfDocumentRobotVehicle', reader);
    const cleaners = canvases('.pdfDocumentRobotCleaner,.pdfDocumentRobotQualityCleaner', reader);
    const cargo = canvases('.pdfDocumentRobotCargo,.pdfDocumentRobotCargoUnderlay,.pdfDocumentRobotQualityCoarse,.pdfDocumentRobotQualitySharp', reader);
    const native = canvases('.page .canvasWrapper canvas', reader);
    const previews = canvases('.pdfPrefetchPreview', reader);
    const view = v.getPageView(v.currentPageNumber - 1);
    const labels = Array.from(document.querySelectorAll('.pdfDocumentRobotCaption'), node => {
      const css = getComputedStyle(node);
      return { text: node.textContent, rect: rect(node), opacity: Number(css.opacity),
        fontSize: parseFloat(css.fontSize), lineHeight: parseFloat(css.lineHeight),
        color: css.color, background: css.backgroundColor, visibility: css.visibility, display: css.display };
    });
    return { at: performance.now(), timeOrigin: performance.timeOrigin, href: location.href,
      dpr: devicePixelRatio, viewport: { width: innerWidth, height: innerHeight }, reader,
      reading: { page: v.currentPageNumber, scale: v.currentScale, scaleValue: v.currentScaleValue,
        rotation: v.pagesRotation, top: v.container.scrollTop, left: v.container.scrollLeft },
      currentPage: { rect: rect(view.div), viewport: { width: view.viewport.width, height: view.viewport.height },
        renderingState: view.renderingState },
      robots, vehicles, cleaners, cargo, labels,
      native: { count: native.length, bytes: native.reduce((sum, item) => sum + item.bytes, 0),
        sizes: native.filter(item => item.bytes).map(item => [item.width, item.height]) },
      previews: { count: previews.length, bytes: previews.reduce((sum, item) => sum + item.bytes, 0) },
      payloadArtifacts: window.__labZoomCollectArtifacts(document),
      ownedElements: Array.from(document.querySelectorAll('[data-payload],[data-quality]'))
        .filter(node => node.isConnected && String(node.className).startsWith('pdfDocumentRobot'))
        .map(node => ({ payloadId: Number(node.dataset.payload) || null, qualityId: Number(node.dataset.quality) || null,
          page: Number(node.dataset.page) || null, imageId: node.dataset.imageId ?? null, className: node.className })),
      direction: state.direction, visible: state.visible, pending: state.pending, missing: state.visibleMissing };
  };
  return { installed: true };
})();
