export interface RobotInteractionPoint { x: number; y: number }

export const ROBOT_INTERACTION_LIMITS = Object.freeze({
    maxMovementPx: 8,
    // A touch-generated click may follow pointerup after the browser's tap delay.
    maxClickDelayMs: 800,
});

interface RobotInteractionOptions {
    hitTest(point: RobotInteractionPoint): { id: number } | undefined;
    onHover(id: number | undefined, point?: RobotInteractionPoint): void;
    onGreet(id: number): void;
}

const INTERACTIVE = 'a[href],area[href],button,input,select,textarea,label,summary,'
    + '[role="button"],[role="link"],[role="textbox"],[role="combobox"],[role="checkbox"],'
    + '[role="radio"],[role="switch"],[role="slider"],[role="spinbutton"],[role="tab"],'
    + '[role="option"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],'
    + '.annotationLayer,.annotationEditorLayer';

interface Press {
    pointerId: number;
    id: number;
    origin: RobotInteractionPoint;
    releasedAt?: number;
}

/** Observe existing client-space robot hit boxes without taking native input ownership. */
export function installRobotInteraction(container: HTMLElement, options: RobotInteractionOptions) {
    const doc = container.ownerDocument, win = doc.defaultView!;
    const listeners: (() => void)[] = [];
    let enabled = true, disposed = false, press: Press | undefined;
    let pointer: RobotInteractionPoint | undefined, hoverAllowed = false;
    let hovered: number | undefined, reportedPoint: RobotInteractionPoint | undefined;

    const selection = () => doc.getSelection()?.isCollapsed === false;
    const modified = (event: MouseEvent) => event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
    const coordinates = (event: MouseEvent): RobotInteractionPoint | undefined =>
        Number.isFinite(event.clientX) && Number.isFinite(event.clientY) ? { x: event.clientX, y: event.clientY } : undefined;
    const moved = (from: RobotInteractionPoint, to: RobotInteractionPoint) =>
        Math.hypot(from.x - to.x, from.y - to.y) > ROBOT_INTERACTION_LIMITS.maxMovementPx;
    const interactive = (event: Event) => event.composedPath().some(node => {
        const element = node as HTMLElement;
        return typeof element.matches === 'function' && (element.isContentEditable || element.matches(INTERACTIVE));
    });
    const usable = (event: MouseEvent) => enabled && !disposed && !doc.hidden && !event.defaultPrevented
        && !modified(event) && !selection() && !interactive(event);
    function hit(point: RobotInteractionPoint): number | undefined {
        const id = options.hitTest({ ...point })?.id;
        return Number.isSafeInteger(id) && id! >= 0 ? id : undefined;
    }
    function hover(id?: number, point?: RobotInteractionPoint): void {
        if (id === hovered && (id === undefined || point?.x === reportedPoint?.x && point?.y === reportedPoint?.y)) { return; }
        hovered = id;
        reportedPoint = id === undefined || !point ? undefined : { ...point };
        options.onHover(id, reportedPoint && { ...reportedPoint });
    }
    function clear(): void {
        press = undefined; pointer = undefined; hoverAllowed = false;
        hover();
    }
    function update(): void {
        if (!enabled || disposed || doc.hidden || !hoverAllowed || !pointer || selection()) { hover(); return; }
        hover(hit(pointer), pointer);
    }
    function pointerMove(event: PointerEvent): void {
        const point = coordinates(event);
        if (press?.pointerId === event.pointerId && point && moved(press.origin, point)) { press = undefined; }
        if (!enabled || disposed || event.pointerType === 'touch' || event.isPrimary === false || !point) { return; }
        pointer = point;
        hoverAllowed = usable(event) && event.buttons === 0;
        update();
    }
    function pointerDown(event: PointerEvent): void {
        press = undefined;
        if (event.pointerType === 'touch') { pointer = undefined; hoverAllowed = false; hover(); }
        if (!usable(event) || event.button !== 0 || event.isPrimary === false) { return; }
        const point = coordinates(event);
        if (!point) { return; }
        const id = hit(point);
        if (id !== undefined) { press = { pointerId: event.pointerId, id, origin: point }; }
    }
    function otherPointer(event: PointerEvent): void {
        if (press && press.pointerId !== event.pointerId) { press = undefined; }
    }
    function pointerUp(event: PointerEvent): void {
        const active = press;
        if (!active || active.pointerId !== event.pointerId) { return; }
        const point = coordinates(event);
        if (!usable(event) || event.button !== 0 || !event.composedPath().includes(container)
            || !point || moved(active.origin, point) || hit(point) !== active.id) {
            press = undefined; return;
        }
        active.releasedAt = win.performance.now();
    }
    function click(event: MouseEvent): void {
        const active = press;
        press = undefined;
        if (!active || active.releasedAt === undefined || !usable(event) || event.button !== 0 || event.detail === 0) { return; }
        const elapsed = win.performance.now() - active.releasedAt;
        const point = coordinates(event);
        if (elapsed < 0 || elapsed > ROBOT_INTERACTION_LIMITS.maxClickDelayMs || !point
            || moved(active.origin, point) || hit(point) !== active.id) { return; }
        options.onGreet(active.id);
    }
    function leave(): void {
        // Touch pointerleave precedes its compatibility click. Keep only that completed
        // gesture; a press leaving the reader before pointerup is canceled.
        if (press?.releasedAt === undefined) { press = undefined; }
        pointer = undefined; hoverAllowed = false; hover();
    }
    function cancel(): void { clear(); }
    function scroll(): void { press = undefined; hover(); }
    function selectionChanged(): void {
        if (selection()) { press = undefined; hover(); } else { update(); }
    }
    function visibility(): void { if (doc.hidden) { clear(); } }
    function listen(target: EventTarget, name: string, callback: (event: any) => void, capture = false): void {
        target.addEventListener(name, callback, { capture, passive: true });
        listeners.push(() => target.removeEventListener(name, callback, capture));
    }

    listen(container, 'pointermove', pointerMove, true);
    listen(container, 'pointerdown', pointerDown, true);
    listen(container, 'pointerleave', leave);
    // Bubble after native PDF handlers so a consumed click never greets a robot.
    listen(container, 'click', click);
    listen(win, 'pointerdown', otherPointer, true);
    listen(win, 'pointerup', pointerUp, true);
    listen(win, 'pointercancel', cancel, true);
    listen(win, 'blur', cancel);
    listen(container, 'contextmenu', cancel, true);
    listen(container, 'wheel', scroll, true);
    listen(doc, 'scroll', scroll, true);
    listen(doc, 'selectionchange', selectionChanged);
    listen(doc, 'visibilitychange', visibility);

    return {
        update,
        setEnabled(value: boolean): void {
            if (disposed || enabled === value) { return; }
            enabled = value;
            if (!value) { clear(); }
        },
        dispose(): void {
            if (disposed) { return; }
            disposed = true; enabled = false;
            for (const remove of listeners.splice(0)) { remove(); }
            clear();
        },
    };
}
