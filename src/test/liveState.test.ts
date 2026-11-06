/* eslint-disable @typescript-eslint/naming-convention -- mirrors VS Code and server event names */
import * as assert from 'assert';
import { loadWithVscode } from './standIn';

class Signal<T = any> {
    listeners = new Set<(value: T) => unknown>();
    event = (listener: (value: T) => unknown) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    async fire(value: T) { await Promise.all([...this.listeners].map(listener => listener(value))); }
    dispose() { this.listeners.clear(); }
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}

class Uri {
    scheme = 'overleaf-workshop'; authority = 'example.test';
    constructor(readonly path = '/Book/main.tex', readonly query = 'user=u1&project=p1') {}
    with(change: { path?: string }) { return new Uri(change.path ?? this.path, this.query); }
    toString() { return `${this.scheme}://${this.authority}${this.path}?${this.query}`; }
    static parse(text: string) { return text.startsWith('command:') ? { toString: () => text } : new Uri(text); }
    static joinPath(base: Uri, ...paths: string[]) { return base.with({ path: [base.path, ...paths].join('/').replace(/\/+/g, '/') }); }
}

class Position { constructor(readonly line: number, readonly character: number) {} translate(line: number, character: number) { return new Position(this.line + line, this.character + character); } }
class Range {
    start: Position; end: Position;
    constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
        this.start = typeof a === 'number' ? new Position(a, b as number) : a;
        this.end = typeof a === 'number' ? new Position(c!, d!) : b as Position;
    }
    intersection() { return undefined; }
}

