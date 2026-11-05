import { MOTION_LAB_CHOREOGRAPHY, motionLabEase } from './motion-lab-choreography';

export type MotionLabDock = 'left' | 'right' | 'float';
export interface MotionLabPanelRect { x: number; y: number; width: number; height: number }
export type MotionLabPanelReason = 'open' | 'close' | 'dock' | 'drag' | 'resize' | 'viewport';
export interface MotionLabPanelLayout {
    visible: boolean;
    dock: MotionLabDock;
    /** Arrangement destination in viewport-local CSS pixels. Intermediate paint does not replan it. */
    rect: MotionLabPanelRect;
    reason: MotionLabPanelReason;
}

export interface MotionLabPanelPreparation {
    /** The column's finite scene deadline on the same performance clock as the panel. */
    readyAt: number;
}

export const MOTION_LAB_PANEL_LIMITS = Object.freeze({
    margin: 8, minWidth: 240, minHeight: 160, defaultWidth: 456, defaultHeight: 560, keyboardStep: 10,
});

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const finite = (value: number) => Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;

function validateRect(rect: MotionLabPanelRect): void {
    if (![rect.x, rect.y, rect.width, rect.height].every(finite) || rect.width <= 0 || rect.height <= 0) {
        throw new RangeError('Invalid Motion Lab panel rectangle.');
    }
}

function available(viewport: MotionLabPanelRect): MotionLabPanelRect {
    const x = Math.min(MOTION_LAB_PANEL_LIMITS.margin, Math.max(0, (viewport.width - 1) / 2));
    const y = Math.min(MOTION_LAB_PANEL_LIMITS.margin, Math.max(0, (viewport.height - 1) / 2));
    return { x: viewport.x + x, y: viewport.y + y, width: viewport.width - 2 * x, height: viewport.height - 2 * y };
}

function fit(rect: MotionLabPanelRect, viewport: MotionLabPanelRect): MotionLabPanelRect {
    const room = available(viewport);
    const width = clamp(rect.width, Math.min(MOTION_LAB_PANEL_LIMITS.minWidth, room.width), room.width);
    const height = clamp(rect.height, Math.min(MOTION_LAB_PANEL_LIMITS.minHeight, room.height), room.height);
    return { x: clamp(rect.x, room.x, room.x + room.width - width),
        y: clamp(rect.y, room.y, room.y + room.height - height), width, height };
}

/** Pure bounded geometry. Viewport changes do not discard the remembered floating rectangle. */
export class MotionLabPanelGeometry {
    private viewport: MotionLabPanelRect;
    private floating: MotionLabPanelRect;
    private dock: MotionLabDock = 'float';
    private dockWidth: number;

    constructor(viewport: MotionLabPanelRect, initial?: MotionLabPanelRect) {
        validateRect(viewport);
        if (initial) { validateRect(initial); }
        this.viewport = { ...viewport };
        const room = available(viewport);
        this.floating = fit(initial ?? { x: room.x + room.width - MOTION_LAB_PANEL_LIMITS.defaultWidth,
            y: room.y + room.height - MOTION_LAB_PANEL_LIMITS.defaultHeight,
            width: MOTION_LAB_PANEL_LIMITS.defaultWidth, height: MOTION_LAB_PANEL_LIMITS.defaultHeight }, viewport);
        this.dockWidth = this.floating.width;
    }

    setViewport(viewport: MotionLabPanelRect): void {
        validateRect(viewport);
        this.viewport = { ...viewport };
    }

    setDock(dock: MotionLabDock): void {
        if (dock !== 'left' && dock !== 'right' && dock !== 'float') { throw new RangeError('Invalid Motion Lab dock.'); }
        if (this.dock === 'float' && dock !== 'float') { this.dockWidth = this.snapshot().rect.width; }
        this.dock = dock;
    }

    moveTo(x: number, y: number): void {
        if (!finite(x) || !finite(y)) { throw new RangeError('Invalid Motion Lab position.'); }
        this.floating = fit({ ...this.floating, x, y }, this.viewport);
        this.dock = 'float';
    }

