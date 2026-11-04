/** The toolbar of index.html: page number, zoom, outline, theme, go to source, save, switch to the pdf.js viewer. */
export interface ToolbarActions {
    goToPage(page: number): void;
    zoom(value: string): void; // 'zoom-in', 'zoom-out' or a scale value
    toggleOutline(): void;
    nextTheme(): void;
    goToCode(): void;
    download(): void;
    switchViewer(): void;
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class Toolbar {
    private readonly pageNumber = byId<HTMLInputElement>('pageNumber');
    private readonly numPages = byId<HTMLSpanElement>('numPages');
    private readonly scaleSelect = byId<HTMLSelectElement>('scaleSelect');
    private readonly customScale = byId<HTMLOptionElement>('customScale');
    private readonly outlineToggle = byId<HTMLButtonElement>('outlineToggle');
    private readonly themeToggle = byId<HTMLButtonElement>('themeToggle');
    private pagesCount = 0;

    constructor(private readonly actions: ToolbarActions) {
        byId('previousPage').addEventListener('click', () => actions.goToPage(this.current() - 1));
        byId('nextPage').addEventListener('click', () => actions.goToPage(this.current() + 1));
        this.pageNumber.addEventListener('change', () => actions.goToPage(this.current()));
        this.pageNumber.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') { actions.goToPage(this.current()); }
        });
        byId('zoomIn').addEventListener('click', () => actions.zoom('zoom-in'));
        byId('zoomOut').addEventListener('click', () => actions.zoom('zoom-out'));
        this.scaleSelect.addEventListener('change', () => {
            if (this.scaleSelect.value !== 'custom') { actions.zoom(this.scaleSelect.value); }
        });
        this.outlineToggle.addEventListener('click', () => actions.toggleOutline());
        this.themeToggle.addEventListener('click', () => actions.nextTheme());
        byId('goToCode').addEventListener('click', () => actions.goToCode());
        byId('download').addEventListener('click', () => actions.download());
        byId('switchViewer').addEventListener('click', () => actions.switchViewer());
        this.installOverflow();
    }

    /** Move the existing controls, preserving their listeners, when the pane is narrow. */
    private installOverflow(): void {
        const trigger = byId<HTMLButtonElement>('toolbarMoreToggle');
        const menu = byId<HTMLDivElement>('toolbarMore');
        if (!trigger || !menu) { return; }
        const compact = window.matchMedia('(max-width: 600px)');
        const entries = ['goToCode', 'themeToggle', 'download', 'switchViewer', 'pdf-prefetch-measurements']
            .flatMap(id => {
                const button = byId<HTMLButtonElement>(id);
                if (!button) { return []; }
                const marker = document.createComment(`${id} toolbar position`);
                button.before(marker);
                const label = document.createElement('span');
                label.className = 'more-label';
                label.textContent = button.getAttribute('aria-label') ?? button.title;
                button.append(label);
                return [{ button, marker, role: button.getAttribute('role'), tabIndex: button.getAttribute('tabindex') }];
            });
        const visible = () => entries.map(entry => entry.button).filter(button => !button.hidden && !button.disabled);
        const close = (restoreFocus = false) => {
            menu.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
            if (restoreFocus && !trigger.hidden) { trigger.focus({ preventScroll: true }); }
        };
        const open = (last = false) => {
            if (!compact.matches) { return; }
            menu.hidden = false;
            trigger.setAttribute('aria-expanded', 'true');
            const buttons = visible();
            buttons[last ? buttons.length - 1 : 0]?.focus({ preventScroll: true });
        };
        const update = () => {
            const focused = document.activeElement;
            const movingFocus = entries.some(entry => entry.button === focused);
            close();
            trigger.hidden = !compact.matches;
            for (const entry of entries) {
                if (compact.matches) {
                    menu.append(entry.button);
                    entry.button.setAttribute('role', 'menuitem');
                    entry.button.tabIndex = -1;
                } else {
                    entry.marker.after(entry.button);
                    if (entry.role === null) { entry.button.removeAttribute('role'); }
                    else { entry.button.setAttribute('role', entry.role); }
                    if (entry.tabIndex === null) { entry.button.removeAttribute('tabindex'); }
                    else { entry.button.setAttribute('tabindex', entry.tabIndex); }
                }
            }
            if (compact.matches && movingFocus) { trigger.focus({ preventScroll: true }); }
            else if (!compact.matches && (movingFocus || focused === trigger)) {
                (movingFocus ? focused as HTMLElement : visible()[0])?.focus({ preventScroll: true });
            }
        };
        trigger.addEventListener('click', () => { if (menu.hidden) { open(); } else { close(true); } });
        trigger.addEventListener('keydown', event => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') { return; }
            event.preventDefault();
            event.stopPropagation();
            open(event.key === 'ArrowUp');
        });
        menu.addEventListener('click', event => {
            if ((event.target as Element).closest('button')) { close(true); }
        });
        menu.addEventListener('keydown', event => {
            if (event.key === 'Tab') { close(true); event.stopPropagation(); return; }
            const buttons = visible();
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            let next: number;
            switch (event.key) {
                case 'ArrowDown': next = (index + 1) % buttons.length; break;
                case 'ArrowUp': next = (index - 1 + buttons.length) % buttons.length; break;
                case 'Home': next = 0; break;
                case 'End': next = buttons.length - 1; break;
                default: return;
            }
            event.preventDefault();
            event.stopPropagation();
            buttons[next]?.focus({ preventScroll: true });
        });
        document.addEventListener('keydown', event => {
            if (!menu.hidden && event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close(true);
            }
        }, true);
        document.addEventListener('pointerdown', event => {
            const target = event.target as Node;
            if (!menu.hidden && !menu.contains(target) && !trigger.contains(target)) { close(); }
        }, true);
        menu.addEventListener('focusout', () => queueMicrotask(() => {
            if (!menu.hidden && !menu.contains(document.activeElement) && document.activeElement !== trigger) { close(); }
        }));
        compact.addEventListener('change', update);
        update();
    }

    private current() {
        return Number(this.pageNumber.value) || 1;
    }

    setPage(page: number) {
        this.pageNumber.value = String(page);
    }

    setPagesCount(count: number) {
        this.pagesCount = count;
        this.pageNumber.max = String(count);
        this.numPages.textContent = `/ ${count}`;
    }

    /** `value` is the viewer's currentScaleValue, `scale` its number */
    setScale(value: string, scale: number) {
        const preset = [...this.scaleSelect.options].find(option => option.value === value && option !== this.customScale);
        if (preset) {
            this.customScale.hidden = true;
            this.scaleSelect.value = value;
        } else {
            this.customScale.hidden = false;
            this.customScale.textContent = `${Math.round(scale * 100)}%`;
            this.scaleSelect.value = 'custom';
        }
    }

    setOutlineOpen(open: boolean) {
        this.outlineToggle.setAttribute('aria-pressed', String(open));
    }

    setTheme(name: string | undefined, available: boolean) {
        this.themeToggle.hidden = !available;
        this.themeToggle.dataset.theme = name ?? '';
        this.themeToggle.title = name ? `Color theme: ${name}; click for the next one` : 'Color theme';
        this.themeToggle.setAttribute('aria-label', name ? `Color theme: ${name}` : 'Color theme');
    }

    get pages() {
        return this.pagesCount;
    }
}
