import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { OUTPUT_FOLDER_NAME, ROOT_NAME } from '../consts';
import { EventBus } from '../utils/eventBus';
import { GlobalStateManager } from '../utils/globalStateManager';
import { parseUri } from './remoteFileSystemProvider';
import type { VirtualFileSystem } from './remoteFileSystemProvider';
import { outputsOf, PdfFetchBridge, PieceCache } from './pdfFetchBridge';
import { completeViewerPage, isBuildPath } from './pdfViewerPages';
import { DEFAULT_PDF_VIEWER_ENGINE, HostMessage, isPdfViewerEngine, pdfjsReleaseOf, PdfOutput, PdfViewerEngine, ViewerMessage } from './viewerProtocol';

export class PdfDocument implements vscode.CustomDocument {
    /** the PDF read whole: a PDF that is not the project's build, or a build that the download domain does not serve */
    cache: Uint8Array = new Uint8Array(0);
    /** for the build's output.pdf: the build in use, which the viewers load in ranges */
    output?: PdfOutput;
    /** for the build's output.pdf: the project, whose build in use this document shows */
    vfs?: VirtualFileSystem;
    /** the build that the document shows */
    private shownBuild?: string;
    /** counts the reads of builds, so that only the last one's content is shown */
    private reads = 0;
    private stopFollowing?: () => void;

    private readonly _onDidChange = new vscode.EventEmitter<{}>();
    readonly onDidChange = this._onDidChange.event;

    /** `engine`: the viewer that shows this document (setting overleaf-workshop.pdfViewer.engine) */
    constructor(readonly uri: vscode.Uri, private _engine: PdfViewerEngine = DEFAULT_PDF_VIEWER_ENGINE) {
        this.uri = uri;
    }

    get engine(): PdfViewerEngine {
        return this._engine;
    }

    /** Show this document in the other viewer; false when it is the viewer already. Both load the document the same way. */
    async setEngine(engine: PdfViewerEngine): Promise<boolean> {
        if (engine === this._engine) {
            return false;
        }
        this._engine = engine;
        return true;
    }

    /**
     * A user-level editor association such as `"*.pdf": "overleaf-workshop.pdfViewer"`
     * routes local PDFs here as well, bypassing the `overleaf-workshop:` selector (#378).
     */
    get isProjectFile(): boolean {
        return this.uri.scheme === ROOT_NAME;
    }

    /** whether this is the project's build, the output.pdf in the output folder */
    get isBuild(): boolean {
        return this.isProjectFile && isBuildPath(parseUri(this.uri).pathParts, OUTPUT_FOLDER_NAME);
    }

    dispose() {
        this.stopFollowing?.();
        this._onDidChange.dispose();
    }

    /**
     * Read the document. The project's build shows the project's build in use, and follows it
     * when it changes (ProjectBuilds), from this window's compiles and from other clients'. The
     * viewers load a build in ranges, as Overleaf's viewer does, so they need only its address.
     * Any other PDF is read whole; a failed read throws.
     */
    async refresh(): Promise<Uint8Array> {
        if (this.isBuild) {
            if (!this.vfs) {
                this.vfs = await vscode.commands.executeCommand<VirtualFileSystem>('remoteFileSystem.prefetch', this.uri);
                this.stopFollowing = this.vfs.builds.onDidChangeBuild(() => {
                    this.showBuild().catch((error) => {
                        vscode.window.showErrorMessage(vscode.l10n.t('The PDF could not be read: {0}', String(error?.message ?? error)));
                    });
                });
            }
            await this.showBuild();
            return this.cache;
        }
        this.cache = new Uint8Array(await vscode.workspace.fs.readFile(this.uri));
        this._onDidChange.fire({content:this.cache});
        return this.cache;
    }

    /**
     * Show the build in use, unless it is shown already. A build that the download domain does not
     * serve, as without one on a server of one's own, is read whole. Without a build, the viewers
     * show the project's build status (ProjectBuilds.status).
     */
    private async showBuild() {
        const build = this.vfs?.builds.build;
        if (build?.id === this.shownBuild) { return; }
        this.shownBuild = build?.id;
        const read = ++this.reads;
        const output = this.vfs?.pdfOutput();
        this.output = output;
        this.cache = new Uint8Array();
        if (output) {
            this._onDidChange.fire({output});
        } else if (build) {
            const content = new Uint8Array(await vscode.workspace.fs.readFile(this.uri));
            if (read !== this.reads) { return; }
            this.cache = content;
            this._onDidChange.fire({content});
        }
    }
}