    resizeTo(width: number, height: number): void {
        if (!finite(width) || !finite(height)) { throw new RangeError('Invalid Motion Lab size.'); }
        if (this.dock === 'float') { this.floating = fit({ ...this.floating, width, height }, this.viewport); }
        else { this.dockWidth = fit({ ...this.floating, width }, this.viewport).width; }
    }

    snapshot(): { dock: MotionLabDock; rect: MotionLabPanelRect } {
        if (this.dock === 'float') { return { dock: this.dock, rect: fit(this.floating, this.viewport) }; }
        const room = available(this.viewport);
        const width = clamp(this.dockWidth, Math.min(MOTION_LAB_PANEL_LIMITS.minWidth, room.width), room.width);
        return { dock: this.dock, rect: { x: this.dock === 'left' ? room.x : room.x + room.width - width,
            y: room.y, width, height: room.height } };
    }
}

interface MotionLabPanelOptions {
    surface: HTMLElement;
    dragHandle: HTMLElement;
    resizeHandle: HTMLElement;
    dockButtons: Record<MotionLabDock, HTMLButtonElement>;
    onLayout?: (layout: MotionLabPanelLayout) => MotionLabPanelPreparation | void;
    /** Actual displayed geometry changed; invalidate courier destinations before layout consumers run. */
    onGeometryChange?: () => void;
}

