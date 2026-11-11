/**
 * The page's side of the messages between a viewer page and the extension host
 * (src/core/pdfViewEditorProvider.ts). The messages and their types are in src/core/viewerProtocol.ts
 * (HostMessage, ViewerMessage).
 */
import type { HostMessage, SavedState, ViewerMessage } from './protocol';
import type { ViewerBooleanPreference } from './prefetch-performance';
import { config } from './config';

/** the host's answer to 'ready' */
export type InitState = Extract<HostMessage, { type: 'initState' }>;

/** the host's messages that a handler takes; bridge-fetch.ts takes the answers to the page's requests */
type Handled = Exclude<HostMessage['type'], 'fetchResponse' | 'fetchError'>;

declare function acquireVsCodeApi(): { postMessage(message: unknown): void, getState(): any, setState(state: unknown): void };

// acquireVsCodeApi may be called only once per page
const vscode = acquireVsCodeApi();
let disposed = false;

export function post(message: ViewerMessage) {
    if (disposed) { return; }
    vscode.postMessage(message);
}

/** answers to the loader's requests, which bridge-fetch.ts takes */
const BRIDGE_REPLIES = new Set(['fetchResponse', 'fetchError']);
const handlers = new Map<string, (message: any) => void>();
/** messages that came before a handler for their type: delivered when it is set */
const early = new Map<string, any[]>();

window.addEventListener('message', (event: MessageEvent) => {
    if (disposed) { return; }
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
    if (disposed) { return; }
    handlers.set(type, handler);
    const waiting = early.get(type);
    early.delete(type);
    waiting?.forEach(message => handler(message));
}

let state: SavedState = vscode.getState() ?? {};
let readyPromise: Promise<InitState> | undefined;
let robotsEnabled: boolean | undefined;
let robotsChanged = false;
const robotListeners = new Set<(enabled: boolean) => void>();
onMessage('robotsEnabledChanged', message => {
    if (message.page !== config.page || typeof message.enabled !== 'boolean') { return; }
    robotsChanged = true;
    robotsEnabled = message.enabled;
    for (const listener of robotListeners) { listener(message.enabled); }
});

/** Tell the host that the page can take the document; resolves with the host's 'initState'. */
export function ready(): Promise<InitState> {
    readyPromise ??= new Promise<InitState>((resolve) => {
        onMessage('initState', (message: InitState) => {
            state = { ...message.content, ...state };
            if (!robotsChanged) { robotsEnabled = message.robotsEnabled; }
            resolve(message);
        });
        post({ type: 'ready', page: config.page });
    });
    return readyPromise;
}

/** The document's saved viewer state: what the host kept, with this page's later changes. */
export function savedState(): SavedState {
    return state;
}

/** Change part of the document's saved viewer state. */
export function saveState(partial: Partial<SavedState>) {
    if (disposed) { return; }
    state = { ...state, ...partial };
    vscode.setState(state);
    post({ type: 'saveState', page: config.page, content: state });
}

/** Called after the page's final synchronous capture; late callbacks have no message owner. */
export function disposeHost() {
    disposed = true;
    robotListeners.clear();
    handlers.clear();
    early.clear();
}

/** Both viewers wait for the host merge and save only a partial boolean preference. */
function hostBooleanPreference(key: 'motionLabMeasurementsOpen'): ViewerBooleanPreference {
    return Object.freeze({
        async whenReady() { await ready(); },
        read: () => typeof state[key] === 'boolean' ? state[key] : undefined,
        async write(value: boolean) { await ready(); saveState({ [key]: value }); },
    });
}
export const hostMeasurementsPreference = hostBooleanPreference('motionLabMeasurementsOpen');
/** Global robot visibility is separate from either copy of per-document reader state. */
export const hostRobotsPreference: ViewerBooleanPreference = Object.freeze({
    async whenReady() { await ready(); },
    read: () => robotsEnabled,
    async write(enabled: boolean) {
        await ready();
        post({ type: 'setRobotsEnabled', page: config.page, enabled });
    },
    onDidChange(listener: (enabled: boolean) => void) {
        if (!disposed) { robotListeners.add(listener); }
        return () => { robotListeners.delete(listener); };
    },
});