function world() {
    const events = {
        open: new Signal(), close: new Signal(), change: new Signal(), save: new Signal(), focus: new Signal(), active: new Signal(),
        selection: new Signal(), visible: new Signal(), viewVisible: new Signal(), files: new Signal(), configuration: new Signal(),
    };
    const status = { shows: 0, disposed: false, show() { this.shows++; }, dispose() { this.disposed = true; } };
    const diagnostics = new Map<string, any[]>();
    const decorations: { disposed: boolean; dispose(): void }[] = [];
    const collection = { get: (uri: Uri) => diagnostics.get(uri.toString()), set: (uri: Uri, value: any[]) => diagnostics.set(uri.toString(), value),
        delete: (uri: Uri) => diagnostics.delete(uri.toString()), clear: () => diagnostics.clear(), dispose: () => diagnostics.clear() };
    const commands = new Map<string, (...args: any[]) => unknown>();
    const tree = { visible: false, description: undefined, disposed: false, onDidChangeVisibility: events.viewVisible.event, dispose() { this.disposed = true; } };
    const documents: any[] = [];
    const replicaPaths = {resolve: async (_path: string): Promise<Uri | undefined> => undefined};
    const vscode = {
        Uri, Position, Range, Selection: Range, TreeItem: class {}, ThemeIcon: class {}, ThemeColor: class {},
        Disposable: class { constructor(private f: () => void) {} dispose() { this.f(); } }, EventEmitter: Signal,
        MarkdownString: class { appendMarkdown() { return this; } }, TreeItemCollapsibleState: { None: 0 },
        StatusBarAlignment: { Left: 1 }, FileType: { File: 1, Directory: 2 }, DecorationRangeBehavior: { OpenClosed: 0 },
        CompletionItemKind: { Method: 0 }, CompletionItem: class { constructor(public label: string) {} },
        SnippetString: class { constructor(public value: string) {} }, TextEdit: { delete: () => ({}) }, QuickPickItemKind: { Separator: 0 },
        DiagnosticSeverity: { Information: 1 }, Diagnostic: class { constructor(public range: Range, public message: string, public severity: number) {} },
        CodeActionKind: { QuickFix: 'quickfix' }, CodeAction: class { constructor(public title: string, public kind: string) {} }, WorkspaceEdit: class { replace() {} },
        l10n: { t: (message: string) => message },
        window: { state: { focused: true }, activeTextEditor: undefined, visibleTextEditors: [],
            createStatusBarItem: () => status, createTreeView: () => tree,
            onDidChangeWindowState: events.focus.event, onDidChangeActiveTextEditor: events.active.event,
            onDidChangeTextEditorSelection: events.selection.event, onDidChangeVisibleTextEditors: events.visible.event,
            registerWebviewViewProvider: () => ({ dispose() {} }), createTextEditorDecorationType: () => {
                const decoration = { disposed: false, dispose() { this.disposed = true; } };
                decorations.push(decoration); return decoration;
            },
        },
        languages: { createDiagnosticCollection: () => collection, registerCompletionItemProvider: () => ({ dispose() {} }), registerCodeActionsProvider: () => ({ dispose() {} }) },
        commands: { registerCommand: (name: string, fn: (...args: any[]) => unknown) => { commands.set(name, fn); return { dispose: () => commands.delete(name) }; }, executeCommand: async () => undefined },
        workspace: { workspaceFolders: [{ uri: new Uri('/Book') }], textDocuments: documents,
            getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
            onDidChangeConfiguration: events.configuration.event,
            fs: { readFile: async () => Buffer.from('[]') }, onDidOpenTextDocument: events.open.event, onDidCloseTextDocument: events.close.event,
            onDidChangeTextDocument: events.change.event, onDidSaveTextDocument: events.save.event,
            registerTextDocumentContentProvider: () => ({ dispose() {} }), openTextDocument: async (uri: Uri) => documents.find(doc => doc.uri.toString() === uri.toString()),
        },
    };
    const registrations = new Set<any>();
    const connected = deferred<any[]>();
    const socket = { updateEventHandlers(handlers: any) { registrations.add(handlers); return { dispose: () => registrations.delete(handlers) }; },
        getConnectedUsers: () => connected.promise, unSyncFileChanges: 0, isUsingAlternativeConnectionScheme: false };
    const vfs: any = { origin: new Uri('/Book'), projectId: 'p1', _userId: 'u1', onDidChangeFiles: events.files.event,
        _resolveById: () => undefined, pathToUri: (path = '') => new Uri('/Book/' + path), getUpdates: async () => ({ updates: [] }),
        getMessages: async () => [], metadata: async () => ({}), list: async () => [], getDictionary: () => [], getSpellCheckLanguage: () => ({code:'en'}),
        spellCheck: async (_uri: Uri, words: string[]) => words.map((_word, index) => ({index, suggestions: ['correct']})),
        openFile: async () => new Uint8Array(), refreshSettings: async () => {},
    };
    const modules = loadWithVscode(vscode, () => ({
        ClientManager: require('../collaboration/clientManager').ClientManager,
        HistoryViewProvider: require('../scm/historyViewProvider').HistoryViewProvider,
        ChatViewProvider: require('../collaboration/chatViewProvider').ChatViewProvider,
        CommandCompletionProvider: require('../intellisense/langCompletionProvider').CommandCompletionProvider,
        MisspellingCheckProvider: require('../intellisense/langMisspellingCheckProvider').MisspellingCheckProvider,
        EventBus: require('../utils/eventBus').EventBus,
        SocketIOAlt: require('../api/socketioAlt').SocketIOAlt,
        GlobalStateManager: require('../utils/globalStateManager').GlobalStateManager,
        CompileManager: require('../compile/compileManager').CompileManager,
    }), { '../scm/localReplicaSCM': { LocalReplicaSCMProvider: { pathToUri: (path:string) => replicaPaths.resolve(path) } } });
    const vfsm = { prefetch: async () => vfs };
    function document(uri = new Uri(), text = 'mistake') {
        const doc = { uri, version: 1, languageId: 'latex', lineCount: 1, getText: () => text, lineAt: () => ({text}), validateRange: (range: Range) => range };
        documents.push(doc); return doc;
    }
    return { ...modules, vscode, vfs, vfsm, socket, registrations, connected, events, status, tree, diagnostics, decorations, document, replicaPaths };
}

