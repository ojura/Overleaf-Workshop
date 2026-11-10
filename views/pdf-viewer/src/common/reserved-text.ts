/** Reserve automatic text states. Read live.textContent for the current value, since
 * element.textContent also includes the hidden geometry reservations. */
export function installReservedText(element: HTMLElement, alternatives: readonly string[], text: string) {
    function validate(values: readonly string[], value: string): void {
        if (!values.includes(value)) { throw new RangeError('Reserved text must belong to its finite variant domain.'); }
    }
    validate(alternatives, text);
    const doc = element.ownerDocument;
    const live = doc.createElement('span');
    live.style.gridArea = '1 / 1';
    live.style.minWidth = '0';
    const saved = { display: element.style.display, gridTemplateColumns: element.style.gridTemplateColumns };
    element.style.display = 'grid';
    element.style.gridTemplateColumns = 'minmax(0, 1fr)';
    const installed = { display: element.style.display, gridTemplateColumns: element.style.gridTemplateColumns };
    const reservations: HTMLSpanElement[] = [];
    let domain: string[] = [];
    let disposed = false;
    function setVariants(values: readonly string[]): void {
        const next = [...new Set(values)];
        if (next.length === domain.length && next.every((value, index) => value === domain[index])) { return; }
        domain = next;
        for (const node of reservations) { node.remove(); }
        reservations.length = 0;
        for (const value of next) {
            const node = doc.createElement('span');
            node.setAttribute('aria-hidden', 'true');
            Object.assign(node.style, { gridArea: '1 / 1', minWidth: '0', visibility: 'hidden',
                pointerEvents: 'none', userSelect: 'none', webkitUserSelect: 'none' });
            node.textContent = value;
            reservations.push(node);
            element.append(node);
        }
    }
    function setText(value: string): void {
        if (disposed) { throw new Error('Reserved text is disposed.'); }
        validate(domain, value);
        if (live.textContent !== value) { live.textContent = value; }
    }
    function update(values: readonly string[], value: string): void {
        if (disposed) { throw new Error('Reserved text is disposed.'); }
        validate(values, value);
        setVariants(values);
        setText(value);
    }
    setVariants(alternatives);
    element.append(live);
    setText(text);
    function dispose(): void {
        if (disposed) { return; }
        disposed = true;
        for (const node of reservations) { node.remove(); }
        reservations.length = 0;
        live.remove();
        domain = [];
        if (element.style.display === installed.display) { element.style.display = saved.display; }
        if (element.style.gridTemplateColumns === installed.gridTemplateColumns) { element.style.gridTemplateColumns = saved.gridTemplateColumns; }
    }
    return { live, setText, update, dispose };
}
