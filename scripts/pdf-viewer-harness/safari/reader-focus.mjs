// A page's text layer may be replaced while its logical reading position stays the same.
export function createReaderFocus({ document, window, viewer: getViewer, pages, panelRoot = () => undefined }) {
  const panelSelectors = ['.panel-drag', '[data-panel-dock="left"]', '[data-panel-dock="right"]', '[data-panel-dock="float"]'];
  const deep = () => {
    let element = document.activeElement;
    while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
    return element;
  };
  const unique = (root, selector) => {
    const matches = root?.querySelectorAll(selector);
    return matches?.length === 1 ? matches[0] : undefined;
  };
  const pageText = pageNumber => {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pages) return;
    const viewer = getViewer(), view = viewer?.getPageView(pageNumber - 1), root = view?.div, target = view?.textLayer?.div;
    if (view?.id === pageNumber && root?.isConnected && root.dataset.pageNumber === String(pageNumber)
        && viewer.container.contains(root) && target?.isConnected && root.contains(target)) return target;
  };
  const capture = () => {
    const element = deep(), viewer = getViewer();
    if (window.getSelection()?.isCollapsed === false || element?.closest('input,textarea,[contenteditable="true"]')) {
      throw new Error('Reading input is active');
    }
    if (element === document.body) return { kind: 'body' };
    if (element === document.documentElement) return { kind: 'html' };
    if (element === viewer?.container) return { kind: 'viewer' };
    const root = element?.closest('.page[data-page-number]'), pageNumber = Number(root?.dataset.pageNumber);
    if (element && pageText(pageNumber) === element && viewer.getPageView(pageNumber - 1).div === root) {
      return { kind: 'page-text', pageNumber };
    }
    if (element?.id && document.getElementById(element.id) === element
        && unique(document, '#' + window.CSS.escape(element.id)) === element) return { kind: 'id', id: element.id };
    const panel = panelRoot();
    if (panel) {
      const selectors = [...panelSelectors];
      const direction = element?.dataset?.panelResize;
      if (typeof direction === 'string' && /^(?:[ns][ew]?|[ew])$/.test(direction)) selectors.push('[data-panel-resize="' + direction + '"]');
      for (const selector of selectors) if (unique(panel, selector) === element) return { kind: 'panel', selector };
    }
    throw new Error('The focused control cannot be restored unambiguously');
  };
  const resolve = saved => {
    if (!saved || typeof saved !== 'object') return;
    if (saved.kind === 'body') return document.body;
    if (saved.kind === 'html') return document.documentElement;
    if (saved.kind === 'viewer') return getViewer()?.container;
    if (saved.kind === 'page-text') return pageText(saved.pageNumber);
    if (saved.kind === 'id' && typeof saved.id === 'string') return unique(document, '#' + window.CSS.escape(saved.id));
    if (saved.kind === 'panel' && typeof saved.selector === 'string'
        && (panelSelectors.includes(saved.selector) || /^\[data-panel-resize="(?:[ns][ew]?|[ew])"\]$/.test(saved.selector))) {
      return unique(panelRoot(), saved.selector);
    }
  };
  const matches = saved => {
    const target = resolve(saved);
    return !!target?.isConnected && deep() === target;
  };
  const restore = async (saved, { guard, nextFrame }) => {
    guard();
    let target = resolve(saved);
    while (saved?.kind === 'page-text' && !target) {
      guard(); await nextFrame(); guard(); target = resolve(saved);
    }
    if (!target?.isConnected || typeof target.focus !== 'function') throw new Error('The saved focused control is missing');
    if (deep() !== target) {
      guard();
      if (saved.kind === 'body') {
        const current = deep();
        if (typeof current?.blur !== 'function') throw new Error('The current focused control cannot be blurred');
        current.blur();
      } else target.focus({ preventScroll: true });
    }
    guard();
    if (!matches(saved)) throw new Error('The saved focus was not restored');
    return capture();
  };
  return { capture, matches, restore };
}
