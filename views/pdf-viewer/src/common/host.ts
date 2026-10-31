/**
 * The messages between a viewer page and the extension host (src/core/pdfViewEditorProvider.ts).
 *
 * The page posts:
 *   { type: 'ready' }                    once it can take the document; the host answers with
 *                                        'initState', then 'load' or 'update'
 *   { type: 'saveState', content }       the document's viewer state, kept per document URI
 *   { type: 'syncPdf', content: { page, h, v, identifier } }   SyncTeX from the PDF to the source;
 *                                        page counts from 1, h and v are PDF points from the top left
 *   { type: 'recompile' }                compile the project again
 *   { type: 'download' }                 save the PDF to a file the user picks
 *   { type: 'switchViewer', engine }     show the PDFs in the viewer `engine` ('pdfjs' or
 *                                        'overleaf'): the host sets overleaf-workshop.pdfViewer.engine,
 *                                        and the open viewers reload with that viewer's page
 *   { type: 'fetch' | 'fetchAbort', ... } the loader's requests (bridge-fetch.ts)
 *
 * The host posts:
 *   { type: 'initState', content?, colorThemes?, defaults? }
 *   { type: 'load', output }             a build, to load in ranges (output.ts)
 *   { type: 'update', content }          a PDF read whole, as an ArrayBuffer
 *   { type: 'syncCode', content }        SyncTeX from the source to the PDF (synctex.ts)
 *   { type: 'fetchResponse' | 'fetchError', ... }   answers to the loader's requests
 */

/** A position in the document as PDFJSWrapper.currentPosition gives it. */
export interface Position {
    /** counts from 0 */
    page: number;
    offset: { top: number, left: number };
    pageSize: { height: number, width: number };
}

/** The viewer state of one document, which both viewers share. */
export interface SavedState {
    colorTheme?: string;
    scale?: string;
    position?: Position;
    scrollMode?: number;
    spreadMode?: number;
    sidebarView?: number;
    [other: string]: unknown;
}

export interface InitState {
    type: 'initState';
    content?: SavedState;
    colorThemes?: Record<string, { fontColor: string, bgColor: string }>;
    defaults?: { scrollMode?: string, spreadMode?: string };
}

declare function acquireVsCodeApi(): { postMessage(message: unknown): void, getState(): any, setState(state: unknown): void };

// acquireVsCodeApi may be called only once per page
const vscode = acquireVsCodeApi();

export function post(message: object) {
    vscode.postMessage(message);
}

/** answers to the loader's requests, which bridge-fetch.ts takes */
const BRIDGE_REPLIES = new Set(['fetchResponse', 'fetchError']);
const handlers = new Map<string, (message: any) => void>();
/** messages that came before a handler for their type: delivered when it is set */
const early = new Map<string, any[]>();

window.addEventListener('message', (event: MessageEvent) => {
    const message = event.data;
    const type = message?.type;
    if (typeof type !== 'string' || BRIDGE_REPLIES.has(type)) { return; }
    const handler = handlers.get(type);
    if (handler) {
        handler(message);
    } else {
        early.set(type, [...(early.get(type) ?? []), message]);
    }
});

/** Handle the host's messages of `type`; one handler per type, the last one set wins. */
export function onMessage(type: string, handler: (message: any) => void) {
    handlers.set(type, handler);
    const waiting = early.get(type);
    early.delete(type);
    waiting?.forEach(message => handler(message));
}

let state: SavedState = vscode.getState() ?? {};
let readyPromise: Promise<InitState> | undefined;

/** Tell the host that the page can take the document; resolves with the host's 'initState'. */
export function ready(): Promise<InitState> {
    readyPromise ??= new Promise<InitState>((resolve) => {
        onMessage('initState', (message: InitState) => {
            state = { ...message.content, ...state };
            resolve(message);
        });
        post({ type: 'ready' });
    });
    return readyPromise;
}

/** The document's saved viewer state: what the host kept, with this page's later changes. */
export function savedState(): SavedState {
    return state;
}

/** Change part of the document's saved viewer state. */
export function saveState(partial: Partial<SavedState>) {
    state = { ...state, ...partial };
    vscode.setState(state);
    post({ type: 'saveState', content: state });
}