/** Direct manipulation is immediate. Only a finite docking scene owns an animation frame. */
export function installMotionLabPanel(host: HTMLElement, options: MotionLabPanelOptions) {
    const doc = host.ownerDocument, win = doc.defaultView!;
    const media = win.matchMedia('(prefers-reduced-motion: reduce)');
    let geometry: MotionLabPanelGeometry | undefined;
    let visible = false, disposed = false, watching = false;
    let observer: ResizeObserver | undefined;
    let emitted: MotionLabPanelLayout | undefined;
    let displayed: MotionLabPanelRect | undefined;
    let layoutRevision = 0;
    let motion: { from: MotionLabPanelRect; to: MotionLabPanelRect; moveAt: number } | undefined;
    let frame: { id: number } | undefined;
    let gesture: { id: number; handle: HTMLElement; kind: 'drag' | 'resize';
        x: number; y: number; rect: MotionLabPanelRect; dock: MotionLabDock; floatingResize?: boolean } | undefined;
    const sameRect = (a: MotionLabPanelRect, b: MotionLabPanelRect) =>
        (['x', 'y', 'width', 'height'] as const).every(key => a[key] === b[key]);

    function viewport(): MotionLabPanelRect {
        const visual = win.visualViewport;
        return { x: visual?.offsetLeft ?? 0, y: visual?.offsetTop ?? 0,
            width: Math.max(1, visual?.width || win.innerWidth || doc.documentElement.clientWidth),
            height: Math.max(1, visual?.height || win.innerHeight || doc.documentElement.clientHeight) };
    }

    function model(): MotionLabPanelGeometry {
        if (!geometry) {
            const measured = options.surface.getBoundingClientRect();
            const initial = measured.width > 0 && measured.height > 0
                ? { x: measured.left, y: measured.top, width: measured.width, height: measured.height } : undefined;
            geometry = new MotionLabPanelGeometry(viewport(), initial);
        }
        return geometry;
    }

    function invalidateGeometry(): void {
        try { options.onGeometryChange?.(); } catch { /* Keep direct manipulation usable. */ }
    }

    function paint(rect: MotionLabPanelRect): boolean {
        const changed = !displayed || !sameRect(displayed, rect);
        if (!changed) { return false; }
        displayed = { ...rect };
        Object.assign(host.style, { left: rect.x + 'px', top: rect.y + 'px', right: 'auto', bottom: 'auto',
            width: rect.width + 'px', height: rect.height + 'px' });
        Object.assign(options.surface.style, { width: '100%', height: '100%', maxWidth: 'none', maxHeight: 'none' });
        options.resizeHandle.setAttribute('aria-label', 'Resize Motion Lab with arrow keys; ' + Math.round(rect.width) + ' by ' + Math.round(rect.height) + ' pixels');
        invalidateGeometry();
        return true;
    }

    function controls(): void {
        const state = model().snapshot();
        host.dataset.dock = gesture?.floatingResize ? gesture.dock : state.dock;
        for (const dock of ['left', 'right', 'float'] as const) {
            options.dockButtons[dock].setAttribute('aria-pressed', String(dock === state.dock));
        }
    }

    function emit(reason: MotionLabPanelReason, geometryInvalidated: boolean): MotionLabPanelPreparation | void {
        const state = model().snapshot(), rect = state.rect;
        if (emitted && emitted.visible === visible && emitted.dock === state.dock
            && sameRect(emitted.rect, rect)) { return; }
        emitted = { visible, ...state, reason };
        const owned = emitted;
        // A stable destination or visibility change can reserve a courier before the next paint.
        if (!geometryInvalidated) { invalidateGeometry(); }
        if (disposed || emitted !== owned) { return; }
        // Layout consumers must not interrupt pointer cleanup or the diagnostics lifecycle.
        try { return options.onLayout?.({ ...emitted, rect: { ...rect } }); } catch { /* Keep the panel usable. */ }
    }

    function cancelMotion(): void {
        motion = undefined;
        if (frame) { win.cancelAnimationFrame(frame.id); frame = undefined; }
        delete host.dataset.panelMoving;
    }

    function schedule(): void {
        if (!motion || frame || disposed || !visible || doc.hidden) { return; }
        const owned = motion, pending = { id: 0 };
        frame = pending;
        pending.id = win.requestAnimationFrame(at => {
            if (frame !== pending || motion !== owned || disposed || !visible || doc.hidden) { return; }
            frame = undefined;
            const progress = motionLabEase((at - owned.moveAt) / MOTION_LAB_CHOREOGRAPHY.dockMs);
            const rect = { ...owned.to };
            for (const key of ['x', 'y', 'width', 'height'] as const) {
                rect[key] = owned.from[key] + (owned.to[key] - owned.from[key]) * progress;
            }
            paint(rect);
            if (motion !== owned) { return; }
            if (at >= owned.moveAt + MOTION_LAB_CHOREOGRAPHY.dockMs) { cancelMotion(); }
            else { schedule(); }
        });
    }

    function apply(reason: MotionLabPanelReason, animate = false): void {
        const revision = ++layoutRevision, target = model().snapshot().rect;
        const from = displayed ?? target;
        cancelMotion();
        controls();
        const moving = animate && visible && !doc.hidden && !media.matches && !sameRect(from, target);
        const startedAt = moving ? win.performance.now() : 0;
        const owned = moving ? { from: { ...from }, to: { ...target }, moveAt: startedAt } : undefined;
        if (owned) { motion = owned; host.dataset.panelMoving = 'true'; }
        const geometryInvalidated = paint(owned ? from : target);
        if (revision !== layoutRevision || disposed) { return; }
        const preparation = emit(reason, geometryInvalidated);
        if (!owned || motion !== owned || revision !== layoutRevision || disposed || !visible || doc.hidden) { return; }
        if (preparation && finite(preparation.readyAt)) {
            owned.moveAt = clamp(preparation.readyAt, startedAt, startedAt + MOTION_LAB_CHOREOGRAPHY.columnDurationMs);
        }
        schedule();
    }

    function finishMotion(): void {
        if (!motion) { return; }
        ++layoutRevision;
        cancelMotion();
        paint(model().snapshot().rect);
    }

    function takeControl(): MotionLabDock | undefined {
        if (!motion || !displayed) { return; }
        const dock = model().snapshot().dock, rect = { ...displayed };
        ++layoutRevision;
        cancelMotion();
        model().setDock('float');
        model().resizeTo(rect.width, rect.height);
        model().moveTo(rect.x, rect.y);
        return dock;
    }

    function motionChanged(): void {
        if (media.matches) { finishMotion(); }
    }

    function endGesture(): void {
        const previous = gesture;
        gesture = undefined;
        win.removeEventListener('pointermove', pointerMove);
        win.removeEventListener('pointerup', pointerEnd);
        win.removeEventListener('pointercancel', pointerEnd);
        win.removeEventListener('blur', endGesture);
        if (previous) {
            previous.handle.removeEventListener('lostpointercapture', endGesture);
            try { previous.handle.releasePointerCapture(previous.id); } catch { /* Capture may already be lost. */ }
            if (previous.floatingResize) { controls(); }
        }
    }

    function pointerEnd(event: PointerEvent): void {
        if (gesture?.id === event.pointerId) { endGesture(); }
    }

    function pointerMove(event: PointerEvent): void {
        if (!gesture || gesture.id !== event.pointerId || !visible || doc.hidden || disposed) { return; }
        const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
        if (!finite(dx) || !finite(dy)) { return; }
        if (gesture.kind === 'drag') { model().moveTo(gesture.rect.x + dx, gesture.rect.y + dy); }
        else {
            model().resizeTo(gesture.rect.width + (gesture.dock === 'right' ? -dx : dx), gesture.rect.height + dy);
            if (gesture.floatingResize && gesture.dock === 'right') {
                model().moveTo(gesture.rect.x + gesture.rect.width - model().snapshot().rect.width, gesture.rect.y);
            }
        }
        event.preventDefault();
        apply(gesture.kind);
    }

    function begin(event: PointerEvent, kind: 'drag' | 'resize', handle: HTMLElement): void {
        if (disposed || !visible || doc.hidden || gesture || event.button !== 0 || event.isPrimary === false) { return; }
        if (!finite(event.clientX) || !finite(event.clientY)) { return; }
        const interruptedDock = takeControl();
        if (interruptedDock) { apply(kind); }
        if (disposed || !visible || doc.hidden) { return; }
        let state = model().snapshot();
        if (kind === 'drag' && state.dock !== 'float') {
            const fraction = clamp((event.clientX - state.rect.x) / state.rect.width, 0, 1);
            const down = clamp(event.clientY - state.rect.y, 0, 48);
            model().setDock('float');
            model().moveTo(event.clientX - model().snapshot().rect.width * fraction, event.clientY - down);
            apply('drag');
            state = model().snapshot();
        }
        if (disposed || !visible || doc.hidden) { return; }
        gesture = { id: event.pointerId, handle, kind, x: event.clientX, y: event.clientY, ...state,
            dock: interruptedDock ?? state.dock, floatingResize: !!interruptedDock && kind === 'resize' };
        controls();
        event.preventDefault();
        handle.focus({ preventScroll: true });
        try { handle.setPointerCapture(event.pointerId); } catch { /* Window listeners also cover uncaptured pointers. */ }
        handle.addEventListener('lostpointercapture', endGesture);
        win.addEventListener('pointermove', pointerMove);
        win.addEventListener('pointerup', pointerEnd);
        win.addEventListener('pointercancel', pointerEnd);
        win.addEventListener('blur', endGesture);
    }

    const beginDrag = (event: PointerEvent) => begin(event, 'drag', options.dragHandle);
    const beginResize = (event: PointerEvent) => begin(event, 'resize', options.resizeHandle);

    function keyboard(event: KeyboardEvent, kind: 'drag' | 'resize'): void {
        if (disposed || !visible || doc.hidden || event.altKey || event.ctrlKey || event.metaKey) { return; }
        const delta = event.shiftKey ? MOTION_LAB_PANEL_LIMITS.keyboardStep * 4 : MOTION_LAB_PANEL_LIMITS.keyboardStep;
        const dx = event.key === 'ArrowLeft' ? -delta : event.key === 'ArrowRight' ? delta : 0;
        const dy = event.key === 'ArrowUp' ? -delta : event.key === 'ArrowDown' ? delta : 0;
        if (!dx && !dy) { return; }
        endGesture();
        takeControl();
        const state = model().snapshot();
        if (kind === 'drag') {
            if (state.dock !== 'float') { model().setDock('float'); }
            model().moveTo(state.rect.x + dx, state.rect.y + dy);
        } else { model().resizeTo(state.rect.width + dx, state.rect.height + dy); }
        event.preventDefault();
        event.stopPropagation();
        apply(kind);
    }
    const moveKey = (event: KeyboardEvent) => keyboard(event, 'drag');
    const resizeKey = (event: KeyboardEvent) => keyboard(event, 'resize');

    function refreshViewport(): void {
        if (!watching || disposed) { return; }
        endGesture();
        model().setViewport(viewport());
        apply('viewport');
    }

    function stopWatching(): void {
        endGesture();
        finishMotion();
        if (!watching) { return; }
        watching = false;
        observer?.disconnect(); observer = undefined;
        win.removeEventListener('resize', refreshViewport);
        win.visualViewport?.removeEventListener('resize', refreshViewport);
        win.visualViewport?.removeEventListener('scroll', refreshViewport);
        media.removeEventListener('change', motionChanged);
    }

    function visibility(): void {
        if (!visible || doc.hidden || disposed) { stopWatching(); return; }
        if (watching) { return; }
        watching = true;
        model().setViewport(viewport());
        apply('viewport');
        if (!watching || disposed || !visible || doc.hidden) { return; }
        win.addEventListener('resize', refreshViewport);
        win.visualViewport?.addEventListener('resize', refreshViewport);
        win.visualViewport?.addEventListener('scroll', refreshViewport);
        media.addEventListener('change', motionChanged);
        if (win.ResizeObserver) {
            observer = new win.ResizeObserver(() => {
                if (!watching || disposed || motion) { return; }
                const measured = options.surface.getBoundingClientRect(), rect = model().snapshot().rect;
                if (measured.width > 0 && measured.height > 0
                    && (Math.abs(measured.width - rect.width) > 0.5 || Math.abs(measured.height - rect.height) > 0.5)) {
                    model().resizeTo(measured.width, measured.height);
                    apply('resize');
                }
            });
            observer.observe(options.surface);
        }
    }

    function setVisible(value: boolean): void {
        if (disposed || visible === value) { return; }
        visible = value;
        if (visible) {
            model().setViewport(viewport());
            doc.addEventListener('visibilitychange', visibility);
            apply('open');
            visibility();
        } else {
            doc.removeEventListener('visibilitychange', visibility);
            stopWatching();
            apply('close');
        }
    }

    function setDock(dock: MotionLabDock): void {
        if (disposed) { return; }
        endGesture();
        if (model().snapshot().dock === dock) { return; }
        model().setDock(dock);
        apply('dock', true);
    }

    const dockLeft = () => setDock('left'), dockRight = () => setDock('right'), float = () => setDock('float');
    options.dragHandle.addEventListener('pointerdown', beginDrag);
    options.dragHandle.addEventListener('keydown', moveKey);
    options.resizeHandle.addEventListener('pointerdown', beginResize);
    options.resizeHandle.addEventListener('keydown', resizeKey);
    options.dockButtons.left.addEventListener('click', dockLeft);
    options.dockButtons.right.addEventListener('click', dockRight);
    options.dockButtons.float.addEventListener('click', float);

    return {
        setVisible, setDock,
        get moving() { return !!motion; },
        snapshot: () => ({ visible, dock: model().snapshot().dock, rect: { ...(displayed ?? model().snapshot().rect) } }),
        dispose(): void {
            if (disposed) { return; }
            setVisible(false);
            disposed = true;
            stopWatching();
            options.dragHandle.removeEventListener('pointerdown', beginDrag);
            options.dragHandle.removeEventListener('keydown', moveKey);
            options.resizeHandle.removeEventListener('pointerdown', beginResize);
            options.resizeHandle.removeEventListener('keydown', resizeKey);
            options.dockButtons.left.removeEventListener('click', dockLeft);
            options.dockButtons.right.removeEventListener('click', dockRight);
            options.dockButtons.float.removeEventListener('click', float);
        },
    };
}
