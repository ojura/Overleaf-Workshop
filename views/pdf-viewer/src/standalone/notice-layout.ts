/** Notices follow the measured header without changing the reader's layout. */
export function installNoticeLayout(header: HTMLElement, notice: HTMLElement, details: HTMLElement) {
    const win = header.ownerDocument.defaultView!;
    const viewport = win.visualViewport;
    const scrollKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar']);
    let disposed = false;
    function refresh(): void {
        if (disposed) { return; }
        const rect = header.getBoundingClientRect();
        const top = viewport?.offsetTop ?? 0;
        const height = viewport?.height ?? win.innerHeight;
        const bottom = top + height;
        // A header taller than the viewport must still leave a reachable scrolling
        // notice. Its Retry target supplies the preferred minimum available height.
        const retry = notice.querySelector<HTMLElement>('button');
        const style = win.getComputedStyle(notice);
        const pixels = (value: string) => Number.parseFloat(value) || 0;
        const controlHeight = retry ? retry.getBoundingClientRect().height || pixels(win.getComputedStyle(retry).minHeight) : 0;
        const chromeHeight = controlHeight + pixels(style.paddingTop) + pixels(style.paddingBottom)
            + pixels(style.borderTopWidth) + pixels(style.borderBottomWidth);
        const anchor = Math.max(top, Math.min(rect.bottom, bottom - Math.min(height, chromeHeight)));
        notice.style.setProperty('--notice-top', (anchor - rect.top) + 'px');
        notice.style.setProperty('--notice-available-height', Math.max(0, bottom - anchor) + 'px');
    }
    function keydown(event: KeyboardEvent): void {
        if (notice.hasAttribute('data-error') && !event.isComposing
            && (event.target === details || event.target === notice) && !event.altKey && !event.ctrlKey && !event.metaKey
            && scrollKeys.has(event.key)) {
            // Native scrolling still handles the key; PDF.js must not move focus
            // or scroll the reader instead. Tab, activation and shortcuts pass on.
            event.stopPropagation();
        }
    }
    const observer = new win.ResizeObserver(refresh);
    observer.observe(header);
    win.addEventListener('resize', refresh);
    viewport?.addEventListener('resize', refresh);
    viewport?.addEventListener('scroll', refresh);
    notice.addEventListener('keydown', keydown, true);
    refresh();
    return {
        refresh,
        dispose(): void {
            if (disposed) { return; }
            disposed = true;
            observer.disconnect();
            win.removeEventListener('resize', refresh);
            viewport?.removeEventListener('resize', refresh);
            viewport?.removeEventListener('scroll', refresh);
            notice.removeEventListener('keydown', keydown, true);
            notice.style.removeProperty('--notice-top');
            notice.style.removeProperty('--notice-available-height');
        },
    };
}