export class PdfViewEditorProvider implements vscode.CustomEditorProvider<PdfDocument> {
    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PdfDocument>>();
    readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    /** the pieces of compiled PDFs kept between builds and sessions (src/core/pdfFetchBridge.ts) */
    private readonly pieces: PieceCache;
    /** the open viewers, which a change of overleaf-workshop.pdfViewer.engine reloads */
    private readonly editors = new Set<{ doc: PdfDocument, panel: vscode.WebviewPanel, render: () => Promise<void> }>();
    /** the folder of pdf.js's release in views/pdf-viewer/, from the extension's package.json */
    private readonly pdfjsRelease: string;

    constructor(private readonly context:vscode.ExtensionContext) {
        this.context = context;
        this.pdfjsRelease = pdfjsReleaseOf(context.extension.packageJSON);
        const sizeMB = vscode.workspace.getConfiguration('overleaf-workshop.pdfViewer').get<number>('pieceCacheSizeMB', 1024);
        this.pieces = new PieceCache(path.join(context.globalStorageUri.fsPath, 'pdf-pieces'), Math.max(0, sizeMB) * 1024 * 1024);
        // the folder where the PDF viewer of earlier versions (pdf.js 3.10.111's) downloaded the
        // builds it showed, one book-sized file per project
        void Promise.resolve(vscode.workspace.fs.delete(vscode.Uri.joinPath(context.globalStorageUri, 'legacy-viewer-builds'), { recursive: true, useTrash: false })).catch(() => {});
    }


