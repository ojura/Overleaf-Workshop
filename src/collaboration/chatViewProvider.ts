import * as vscode from 'vscode';
import { SocketIOAPI } from '../api/socketio';
import { ProjectMessageResponseSchema } from '../api/base';
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { ROOT_NAME } from '../consts';
import { LocalReplicaSCMProvider } from '../scm/localReplicaSCM';

type ChatChange =
    | { type: 'new'; message: ProjectMessageResponseSchema }
    | { type: 'edit'; messageId: string; content: string }
    | { type: 'delete'; messageId: string }
    | { type: 'snapshot'; messages: ProjectMessageResponseSchema[] };

export class ChatViewProvider implements vscode.WebviewViewProvider {
    private readonly unread = new Set<string>();
    private readonly messages = new Map<string, ProjectMessageResponseSchema>();
    private webviewView?: vscode.WebviewView;
    private readonly socketSubscription: { dispose(): void };
    private viewSubscriptions: vscode.Disposable[] = [];
    private disposed = false;
    private ready = false;
    private pendingInsertions: string[] = [];
    private fetching?: Promise<void>;
    private duringFetch: ChatChange[] = [];

    constructor(
        private readonly vfs: VirtualFileSystem,
        private readonly publicId: string,
        private readonly extensionUri: vscode.Uri,
        private readonly socket: SocketIOAPI,
        private readonly statusChanged: () => void = () => {},
    ) {
        this.socketSubscription = this.socket.updateEventHandlers({
            onReceivedMessage: message => {
                if (!this.webviewView?.visible && message.user.id !== this.vfs._userId) { this.unread.add(message.id); }
                this.receive({ type: 'new', message });
                this.statusChanged();
            },
            onMessageEdited: message => this.receive({ type: 'edit', ...message }),
            onMessageDeleted: message => { this.unread.delete(message.messageId); this.receive({ type: 'delete', ...message }); this.statusChanged(); },
            onMessagesRefreshed: messages => this.receive({ type: 'snapshot', messages }),
        });
    }

