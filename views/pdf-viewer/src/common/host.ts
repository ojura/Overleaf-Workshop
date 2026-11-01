/**
 * The page's side of the messages between a viewer page and the extension host
 * (src/core/pdfViewEditorProvider.ts). The messages and their types are in src/core/viewerProtocol.ts
 * (HostMessage, ViewerMessage).
 */
import type { HostMessage, SavedState, ViewerMessage } from './protocol';

/** the host's answer to 'ready' */
export type InitState = Extract<HostMessage, { type: 'initState' }>;

/** the host's messages that a handler takes; bridge-fetch.ts takes the answers to the page's requests */
type Handled = Exclude<HostMessage['type'], 'fetchResponse' | 'fetchError'>;

declare function acquireVsCodeApi(): { postMessage(message: unknown): void, getState(): any, setState(state: unknown): void };

// acquireVsCodeApi may be called only once per page
const vscode = acquireVsCodeApi();

export function post(message: ViewerMessage) {
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
export function onMessage<T extends Handled>(type: T, handler: (message: Extract<HostMessage, { type: T }>) => void) {
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
