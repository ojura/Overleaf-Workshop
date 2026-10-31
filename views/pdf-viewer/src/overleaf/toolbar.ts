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