    async loadWebviewHtml(_webview: vscode.Webview): Promise<string> {
        const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'views/chat-view/dist/index.html');
        return (await vscode.workspace.fs.readFile(htmlPath)).toString();
    }

    async resolveWebviewView(view: vscode.WebviewView, _context: vscode.WebviewViewResolveContext<unknown>, _token: vscode.CancellationToken): Promise<void> {
        if (this.disposed) { return; }
        this.viewSubscriptions.splice(0).forEach(subscription => subscription.dispose());
        this.webviewView = view;
        this.ready = false;
        const closed = () => {
            if (this.webviewView === view) {
                this.webviewView = undefined; this.ready = false;
                this.viewSubscriptions.splice(0).forEach(subscription => subscription.dispose());
            }
        };
        this.viewSubscriptions.push(view.onDidDispose(closed));
        let html: string;
        try { html = await this.loadWebviewHtml(view.webview); }
        catch (error) { closed(); throw error; }
        if (this.disposed || this.webviewView !== view) { return; }
        this.viewSubscriptions.push(
            view.onDidChangeVisibility(() => {
                if (view.visible) {
                    this.unread.clear(); this.statusChanged();
                    void this.getMessages().catch(error => console.warn('Overleaf chat refresh failed:', error));
                }
            }),
            view.webview.onDidReceiveMessage(e => {
                if (this.disposed || this.webviewView !== view) { return; }
                switch (e.type) {
                    case 'get-messages':
                        this.ready = true;
                        if (view.visible) { this.unread.clear(); this.statusChanged(); }
                        this.flushInsertions();
                        return this.getMessages();
                    case 'send-message': return this.sendMessage(e.content);
                    case 'show-line-ref': {
                        const { path, L1, C1, L2, C2 } = e.content;
                        return this.showLineRef(path, new vscode.Range(L1, C1, L2, C2));
                    }
                }
            }),
        );
        view.webview.options = { enableScripts: true };
        view.webview.html = html;
    }

    /** Apply socket changes after an older HTTP snapshot, in their observed order. */
    private getMessages(): Promise<void> {
        if (this.disposed) { return Promise.resolve(); }
        if (this.fetching) { return this.fetching; }
        this.duringFetch = [];
        const fetching = (async () => {
            const messages = await this.vfs.getMessages();
            if (this.disposed || messages === undefined) { return; }
            this.apply({ type: 'snapshot', messages });
            for (const change of this.duringFetch) { this.apply(change); }
            this.publish();
        })();
        this.fetching = fetching;
        return fetching.finally(() => {
            if (this.fetching === fetching) { this.fetching = undefined; this.duringFetch = []; }
        });
    }

    private receive(change: ChatChange) {
        if (this.disposed) { return; }
        if (this.fetching) { this.duringFetch.push(change); }
        this.apply(change);
        this.publish();
    }

    private apply(change: ChatChange) {
        if (change.type === 'snapshot') {
            this.messages.clear();
            // The HTTP endpoint's normal 50-message window remains bounded.
            change.messages.slice(0, 50).reverse().forEach(message => this.messages.set(message.id, { ...message }));
        } else if (change.type === 'new') {
            this.messages.set(change.message.id, { ...change.message });
        } else if (change.type === 'delete') {
            this.messages.delete(change.messageId);
        } else {
            const message = this.messages.get(change.messageId);
            if (message) { this.messages.set(message.id, { ...message, content: change.content }); }
        }
        while (this.messages.size > 50) { this.messages.delete(this.messages.keys().next().value!); }
    }

    private publish() {
        const unread = this.unread.size;
        for (const id of this.unread) { if (!this.messages.has(id)) { this.unread.delete(id); } }
        if (unread !== this.unread.size) { this.statusChanged(); }
        if (!this.disposed && this.ready) {
            const content = [...this.messages.values()].reverse().sort((a, b) => b.timestamp - a.timestamp)
                .map(message => ({ ...message, newMessage: this.unread.has(message.id) }));
            void this.webviewView?.webview.postMessage({ type: 'get-messages', content, userId: this.vfs._userId });
        }
    }

    private sendMessage(content: string) {
        return this.vfs.sendMessage(this.publicId, content);
    }

    get hasUnread() { return this.unread.size; }

    revealChatView() {
        if (this.disposed) { return; }
        void vscode.commands.executeCommand(`${ROOT_NAME}.chatWebview.focus`);
        this.unread.clear(); this.statusChanged();
    }

    insertText(text = '') {
        if (this.disposed) { return; }
        this.revealChatView();
        if (text) { this.pendingInsertions.push(text); }
        this.flushInsertions();
    }

    private flushInsertions() {
        if (!this.ready || this.disposed || !this.webviewView) { return; }
        for (const content of this.pendingInsertions.splice(0)) {
            void this.webviewView.webview.postMessage({ type: 'insert-text', content });
        }
    }

    dispose() {
        if (this.disposed) { return; }
        this.disposed = true;
        this.socketSubscription.dispose();
        this.viewSubscriptions.splice(0).forEach(subscription => subscription.dispose());
        this.webviewView = undefined; this.ready = false;
        this.pendingInsertions = []; this.duringFetch = [];
        this.messages.clear(); this.unread.clear();
    }

    private getLineRef() {
        const editor = vscode.window.activeTextEditor;
        if (editor === undefined) { return; }

        const filePath = parseUri(editor.document.uri).pathParts.join('/');
        const start = editor.selection.start, end = editor.selection.end;
        const ref = `[[${filePath}#L${start.line}C${start.character}-L${end.line}C${end.character}]]`;
        return ref;
    }

    private async showLineRef(path:string, range:vscode.Range) {
        const uri = (vscode.workspace.workspaceFolders?.[0]?.uri.scheme===ROOT_NAME) ?
                    this.vfs.pathToUri(path) : await LocalReplicaSCMProvider.pathToUri(path);
        if (uri === undefined) { return; }

        vscode.window.showTextDocument(uri).then(editor => {
            editor.revealRange(range);
            editor.selection = new vscode.Selection(range.start, range.end);
        });
    }

    get triggers(): vscode.Disposable[] {
        return [
            this,
            // register commands
            vscode.commands.registerCommand(`${ROOT_NAME}.collaboration.copyLineRef`, () => {
                const ref = this.getLineRef();
                ref && vscode.env.clipboard.writeText(ref);
            }),
            vscode.commands.registerCommand(`${ROOT_NAME}.collaboration.insertLineRef`, () => {
                const ref = this.getLineRef();
                ref && this.insertText(ref + ' ');
            }),
            // register chat webview
            vscode.window.registerWebviewViewProvider(`${ROOT_NAME}.chatWebview`, this, {webviewOptions:{retainContextWhenHidden:true}}),
        ];
    }
}