    public saveCustomDocument(document: PdfDocument, cancellation: vscode.CancellationToken): Thenable<void> {
        return Promise.resolve();
    }
    public saveCustomDocumentAs(document: PdfDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Thenable<void> {
        return Promise.resolve();
    }
    public revertCustomDocument(document: PdfDocument, cancellation: vscode.CancellationToken): Thenable<void> {
        return Promise.resolve();
    }
    public backupCustomDocument(document: PdfDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Thenable<vscode.CustomDocumentBackup> {
        return Promise.resolve({id: '', delete: () => {}});
    }

    public async openCustomDocument(uri: vscode.Uri): Promise<PdfDocument> {
        const doc = new PdfDocument(uri, this.engine());
        await doc.refresh();
        return doc;
    }

    /**
     * The viewer that the setting overleaf-workshop.pdfViewer.engine picks; the default for a value
     * the setting no longer has, such as an earlier version's 'legacy'.
     */
    private engine(): PdfViewerEngine {
        const picked = vscode.workspace.getConfiguration('overleaf-workshop.pdfViewer').get<string>('engine', DEFAULT_PDF_VIEWER_ENGINE);
        return isPdfViewerEngine(picked) ? picked : DEFAULT_PDF_VIEWER_ENGINE;
    }

    private viewerFile(...parts: string[]) {
        return vscode.Uri.joinPath(this.context.extensionUri, 'views/pdf-viewer', ...parts);
    }

    /** Show the open PDFs in the viewer that the setting now picks; their pages reload. */
    private async applyEngine() {
        const engine = this.engine();
        for (const editor of this.editors) {
            if (await editor.doc.setEngine(engine)) {
                await editor.render();
            }
        }
    }

    /**
     * The button in the pdfjs and overleaf viewers that shows the PDF in the other one: it sets
     * the setting, whose change reloads the open viewers (applyEngine). The setting is machine
     * scoped, so it is a user setting.
     */
    private async switchViewer(engine: unknown) {
        if (!isPdfViewerEngine(engine)) {
            return;
        }
        try {
            await vscode.workspace.getConfiguration('overleaf-workshop.pdfViewer').update('engine', engine, vscode.ConfigurationTarget.Global);
        } catch (error: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('Could not switch the PDF viewer: {0}', String(error?.message ?? error)));
        }
    }

    public async resolveCustomEditor(doc: PdfDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
        // local PDFs are only displayed, they are not tied to a project
        if (doc.isProjectFile) {
            EventBus.fire('pdfWillOpenEvent', {uri: doc.uri, doc, webviewPanel});
        }

        const post = (message: HostMessage) => webviewPanel.webview.postMessage(message);
        const updateWebview = () => {
            if (doc.output) {
                post({type:'load', output:doc.output});
            } else if (doc.cache.buffer.byteLength !== 0) {
                post({type:'update', content:doc.cache.buffer as ArrayBuffer});
            }
        };
        // what the viewer's banner says about the project's build (ProjectBuilds.status)
        const builds = doc.vfs?.builds;
        const postStatus = () => {
            if (builds) {
                post({type:'buildState', ...builds.status});
            }
        };
        // The viewer's loader fetches the build's ranges and pieces through the extension host,
        // and only outputs of the build's project. Each page that the panel shows gets a bridge of
        // its own, under the page's ID: the page numbers its requests from 1, so the requests of a
        // page that a new page replaced, as after a switch of the viewer, are stopped, and their
        // answers do not reach the new page.
        const newBridge = () => ({
            page: randomUUID(),
            fetches: new PdfFetchBridge(
                (url) => doc.output!==undefined && outputsOf(doc.output.downloadDomain, doc.output.projectId)(url),
                this.pieces,
                { buildSize: () => doc.output?.file.size },
            ),
        });
        let bridge = newBridge();

        const listeners: Array<() => void> = [];
        const docOnDidChangeListener = doc.onDidChange(() => {
            updateWebview();
        });
        listeners.push(() => docOnDidChangeListener.dispose());
        if (builds) {
            // while this viewer is visible, a missing build is compiled (ProjectBuilds)
            listeners.push(builds.attachViewer(webviewPanel), builds.onDidChangeStatus(postStatus));
        }

        // the page of the document's viewer; a new page reloads the webview, which then asks for
        // the document again ('ready')
        const editor = {
            doc,
            panel: webviewPanel,
            render: async () => {
                bridge.fetches.abortAll();
                bridge = newBridge();
                webviewPanel.webview.html = await this.getViewerPage(webviewPanel.webview, doc.engine, bridge.page);
            },
        };
        this.editors.add(editor);

        webviewPanel.onDidDispose(() => {
            bridge.fetches.abortAll();
            listeners.forEach(stop => stop());
            this.editors.delete(editor);
        });

        webviewPanel.webview.options = {enableScripts:true, localResourceRoots:[this.context.extensionUri]};
        await editor.render();
        // opened: ask Overleaf for the latest compile, which another client may have made
        void builds?.check();

        // register event listeners
        webviewPanel.onDidChangeViewState((e) => {
            if (e.webviewPanel.active && doc.isProjectFile) {
                EventBus.fire('fileWillOpenEvent', {uri: doc.uri});
            }
            // shown again: another client (the web editor, another window, a command-line tool)
            // may have compiled meanwhile
            if (e.webviewPanel.visible) {
                void builds?.check();
            }
        });
        webviewPanel.webview.onDidReceiveMessage((e: ViewerMessage) => {
            switch (e.type) {
                case 'syncPdf':
                    if (doc.isProjectFile) {
                        vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.syncPdf`, e.content);
                    }
                    break;
                case 'saveState':
                    GlobalStateManager.updatePdfViewPersist(this.context, doc.uri.toString(), e.content);
                    break;
                case 'fetch': {
                    // a request of a page that the panel no longer shows is not sent
                    const asked = bridge;
                    if (e.page !== asked.page) { break; }
                    const answer = (message: HostMessage) => {
                        if (asked === bridge) { post(message); }
                    };
                    asked.fetches.handle(e).then(
                        (res) => answer({type:'fetchResponse', page: asked.page, ...res}),
                        (error) => answer({type:'fetchError', page: asked.page, id:e.id, message:String(error?.message ?? error)}),
                    );
                    break;
                }
                case 'fetchAbort':
                    if (e.page === bridge.page) { bridge.fetches.abort(e.id); }
                    break;
                case 'recompile':
                    // the project of this build, whichever editor is active; only a build's viewer
                    // offers Recompile, in its line about the build (ProjectBuilds.status), which
                    // also says how the compile goes
                    void builds?.recompile();
                    break;
                case 'buildGone':
                    // the viewer found the build's files gone from Overleaf's servers
                    if (typeof e.build === 'string') {
                        void builds?.reportGone(e.build);
                    }
                    break;
                case 'download':
                    this.download(doc);
                    break;
                case 'switchViewer':
                    void this.switchViewer(e.engine);
                    break;
                case 'ready':
                    const state = GlobalStateManager.getPdfViewPersist(this.context, doc.uri.toString());
                    const config = vscode.workspace.getConfiguration('overleaf-workshop.pdfViewer');
                    const colorThemes = config.get('themes', undefined);
                    const defaults = {
                        scrollMode: config.get('defaultScrollMode', 'vertical'),
                        spreadMode: config.get('defaultSpreadMode', 'none'),
                    };
                    post({type:'initState', content:state, colorThemes, defaults});
                    updateWebview();
                    postStatus();
                    break;
                default:
                    break;
            }
        });
    }

    public get triggers(): vscode.Disposable[] {
        return [
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('overleaf-workshop.pdfViewer.engine')) {
                    this.applyEngine().catch((error) => console.error('overleaf-workshop: switching the PDF viewer:', error));
                }
            }),
            // back from the browser or another window, where the project may have been compiled:
            // the builds in view ask for the latest compile
            vscode.window.onDidChangeWindowState((state) => {
                if (!state.focused) { return; }
                for (const editor of this.editors) {
                    if (editor.panel.visible) {
                        void editor.doc.vfs?.builds.check();
                    }
                }
            }),
            vscode.window.registerCustomEditorProvider(`${ROOT_NAME}.pdfViewer`, this, {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            }),
        ];
    }

    /** A viewer page from views/pdf-viewer/dist/, completed with its base URL and configuration. */
    private async getViewerPage(webview: vscode.Webview, engine: PdfViewerEngine, page: string): Promise<string> {
        let template: string;
        try {
            template = (await vscode.workspace.fs.readFile(this.viewerFile('dist', `${engine}.html`))).toString();
        } catch {
            throw new Error(`the ${engine} PDF viewer is not built: run npm run build-pdf-viewer`);
        }
        return completeViewerPage(template, { engine, base: webview.asWebviewUri(this.viewerFile()).toString() + '/', page, pdfjsRelease: this.pdfjsRelease });
    }

    /**
     * Save the PDF to a file the user picks. The build in use is saved from Overleaf
     * (VirtualFileSystem.savePdf), since the viewer has only the parts it showed; a PDF read whole
     * is written out. A document that has nothing loaded is not saved, so that the user's file is
     * not overwritten with an empty one.
     */
    private async download(doc: PdfDocument) {
        const name = path.posix.basename(doc.uri.path);
        const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri ?? vscode.Uri.file(os.homedir());
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder, name), filters: { PDF: ['pdf'] } });
        if (!target) { return; }
        const vfs = doc.vfs;
        const size = doc.output?.file.size;
        try {
            if (vfs && size && target.scheme === 'file') {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Saving {0}', name), cancellable: true,
                }, async (progress, token) => {
                    const abort = new AbortController();
                    token.onCancellationRequested(() => abort.abort());
                    let reported = 0;
                    // a download from Overleaf's cache starts again from 0; it reports from where the first one got to
                    await vfs.savePdf(target.fsPath, abort.signal, (received: number) => {
                        if (received - reported >= size / 100 || received === size) {
                            progress.report({ increment: (received - reported) / size * 100 });
                            reported = received;
                        }
                    });
                });
            } else {
                const content = doc.output ? new Uint8Array(await vscode.workspace.fs.readFile(doc.uri)) : doc.cache;
                if (content.byteLength === 0) {
                    throw new Error(vscode.l10n.t('the PDF is not loaded'));
                }
                await vscode.workspace.fs.writeFile(target, content);
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('Could not save {0}: {1}', name, error?.message ?? String(error)));
        }
    }

}
