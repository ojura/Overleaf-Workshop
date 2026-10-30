import { post } from './host';

/**
 * A message across the top of a viewer page when the PDF cannot be shown, as Overleaf's viewer
 * shows its errors (features/pdf-preview/components/pdf-preview-error.tsx).
 *   missing  the build's files are gone from Overleaf's servers, e.g. after a long pause: pdf.js
 *            reports a ResponseException with `missing` set. A compile makes a new build.
 *   failed   anything else, with the error's message
 */
export type ErrorKind = 'missing' | 'failed';

const STYLE = `
#viewer-error {
    position: fixed; top: 0; left: 0; right: 0; z-index: 100000;
    display: flex; gap: 12px; align-items: center; padding: 8px 12px;
    font: 13px var(--vscode-font-family, sans-serif);
    color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground, #000));
    background: var(--vscode-inputValidation-errorBackground, #f8d7da);
    border-bottom: 1px solid var(--vscode-inputValidation-errorBorder, #e51400);
}
#viewer-error span { flex: 1; }
#viewer-error button {
    font: inherit; padding: 2px 10px; cursor: pointer; border: none;
    color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0e639c);
}
#viewer-error button.close { background: transparent; color: inherit; font-size: 16px; padding: 0 4px; }
`;

let banner: HTMLElement | undefined;

export function showError(kind: ErrorKind, detail?: string) {
    if (!document.getElementById('viewer-error-style')) {
        const style = document.createElement('style');
        style.id = 'viewer-error-style';
        style.textContent = STYLE;
        document.head.append(style);
    }
    banner ??= Object.assign(document.createElement('div'), { id: 'viewer-error', role: 'alert' });
    if (!banner.isConnected) { document.body.append(banner); }

    const text = document.createElement('span');
    text.textContent = kind === 'missing'
        ? 'This build of the PDF is no longer on Overleaf\'s servers. Compile the project again to see the PDF.'
        : `The PDF could not be shown${detail ? `: ${detail}` : '.'}`;
    const parts: HTMLElement[] = [text];
    if (kind === 'missing') {
        const recompile = Object.assign(document.createElement('button'), { textContent: 'Recompile' });
        recompile.addEventListener('click', () => post({ type: 'recompile' }));
        parts.push(recompile);
    }
    const close = Object.assign(document.createElement('button'), { textContent: '×', className: 'close', title: 'Close' });
    close.addEventListener('click', clearError);
    parts.push(close);
    banner.replaceChildren(...parts);
}

export function clearError() {
    banner?.remove();
}

/** The banner's kind for an error of a document load or of the range transport. */
export function errorKind(error: any): ErrorKind {
    return error?.missing === true || error?.name === 'MissingPDFException' ? 'missing' : 'failed';
}
