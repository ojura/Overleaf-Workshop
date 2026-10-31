import type { BuildState, BuildStatus } from './protocol';
import { post } from './host';

/**
 * The line across the top of a viewer page that says what happens to the project's build, or why
 * the PDF cannot be shown, as Overleaf's viewer shows its errors
 * (features/pdf-preview/components/pdf-preview-error.tsx). Its `data-state` attribute names the
 * state: one of the host's build states (BuildState, src/core/viewerProtocol.ts), which the host's
 * 'buildState' messages carry, or 'failed' when the document could not be shown. The viewer
 * finds 'gone' itself too, when the loader reports the build's files missing from Overleaf's
 * servers and from its cache; it then tells the host (reportGone).
 */
export type BannerState = Exclude<BuildState, 'ready'> | 'failed';

/**
 * Each state's text, from the state's detail. The states in which the project has no PDF and
 * nothing more happens on its own offer Recompile; the others say what is under way.
 */
const STATES: Record<BannerState, { text: (detail?: string) => string, recompile: boolean }> = {
    'none': { text: () => 'There is no build of this PDF yet.', recompile: false },
    'gone': { text: () => 'This build of the PDF is no longer on Overleaf\'s servers.', recompile: false },
    'checking': { text: () => 'Asking Overleaf for the latest compile of the project…', recompile: false },
    'compiling': { text: () => 'Compiling the project on Overleaf…', recompile: false },
    'check-failed': { text: (detail) => `Overleaf could not be asked for the latest compile: ${detail}`, recompile: true },
    'compile-failed': { text: (detail) => `The compile ended without a PDF: ${detail}`, recompile: true },
    'compile-unavailable': { text: (detail) => `The project could not be compiled: ${detail}`, recompile: true },
    'failed': { text: (detail) => detail ? `The PDF could not be shown: ${detail}` : 'The PDF could not be shown.', recompile: false },
};

const STYLE = `
#viewer-banner {
    position: fixed; top: 0; left: 0; right: 0; z-index: 100000;
    display: flex; gap: 12px; align-items: center; padding: 8px 12px;
    font: 13px var(--vscode-font-family, sans-serif);
    color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground, #000));
    background: var(--vscode-inputValidation-errorBackground, #f8d7da);
    border-bottom: 1px solid var(--vscode-inputValidation-errorBorder, #e51400);
}
#viewer-banner.under-way {
    color: var(--vscode-inputValidation-infoForeground, var(--vscode-foreground, #000));
    background: var(--vscode-inputValidation-infoBackground, #d6ecf2);
    border-bottom-color: var(--vscode-inputValidation-infoBorder, #007acc);
}
#viewer-banner span { flex: 1; }
#viewer-banner button {
    font: inherit; padding: 2px 10px; cursor: pointer; border: none;
    color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0e639c);
}
#viewer-banner button.close { background: transparent; color: inherit; font-size: 16px; padding: 0 4px; }
`;

let banner: HTMLElement | undefined;
/** the build that the host was told is gone; the loader can report each request of it */
let reportedGone: string | undefined;

/** Show `state` with its `detail`. */
export function showState(state: BannerState, detail?: string) {
    if (!document.getElementById('viewer-banner-style')) {
        const style = document.createElement('style');
        style.id = 'viewer-banner-style';
        style.textContent = STYLE;
        document.head.append(style);
    }
    banner ??= Object.assign(document.createElement('div'), { id: 'viewer-banner', role: 'alert' });
    if (!banner.isConnected) { document.body.append(banner); }

    const { text, recompile } = STATES[state];
    banner.dataset.state = state;
    banner.classList.toggle('under-way', !recompile && state !== 'failed');
    const parts: HTMLElement[] = [Object.assign(document.createElement('span'), { textContent: text(detail) })];
    if (recompile) {
        const button = Object.assign(document.createElement('button'), { textContent: 'Recompile' });
        button.addEventListener('click', () => post({ type: 'recompile' }));
        parts.push(button);
    }
    const close = Object.assign(document.createElement('button'), { textContent: '×', className: 'close', title: 'Close' });
    close.addEventListener('click', clearBanner);
    parts.push(close);
    banner.replaceChildren(...parts);
}

export function clearBanner() {
    banner?.remove();
}

/**
 * The host's build status: a state to show, or 'ready', which removes the line unless it says
 * that the shown document could not be shown.
 */
export function showBuildState({ state, detail }: BuildStatus) {
    if (state !== 'ready') {
        showState(state, detail);
    } else if (banner?.dataset.state !== 'failed') {
        clearBanner();
    }
}

/**
 * The document of build `build`, or a PDF read whole, was shown: a line about an earlier
 * document's failure, or its build being gone, goes. The page's data-shown-build attribute names
 * the build shown, for the harness's probes (scripts/pdf-viewer-harness).
 */
export function documentShown(build: string | undefined) {
    document.documentElement.dataset.shownBuild = build ?? '';
    if (banner?.dataset.state === 'failed' || banner?.dataset.state === 'gone') {
        clearBanner();
    }
}

/**
 * Show why the document could not be shown. For build `build`, a missing file means that the
 * build is gone from Overleaf's servers, as pdf.js reports it with a ResponseException with
 * `missing` set: the host is told once per build, and asks Overleaf for the latest compile.
 */
export function showLoadError(error: any, build: string | undefined) {
    const missing = error?.missing === true || error?.name === 'MissingPDFException';
    if (!missing || build === undefined) {
        showState('failed', error === undefined ? undefined : String(error?.message ?? error));
        return;
    }
    showState('gone');
    if (reportedGone !== build) {
        reportedGone = build;
        post({ type: 'buildGone', build });
    }
}
