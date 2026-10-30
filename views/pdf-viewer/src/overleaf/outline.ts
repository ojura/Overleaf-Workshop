/**
 * The document outline (bookmarks) as a tree in #outline. pdf.js's viewer components have no
 * outline view (PDFOutlineViewer belongs to the generic viewer app), so this one renders what
 * pdfDocument.getOutline() returns and follows links through the viewer's PDFLinkService.
 * getOutline reads only the outline's objects.
 */
interface OutlineItem {
    title: string;
    bold?: boolean;
    italic?: boolean;
    dest?: string | unknown[] | null;
    url?: string | null;
    count?: number;
    items: OutlineItem[];
}

export class Outline {
    private readonly element = document.getElementById('outline') as HTMLElement;
    private doc: any;

    constructor(private readonly linkService: any) {}

    get open() {
        return !this.element.hidden;
    }

    setOpen(open: boolean) {
        this.element.hidden = !open;
        document.body.classList.toggle('outline-open', open);
        if (open && this.doc && !this.element.childElementCount) { void this.render(this.doc); }
    }

    /** Show `doc`'s outline; it is read only while the outline is open. */
    async render(doc: any) {
        this.doc = doc;
        this.element.textContent = '';
        if (!this.open) { return; }
        let items: OutlineItem[] | null = null;
        try {
            items = await doc.getOutline();
        } catch (error) {
            console.warn('pdf viewer: reading the outline:', error);
        }
        if (doc !== this.doc) { return; }
        this.element.textContent = '';
        if (!items?.length) {
            const empty = document.createElement('div');
            empty.className = 'outline-empty';
            empty.textContent = 'This PDF has no outline.';
            this.element.append(empty);
            return;
        }
        this.element.append(this.list(items, 0));
    }

    private list(items: OutlineItem[], depth: number): DocumentFragment {
        const fragment = document.createDocumentFragment();
        for (const item of items) {
            const row = document.createElement('div');
            row.className = 'outline-item';
            row.style.setProperty('--depth', String(depth));
            row.setAttribute('role', 'treeitem');
            const twisty = document.createElement('span');
            twisty.className = 'outline-twisty';
            const title = document.createElement('span');
            title.className = 'outline-title';
            title.textContent = item.title;
            if (item.bold) { title.style.fontWeight = 'bold'; }
            if (item.italic) { title.style.fontStyle = 'italic'; }
            title.title = item.title;
            row.append(twisty, title);
            fragment.append(row);
            let children: HTMLDivElement | undefined;
            if (item.items.length) {
                children = document.createElement('div');
                children.setAttribute('role', 'group');
                children.append(this.list(item.items, depth + 1));
                // as pdf.js's outline view: a positive count means the item starts expanded
                const expanded = (item.count ?? 0) > 0;
                children.hidden = !expanded;
                twisty.textContent = expanded ? '▾' : '▸';
                twisty.addEventListener('click', (event) => {
                    event.stopPropagation();
                    children!.hidden = !children!.hidden;
                    twisty.textContent = children!.hidden ? '▸' : '▾';
                });
                fragment.append(children);
            }
            row.addEventListener('click', () => this.follow(item));
        }
        return fragment;
    }

    private follow(item: OutlineItem) {
        if (item.dest) {
            void this.linkService.goToDestination(item.dest);
        } else if (item.url) {
            // VS Code's webview opens the clicked link with the user's confirmation
            const link = document.createElement('a');
            link.href = item.url;
            link.rel = 'noopener';
            document.body.append(link);
            link.click();
            link.remove();
        }
    }
}