async function withTimers(run: (timers: Map<object, () => void>) => Promise<void>) {
    const timers = new Map<object, () => void>();
    const original = { setTimeout, clearTimeout, setInterval, clearInterval };
    const set = (callback: () => void) => { const id = { unref() {} }; timers.set(id, callback); return id; };
    (globalThis as any).setTimeout = set; (globalThis as any).setInterval = set;
    (globalThis as any).clearTimeout = (id: object) => timers.delete(id); (globalThis as any).clearInterval = (id: object) => timers.delete(id);
    try { await run(timers); } finally { Object.assign(globalThis, original); }
}

describe('live project state owners', () => {
    it('keeps the chosen project through compiler and main-document pickers', async () => {
        for (const method of ['setCompiler','setRootDoc']) {
            const f = world(); const chosen = new Uri('/Book'); let current = chosen;
            f.CompileManager.check = async () => current;
            const shown = deferred<void>(); const answer = deferred<any>(); const compiled = deferred<unknown[]>();
            (f.vscode.window as any).showQuickPick = () => { shown.resolve(); return answer.promise; };
            Object.assign(f.vfs,{getCompiler:()=>({code:'old'}),getAllCompilers:()=>[{code:'new',name:'New'}],
                getRootDocName:()=>'/main.tex',getValidMainDocs:()=>[{path:'/new.tex',entity:{_id:'new'}}],updateSettings:async()=>true});
            const manager = {vfsm:f.vfsm,compile:(...args:unknown[])=>{compiled.resolve(args);}};
            await f.CompileManager.prototype[method].call(manager);
            await shown.promise; current = new Uri('/Other','user=u1&project=p2');
            answer.resolve(method === 'setCompiler' ? {description:'new'} : {id:'new'});
            assert.strictEqual((await compiled.promise)[2],chosen);
        }
    });
    it('keeps the settings-menu project through its second picker and scratch compile', async () => {
        for (const label of ['Setting: Compiler','Setting: Main Document','Recompile from Scratch']) {
            const f = world(); const chosen = new Uri('/Book'); let current = chosen;
            f.CompileManager.check = async (uri?:Uri) => uri ?? current;
            const shown = deferred<void>(), answer = deferred<any>(), compiled = deferred<unknown[]>(); let picks = 0;
            (f.vscode.window as any).showQuickPick = (items:any[]) => {
                if (++picks === 1) { shown.resolve(); return answer.promise; }
                return Promise.resolve(items[0]);
            };
            Object.assign(f.vfs,{getCompiler:()=>({code:'old'}),getAllCompilers:()=>[{code:'new',name:'New'}],
                getRootDocName:()=>'/main.tex',getValidMainDocs:()=>[{path:'/new.tex',entity:{_id:'new'}}],updateSettings:async()=>true});
            const manager = Object.assign(Object.create(f.CompileManager.prototype), {
                vfsm:f.vfsm,compile:(...args:unknown[])=>{compiled.resolve(args);},
            });
            const pending = manager.compileSettings();
            await shown.promise; current = new Uri('/Other','user=u1&project=p2'); answer.resolve({label});
            await pending;
            assert.strictEqual((await compiled.promise)[2],chosen);
        }
    });

    it('keeps the newest project list and current replica registration when HTTP responses arrive out of order', async () => {
        const f = world(); const older = deferred<any>(); const newer = deferred<any>(); let calls = 0;
        let state:any = {'example.test':{name:'example.test',url:'https://example.test/',login:{userId:'u1',username:'u1',identity:{cookies:'test',csrfToken:'test'},projects:[{id:'p1',name:'Old',scm:{replica:{enabled:true}}}]}}};
        const context = {globalState:{get:()=>structuredClone(state),update:async (_key:string,value:any)=>{state=structuredClone(value);}}};
        const api = {getProjectsJson:()=>++calls === 1 ? older.promise : newer.promise};
        const first = f.GlobalStateManager.fetchServerProjects(context,api,'example.test');
        const second = f.GlobalStateManager.fetchServerProjects(context,api,'example.test');
        state['example.test'].login.projects[0].scm = {replica:{enabled:false}};
        newer.resolve({type:'success',projects:[{id:'p1',name:'Latest'}]}); await second;
        older.resolve({type:'success',projects:[{id:'p1',name:'Obsolete'}]});
        assert.strictEqual((await first)[0].name,'Latest');
        assert.strictEqual(state['example.test'].login.projects[0].name,'Latest');
        assert.deepStrictEqual(state['example.test'].login.projects[0].scm,{replica:{enabled:false}});
    });

    it('does not restore an account after a project-list response crosses logout or replacement login', async () => {
        for (const replacement of [undefined,{userId:'u2',username:'u2',identity:{cookies:'other',csrfToken:'other'},projects:[]}]) {
            const f = world(); const response = deferred<any>();
            let state:any = {'example.test':{name:'example.test',url:'https://example.test/',login:{userId:'u1',username:'u1',identity:{cookies:'test',csrfToken:'test'}}}};
            const context = {globalState:{get:()=>structuredClone(state),update:async (_key:string,value:any)=>{state=structuredClone(value);}}};
            const pending = f.GlobalStateManager.fetchServerProjects(context,{getProjectsJson:()=>response.promise},'example.test');
            state['example.test'].login = replacement;
            response.resolve({type:'success',projects:[{id:'p1',name:'Old account project'}]});
            assert.deepStrictEqual(await pending,[]);
            assert.deepStrictEqual(state['example.test'].login,replacement);
        }
    });

    it('releases collaboration timers and subscribers before a late user-list response', async () => withTimers(async timers => {
        const f = world(); const manager = new f.ClientManager(f.vfs, { extensionUri: new Uri('/extension') }, 'self', f.socket);
        const subscriptions = manager.triggers;
        manager.setStatusActive('other');
        const late = [...timers.values()];
        subscriptions.forEach((s: any) => s.dispose());
        const shows = f.status.shows;
        f.connected.resolve([{client_id:'other',user_id:'u2',first_name:'Other',email:'',last_updated_at:'0'}]);
        await f.connected.promise; await Promise.resolve();
        late.forEach(callback => callback());
        assert.strictEqual(timers.size, 0, 'disposed timer callbacks cannot restart a status loop');
        assert.strictEqual(f.registrations.size, 0, 'rejoin cannot retain the former client and chat listeners');
        assert.strictEqual(f.status.shows, shows, 'the late response cannot paint disposed status');
    }));

    it('does not retain a history refresh timer while hidden or after disposal', async () => withTimers(async timers => {
        const f = world(); const history = new f.HistoryViewProvider(f.vfs); const subscriptions = history.triggers;
        await Promise.resolve();
        assert.strictEqual(timers.size, 0, 'a hidden history view has no relative-time repaint loop');
        f.tree.visible = true; await f.events.viewVisible.fire({visible:true});
        assert.strictEqual(timers.size, 1);
        const late = [...timers.values()]; subscriptions.forEach((s: any) => s.dispose()); late.forEach(callback => callback());
        assert.strictEqual(timers.size, 0); assert.strictEqual(f.tree.disposed, true);
    }));

    for (const kind of ['files', 'joined']) {
        it(`reloads the selected visible history after a ${kind} event`, async () => withTimers(async () => {
            const f = world(), fresh = deferred<any>(); let requests = 0;
            const updates = (version: number) => ({ updates: [{ fromV: version - 1, toV: version,
                meta: { end_ts: Date.now(), users: [] }, labels: [], pathnames: ['chapter.tex'], project_ops: [] }] });
            f.vfs.getUpdates = () => ++requests === 1 ? Promise.resolve(updates(1)) : fresh.promise;
            const history = new f.HistoryViewProvider(f.vfs), subscriptions = history.triggers;
            const data = history.treeDataProvider, painted = deferred<void>();
            try {
                f.tree.visible = true; await f.events.viewVisible.fire({visible:true});
                await history.updateView(['chapter.tex']);
                assert.deepStrictEqual((await data.getChildren()).map((item:any) => item.version), [1]);
                const subscription = data.onDidChangeTreeData(() => painted.resolve()); subscriptions.push(subscription);
                f.EventBus.fire('projectStateChangedEvent', {uri:new Uri('/Other', 'user=u1&project=p2'), kind});
                assert.strictEqual(requests, 1, 'another project cannot reload this history');
                f.EventBus.fire('projectStateChangedEvent', {uri:f.vfs.origin, kind});
                assert.strictEqual(requests, 2, 'the visible invalidation must start a current history request');
                fresh.resolve(updates(2)); await painted.promise;
                assert.deepStrictEqual((await data.getChildren()).map((item:any) => item.version), [2]);
                assert.strictEqual(f.tree.description, 'chapter.tex', 'the active history filter remains selected');
            } finally { fresh.resolve(updates(2)); subscriptions.forEach((subscription:any) => subscription.dispose()); }
        }));
    }

    it('defers hidden history invalidation until shown and ignores a response after disposal', async () => withTimers(async timers => {
        const f = world(), response = deferred<any>(); let requests = 0, paints = 0;
        f.vfs.getUpdates = () => { requests++; return response.promise; };
        const history = new f.HistoryViewProvider(f.vfs), subscriptions = history.triggers;
        subscriptions.push(history.treeDataProvider.onDidChangeTreeData(() => { paints++; }));
        let showing: Promise<unknown> | undefined;
        try {
            f.EventBus.fire('projectStateChangedEvent', {uri:f.vfs.origin, kind:'files'});
            f.EventBus.fire('projectStateChangedEvent', {uri:f.vfs.origin, kind:'joined'});
            assert.strictEqual(requests, 0); assert.strictEqual(timers.size, 0);
            f.tree.visible = true; showing = f.events.viewVisible.fire({visible:true});
            assert.strictEqual(requests, 1, 'showing the invalidated view fetches once');
            subscriptions.forEach((subscription:any) => subscription.dispose());
            response.resolve({updates:[]}); await showing;
            assert.strictEqual(paints, 0, 'the disposed history cannot repaint after its request completes');
            assert.strictEqual(timers.size, 0);
        } finally {
            response.resolve({updates:[]}); await showing;
            subscriptions.forEach((subscription:any) => subscription.dispose());
        }
    }));

    it('keeps a newer cursor and its decoration when the initial user snapshot arrives', async () => withTimers(async () => {
        const f = world(); f.vfs._resolveById = (id:string) => ({path:'/' + id,fileEntity:{_id:id}});
        const manager = new f.ClientManager(f.vfs, {extensionUri:new Uri('/extension')}, 'self', f.socket);
        const handlers = [...f.registrations].find(registration => registration.onClientUpdated);
        try {
            handlers.onClientUpdated({id:'other',user_id:'u2',name:'Current',email:'',doc_id:'new',row:8,column:3});
            const user = manager.onlineUsers.other, selection = user.selection;
            f.connected.resolve([
                {client_id:'other',user_id:'u2',first_name:'Old',email:'',cursorData:{doc_id:'old',row:1,column:0},last_updated_at:'1'},
                {client_id:'untouched',user_id:'u3',first_name:'Untouched',email:'',cursorData:{doc_id:'chapter',row:4,column:2},last_updated_at:'1'},
            ]);
            await f.connected.promise;
            assert.strictEqual(manager.onlineUsers.other, user, 'the snapshot must keep the current client record');
            assert.strictEqual(user.selection, selection, 'the existing decoration stays owned by that record');
            assert.strictEqual(user.doc_id, 'new'); assert.strictEqual(selection.ranges[0].range.start.line, 8);
            assert.strictEqual(manager.onlineUsers.untouched.row, 4, 'an unchanged client is still admitted from the snapshot');
            assert.strictEqual(f.decorations.length, 2);
        } finally { manager.dispose(); }
        assert.ok(f.decorations.every(decoration => decoration.disposed), 'all created decorations are released');
    }));

    for (const hadPosition of [false, true]) {
        it(`keeps a ${hadPosition ? 'displayed' : 'not-yet-listed'} collaborator disconnected after the initial snapshot`, async () => withTimers(async () => {
            const f = world(); f.vfs._resolveById = (id:string) => ({path:'/' + id,fileEntity:{_id:id}});
            const manager = new f.ClientManager(f.vfs, {extensionUri:new Uri('/extension')}, 'self', f.socket);
            const handlers = [...f.registrations].find(registration => registration.onClientUpdated);
            try {
                if (hadPosition) { handlers.onClientUpdated({id:'other',user_id:'u2',name:'Other',email:'',doc_id:'chapter',row:2,column:0}); }
                handlers.onClientDisconnected('other');
                assert.ok(f.decorations.every(decoration => decoration.disposed));
                f.connected.resolve([{client_id:'other',user_id:'u2',first_name:'Other',email:'',cursorData:{doc_id:'chapter',row:1,column:0},last_updated_at:'1'}]);
                await f.connected.promise;
                assert.strictEqual(manager.onlineUsers.other, undefined, 'the older list cannot recreate the disconnected client');
                assert.strictEqual(f.decorations.length, hadPosition ? 1 : 0, 'the snapshot cannot create a replacement decoration');
            } finally { manager.dispose(); }
        }));
    }

    it('replays chat edits and deletions over a pending HTTP snapshot without duplicate messages', async () => {
        const f = world(); const fetch = deferred<any[]>(); f.vfs.getMessages = () => fetch.promise;
        const chat = new f.ChatViewProvider(f.vfs, 'self', new Uri('/extension'), f.socket);
        const posted: any[] = []; const receive = new Signal(); const visible = new Signal(); const disposed = new Signal();
        chat.loadWebviewHtml = async () => '<html></html>';
        const view = { visible:false, onDidChangeVisibility:visible.event, onDidDispose:disposed.event,
            webview:{options:{},html:'',postMessage:async (message:any)=>{posted.push(message);return true;},onDidReceiveMessage:receive.event} };
        await chat.resolveWebviewView(view, {}, {});
        const pending = receive.fire({type:'get-messages'});
        const message = (id:string, content:string) => ({id,content,user_id:'u2',user:{id:'u2',first_name:'Other',email:''},timestamp:1,clientId:'remote'});
        for (const handlers of f.registrations) {
            handlers.onMessageEdited?.({messageId:'m1',userId:'u2',content:'edited'});
            handlers.onMessageDeleted?.({messageId:'m2',userId:'u2'});
            handlers.onReceivedMessage?.(message('m3','new'));
        }
        fetch.resolve([message('m2','deleted'),message('m1','old')]); await pending; await Promise.resolve();
        const snapshot = posted.filter(item => item.type === 'get-messages').at(-1);
        assert.deepStrictEqual(snapshot.content.map((item:any)=>[item.id,item.content]), [['m3','new'],['m1','edited']]);
        assert.strictEqual(chat.hasUnread, 1, 'replaying an old HTTP snapshot retains a new unread socket message');
        for (const handlers of f.registrations) { handlers.onMessagesRefreshed?.([]); }
        assert.strictEqual(chat.hasUnread, 0, 'a reconciled deletion removes the unread count too');
        chat.dispose();
        assert.strictEqual(f.registrations.size, 0); assert.strictEqual(receive.listeners.size, 0);
    });

    it('does not install a chat page after its view closes during the HTML read', async () => {
        const f = world(); const html = deferred<string>(); const started = deferred<void>();
        const chat = new f.ChatViewProvider(f.vfs, 'self', new Uri('/extension'), f.socket);
        chat.loadWebviewHtml = () => { started.resolve(); return html.promise; };
        const closed = new Signal(), visible = new Signal(), receive = new Signal(); let assigned = 0;
        const view = {visible:false,onDidDispose:closed.event,onDidChangeVisibility:visible.event,
            webview:{options:{},set html(_value:string){assigned++;},onDidReceiveMessage:receive.event}};
        const resolving = chat.resolveWebviewView(view, {}, {});
        try {
            await started.promise; await closed.fire(undefined);
            html.resolve('<html></html>'); await resolving;
            assert.strictEqual(assigned,0);
            assert.strictEqual(receive.listeners.size,0);
            assert.strictEqual(visible.listeners.size,0);
            assert.strictEqual(closed.listeners.size,0);
        } finally { html.resolve(''); await resolving; chat.dispose(); }
    });

    it('queues chat insertion for webview readiness without an unbounded timer', async () => withTimers(async timers => {
        const f = world(); const chat = new f.ChatViewProvider(f.vfs, 'self', new Uri('/extension'), f.socket);
        chat.insertText('reference'); assert.strictEqual(timers.size, 0);
        chat.dispose(); assert.strictEqual(f.registrations.size, 0);
    }));

    it('ignores a former cursor lookup when the same client returns with a new position', async () => withTimers(async () => {
        const f = world(); const local = new Uri('/local'); local.scheme = 'file'; f.vscode.workspace.workspaceFolders = [{uri:local}];
        f.vfs._resolveById = (id:string) => ({path:'/' + id,fileEntity:{_id:id}});
        const oldPath = deferred<Uri>(); let requests = 0;
        f.replicaPaths.resolve = async path => ++requests === 1 ? oldPath.promise : new Uri('/Book' + path);
        const manager = new f.ClientManager(f.vfs,{extensionUri:new Uri('/extension')},'self',f.socket);
        const details = {id:'other',user_id:'u2',name:'Other',email:'',doc_id:'old',row:1,column:0};
        try {
            const before = manager.updatePosition('other','old',1,0,details);
            manager.removePosition('other');
            await manager.updatePosition('other','new',8,0,{...details,doc_id:'new',row:8});
            oldPath.resolve(new Uri('/Book/old')); await before;
            assert.strictEqual(manager.onlineUsers.other.selection.ranges[0].range.start.line,8);
        } finally { manager.dispose(); }
    }));

    it('reloads package metadata after an external metadata event and ignores an obsolete in-flight result', async () => {
        const f = world(); const provider = new f.CommandCompletionProvider(f.vfsm, new Uri('/extension')); const subscriptions = provider.triggers;
        const uri = new Uri(); const first = deferred<any>(); const started = deferred<void>(); let reads = 0;
        const metadata = (name:string) => ({doc1:{packages:{pkg:[{caption:name,snippet:name,meta:'pkg',score:1}]}}});
        f.vfs.metadata = () => { started.resolve(); return ++reads === 1 ? first.promise : Promise.resolve(metadata('fresh')); };
        const pending = provider.getCompletionItems(uri, '', new Range(0,0,0,1));
        await started.promise;
        f.EventBus.fire('projectStateChangedEvent', {uri,kind:'metadata'});
        first.resolve(metadata('obsolete'));
        const items = await pending;
        assert.deepStrictEqual(items.map((item:any)=>item.label), ['fresh']);
        assert.strictEqual(reads, 2);
        subscriptions.forEach((s:any)=>s.dispose());
    });

    it('cannot publish an old spelling response after closing and reopening the same document', async () => {
        const f = world(); const response = deferred<any[]>(); const started = deferred<void>(); let calls = 0;
        f.vfs.spellCheck = () => { started.resolve(); return ++calls === 1 ? response.promise : Promise.resolve([]); };
        const provider = new f.MisspellingCheckProvider(f.vfsm, new Uri('/extension'));
        const subscriptions = provider.triggers, oldDocument = f.document(new Uri(), 'oldtypo');
        const pending = provider.updateDocument(oldDocument);
        try {
            await started.promise; await f.events.close.fire(oldDocument);
            f.vscode.workspace.textDocuments.splice(0,1);
            const current = f.document(new Uri(),'correctword');
            await provider.updateDocument(current);
            response.resolve([{index:0,suggestions:['old correction']}]); await pending;
            assert.deepStrictEqual(f.diagnostics.get(current.uri.toString()),[]);
        } finally {
            response.resolve([]); await pending;
            subscriptions.forEach((subscription:any)=>subscription.dispose());
        }
    });

    it('invalidates both learned and suggestion caches after an external dictionary refresh', async () => {
        const f = world(); const provider = new f.MisspellingCheckProvider(f.vfsm); const subscriptions = provider.triggers;
        let dictionary = ['mistake']; let requests = 0;
        f.vfs.getDictionary = () => dictionary;
        f.vfs.spellCheck = async () => { requests++; return [{index:0,suggestions:['correct']}]; };
        const doc = f.document(); await f.events.open.fire(doc);
        assert.strictEqual(requests, 0);
        dictionary = []; f.EventBus.fire('projectStateChangedEvent', {uri:doc.uri,kind:'dictionary'});
        await f.events.open.fire(doc);
        assert.ok(requests > 0, 'an externally unlearned word must be checked again');
        assert.strictEqual(f.diagnostics.get(doc.uri.toString())?.[0]?.code, 'mistake');
        subscriptions.forEach((s:any)=>s.dispose());
    });

    it('checks every inserted line when an external multi-line edit changes the document', async () => {
        const f = world(); const provider = new f.MisspellingCheckProvider(f.vfsm); const subscriptions = provider.triggers;
        const words: string[] = [];
        f.vfs.spellCheck = async (_uri:Uri, requested:string[]) => { words.push(...requested); return []; };
        const lines = ['first','second','third']; const doc = {...f.document(),lineCount:3,getText:()=>lines.join('\n'),lineAt:(line:number)=>({text:lines[line]})};
        try {
            await f.events.change.fire({document:doc,contentChanges:[{range:new Range(0,0,0,0),text:'\nsecond\nthird'}]});
            assert.ok(words.includes('third'));
        } finally { subscriptions.forEach((s:any)=>s.dispose()); }
    });

    it('stops the alternative connection before late initial and refresh responses can rearm it', async () => withTimers(async timers => {
        const f = world(); const messages = deferred<any>(); const version = deferred<number>(); const record = deferred<any>();
        f.vfs.getCurrentVersion = () => version.promise;
        f.vscode.commands.executeCommand = async () => f.vfs;
        const connection = new f.SocketIOAlt('overleaf-workshop://example.test/Book?user=u1&project=p1',
            {getMessages: () => messages.promise}, {}, 'p1', record.promise);
        const received: string[] = [];
        connection.on('joinProjectResponse', () => received.push('joined'));
        connection.on('chat-messages-refreshed', () => received.push('messages'));
        const initial = [...timers.values()];
        connection.disconnect();
        record.resolve({_id:'p1'}); messages.resolve({messages:[]}); version.resolve(1);
        await Promise.all(initial.map(callback => callback()));
        await Promise.all([messages.promise,version.promise]); await Promise.resolve();
        assert.deepStrictEqual(received, []);
        assert.strictEqual(timers.size, 0, 'a completed in-flight refresh must not schedule after disconnect');
        assert.strictEqual(f.events.configuration.listeners.size, 0);
    }));

    it('reconciles an empty alternative chat snapshot in one bounded request', async () => withTimers(async () => {
        const f = world(); f.vfs.getCurrentVersion = async () => 1; f.vscode.commands.executeCommand = async () => f.vfs;
        let requests = 0;
        const connection = new f.SocketIOAlt('overleaf-workshop://example.test/Book?user=u1&project=p1', {
            getMessages: async () => {
                requests++;
                if (requests > 2) { throw new Error('chat history request repeated after an empty result'); }
                return {messages: requests === 1 ? [{id:'removed',timestamp:1}] : []};
            },
        }, {}, 'p1', Promise.resolve({_id:'p1'}));
        const snapshots: any[] = [];
        connection.on('chat-messages-refreshed', (messages:any) => snapshots.push(messages));
        try {
            await Promise.resolve(); await Promise.resolve();
            await connection.refreshMessages();
            assert.strictEqual(requests, 2);
            assert.deepStrictEqual(snapshots.at(-1), []);
        } finally { connection.disconnect(); }
    }));
});
