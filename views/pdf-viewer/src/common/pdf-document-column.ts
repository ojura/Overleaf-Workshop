import type { MotionLabPanelLayout, MotionLabPanelRect } from './motion-lab-panel';

/** Client-viewport CSS pixels. The helper leaves document scale and scroll offsets unchanged. */
export type PdfDocumentColumnRect = MotionLabPanelRect;
export type PdfDocumentColumnPanel = MotionLabPanelLayout;

export const PDF_DOCUMENT_COLUMN_POLICY = Object.freeze({
    gapPx: 16,
    durationMs: 400,
    // Ignore subpixel overlap noise instead of perpetually retargeting a resting column.
    minimumShiftPx: 0.5,
    offsetProperty: '--pdf-document-column-x',
});

export interface PdfDocumentColumnPlan {
    offsetX: number;
    bounds?: PdfDocumentColumnRect;
}

const valid = (rect: PdfDocumentColumnRect) => [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0;
const intersects = (a: PdfDocumentColumnRect, b: PdfDocumentColumnRect) => a.x < b.x + b.width
    && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** Page rectangles already include appliedX; remove it before measuring existing blank space. */
export function planPdfDocumentColumn(viewport: PdfDocumentColumnRect, pages: readonly PdfDocumentColumnRect[],
    panel: PdfDocumentColumnPanel | undefined, appliedX = 0): PdfDocumentColumnPlan {
    if (!valid(viewport) || !Number.isFinite(appliedX)) { return { offsetX: 0 }; }
    const visible = pages.filter(page => valid(page) && intersects(page, viewport));
    if (!visible.length) { return { offsetX: 0 }; }
    const left = Math.min(...visible.map(page => page.x)) - appliedX;
    const right = Math.max(...visible.map(page => page.x + page.width)) - appliedX;
    const top = Math.min(...visible.map(page => page.y));
    const bottom = Math.max(...visible.map(page => page.y + page.height));
    const bounds = { x: left, y: top, width: right - left, height: bottom - top };
    if (bounds.width >= viewport.width || !panel?.visible || panel.dock === 'float' || !valid(panel.rect)
        || !intersects(panel.rect, viewport) || panel.rect.y >= bottom || panel.rect.y + panel.rect.height <= top) {
        return { offsetX: 0, bounds };
    }
    const gap = PDF_DOCUMENT_COLUMN_POLICY.gapPx;
    const shift = panel.dock === 'right'
        ? -Math.min(Math.max(0, left - viewport.x), Math.max(0, right + gap - panel.rect.x))
        : Math.min(Math.max(0, viewport.x + viewport.width - right), Math.max(0, panel.rect.x + panel.rect.width + gap - left));
    return { offsetX: Math.abs(shift) < PDF_DOCUMENT_COLUMN_POLICY.minimumShiftPx ? 0 : shift, bounds };
}

export interface PdfDocumentColumnTransition {
    id: number;
    fromX: number;
    toX: number;
    startedAt: number;
    durationMs: number;
    reason: PdfDocumentColumnPanel['reason'];
    dock: PdfDocumentColumnPanel['dock'];
    bounds?: PdfDocumentColumnRect;
}

interface Options {
    /** Visible page containers, including both pages of a visible spread. */
    pages(): readonly HTMLElement[];
    onTransition?(transition: Readonly<PdfDocumentColumnTransition> | undefined): void;
    now?(): number;
    requestFrame?(callback: FrameRequestCallback): number;
    cancelFrame?(id: number): void;
}

interface SavedProperty { value: string; priority: string }
const saveProperty = (style: CSSStyleDeclaration, name: string): SavedProperty => ({
    value: style.getPropertyValue(name), priority: style.getPropertyPriority(name),
});
function restoreProperty(style: CSSStyleDeclaration, name: string, saved: SavedProperty): void {
    if (saved.value) { style.setProperty(name, saved.value, saved.priority); }
    else { style.removeProperty(name); }
}

/** Split a computed translate vector without splitting whitespace inside calc()/var(). */
function translateWithOffset(value: string): string {
    const parts: string[] = [];
    let depth = 0, start = 0;
    const text = value && value !== 'none' ? value.trim() : '0px';
    for (let index = 0; index <= text.length; index++) {
        if (text[index] === '(') { depth++; }
        else if (text[index] === ')') { depth--; }
        if (index === text.length || !depth && /\s/.test(text[index])) {
            if (index > start) { parts.push(text.slice(start, index)); }
            start = index + 1;
        }
    }
    return ['calc(' + parts[0] + ' + var(' + PDF_DOCUMENT_COLUMN_POLICY.offsetProperty + ', 0px))', ...parts.slice(1)].join(' ');
}

/**
 * One finite clock writes one inherited translation for pages and registered robot roots.
 * Register disjoint roots (the zero-size transit, not its children). The renderer adds
 * offsetX once to its screen-space scene origin; page getBoundingClientRect already has it.
 * Per-page translation avoids extending the full-width PDF.js viewer's scrollable box.
 */
export function installPdfDocumentColumn(container: HTMLElement, options: Options) {
    const doc = container.ownerDocument, win = doc.defaultView!;
    const now = options.now ?? (() => win.performance.now());
    const requestFrame = options.requestFrame ?? (callback => win.requestAnimationFrame(callback));
    const cancelFrame = options.cancelFrame ?? (id => win.cancelAnimationFrame(id));
    const media = win.matchMedia('(prefers-reduced-motion: reduce)');
    const registered = new Set<HTMLElement>();
    const styled = new Map<HTMLElement, SavedProperty>();
    const observed = new Set<Element>();
    const property = PDF_DOCUMENT_COLUMN_POLICY.offsetProperty;
    let savedOffset: SavedProperty | undefined;
    let panel: PdfDocumentColumnPanel | undefined;
    let offsetX = 0, serial = 0;
    let previousViewport: PdfDocumentColumnRect | undefined, previousBounds: PdfDocumentColumnRect | undefined;
    let transition: Readonly<PdfDocumentColumnTransition> | undefined;
    let frame: { id: number } | undefined;
    let disposed = false;
    const observer = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver(() => update()) : undefined;
    const same = (a: number, b: number) => Math.abs(a - b) < PDF_DOCUMENT_COLUMN_POLICY.minimumShiftPx;
    const sameRect = (a: PdfDocumentColumnRect | undefined, b: PdfDocumentColumnRect | undefined) => a && b
        ? same(a.x, b.x) && same(a.y, b.y) && same(a.width, b.width) && same(a.height, b.height) : a === b;

    function viewport(): PdfDocumentColumnRect {
        const box = container.getBoundingClientRect(), visual = win.visualViewport;
        const left = box.left + container.clientLeft, top = box.top + container.clientTop;
        const x = Math.max(left, visual?.offsetLeft ?? 0), y = Math.max(top, visual?.offsetTop ?? 0);
        return { x, y, width: Math.max(0, Math.min(left + container.clientWidth,
            (visual?.offsetLeft ?? 0) + (visual?.width ?? win.innerWidth)) - x),
        height: Math.max(0, Math.min(top + container.clientHeight,
            (visual?.offsetTop ?? 0) + (visual?.height ?? win.innerHeight)) - y) };
    }

    function roots(pages: readonly HTMLElement[]): Set<HTMLElement> {
        const result = new Set([...pages, ...registered]);
        for (const root of result) {
            if (root === container || root.contains(container)
                || [...result].some(other => other !== root && root.contains(other))) {
                throw new Error('Document column layers must be disjoint roots below the reader');
            }
        }
        return result;
    }

    function styleRoots(next: ReadonlySet<HTMLElement>): void {
        if (!savedOffset) { savedOffset = saveProperty(container.style, property); }
        for (const [root, saved] of styled) {
            if (!next.has(root)) { restoreProperty(root.style, 'translate', saved); styled.delete(root); }
        }
        for (const root of next) {
            if (styled.has(root)) { continue; }
            const saved = saveProperty(root.style, 'translate');
            const base = win.getComputedStyle(root).translate || saved.value || 'none';
            styled.set(root, saved);
            root.style.setProperty('translate', translateWithOffset(base), 'important');
        }
        container.style.setProperty(property, offsetX + 'px');
    }

    function restoreStyles(): void {
        for (const [root, saved] of styled) { restoreProperty(root.style, 'translate', saved); }
        styled.clear();
        if (savedOffset) { restoreProperty(container.style, property, savedOffset); savedOffset = undefined; }
    }

    function observe(pages: readonly HTMLElement[]): void {
        const next = new Set<Element>(panel?.visible && panel.dock !== 'float' ? [container, ...pages] : []);
        for (const root of observed) { if (!next.has(root)) { observer?.unobserve(root); observed.delete(root); } }
        for (const root of next) { if (!observed.has(root)) { observer?.observe(root); observed.add(root); } }
    }

    function apply(value: number): void {
        offsetX = value;
        if (savedOffset) { container.style.setProperty(property, offsetX + 'px'); }
    }

    function notify(): void {
        try { options.onTransition?.(transition); }
        catch (error) { win.console.error('PDF column transition notification failed', error); }
    }

    function end(): void {
        if (frame) { cancelFrame(frame.id); frame = undefined; }
        const previous = transition;
        transition = undefined;
        if (!offsetX) { restoreStyles(); }
        if (previous) { notify(); }
    }

    function schedule(): void {
        if (disposed || frame || !transition) { return; }
        const pending = { id: 0 };
        frame = pending;
        pending.id = requestFrame(at => {
            if (frame !== pending || disposed || !transition) { return; }
            frame = undefined;
            const progress = Math.max(0, Math.min(1, (at - transition.startedAt) / transition.durationMs));
            const eased = 1 - Math.pow(1 - progress, 3);
            apply(transition.fromX + (transition.toX - transition.fromX) * eased);
            if (progress >= 1) { apply(transition.toX); end(); }
            else { schedule(); }
        });
    }

    function measure(animate = false): void {
        if (disposed) { return; }
        const pages = [...new Set(options.pages())].filter(page => page.isConnected !== false);
        const next = roots(pages);
        observe(pages);
        // New visible pages receive the currently applied value before measurement.
        // Otherwise subtracting offsetX would feed an unshifted page back into policy.
        if (savedOffset) { styleRoots(next); }
        const view = viewport();
        const plan = planPdfDocumentColumn(view, pages.map(page => {
            const box = page.getBoundingClientRect();
            return { x: box.left, y: box.top, width: box.width, height: box.height };
        }), panel, offsetX);
        const changed = !sameRect(previousViewport, view) || !sameRect(previousBounds, plan.bounds);
        previousViewport = view; previousBounds = plan.bounds;
        if (transition && same(transition.toX, plan.offsetX) && !changed) { return; }
        if (!transition && same(plan.offsetX, offsetX)) {
            if (!plan.offsetX) { apply(0); restoreStyles(); }
            return;
        }
        end();
        if (disposed) { return; }
        if (plan.offsetX || offsetX) { styleRoots(next); }
        if (!animate || media.matches || doc.hidden || plan.offsetX === offsetX) {
            apply(plan.offsetX); end(); return;
        }
        transition = Object.freeze({ id: ++serial, fromX: offsetX, toX: plan.offsetX,
            startedAt: now(), durationMs: PDF_DOCUMENT_COLUMN_POLICY.durationMs,
            reason: panel?.reason ?? 'viewport', dock: panel?.dock ?? 'float',
            bounds: plan.bounds && Object.freeze({ ...plan.bounds }) });
        notify();
        schedule();
    }

    function update(): void { measure(); }
    function finish(): void { if (transition) { apply(transition.toX); end(); } }
    function visibility(): void { if (doc.hidden) { finish(); } else { update(); } }
    function motionChanged(): void { if (media.matches) { finish(); } }
    win.addEventListener('resize', update);
    win.visualViewport?.addEventListener('resize', update);
    win.visualViewport?.addEventListener('scroll', update);
    doc.addEventListener('visibilitychange', visibility);
    media.addEventListener('change', motionChanged);

    return {
        get offsetX() { return offsetX; },
        get transition() { return transition; },
        setPanel(value: PdfDocumentColumnPanel): void {
            if (disposed) { return; }
            panel = { ...value, rect: { ...value.rect } };
            measure(value.reason === 'open' || value.reason === 'dock' || value.reason === 'close');
        },
        update,
        registerLayer(layer: HTMLElement): () => void {
            if (disposed) { return () => {}; }
            const existing = registered.has(layer);
            registered.add(layer);
            try { if (savedOffset) { styleRoots(roots(options.pages())); } else { roots(options.pages()); } }
            catch (error) { if (!existing) { registered.delete(layer); } throw error; }
            let released = false;
            return () => {
                if (released || existing) { return; }
                released = true; registered.delete(layer);
                const saved = styled.get(layer);
                if (saved && !options.pages().includes(layer)) { restoreProperty(layer.style, 'translate', saved); styled.delete(layer); }
            };
        },
        dispose(): void {
            if (disposed) { return; }
            disposed = true;
            apply(0); end(); restoreStyles(); registered.clear();
            observer?.disconnect(); observed.clear();
            win.removeEventListener('resize', update);
            win.visualViewport?.removeEventListener('resize', update);
            win.visualViewport?.removeEventListener('scroll', update);
            doc.removeEventListener('visibilitychange', visibility);
            media.removeEventListener('change', motionChanged);
        },
    };
}
