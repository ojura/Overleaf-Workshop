import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { OUTPUT_FOLDER_NAME, ROOT_NAME } from '../consts';
import { EventBus } from '../utils/eventBus';
import { GlobalStateManager } from '../utils/globalStateManager';
import { parseUri } from './remoteFileSystemProvider';
import type { PdfOutput, VirtualFileSystem } from './remoteFileSystemProvider';
import { downloadInRanges, outputsOf, PdfFetchBridge, PieceCache } from './pdfFetchBridge';
import { completeViewerPage, DEFAULT_PDF_VIEWER_ENGINE, isBuildPath, PDF_VIEWER_ENGINES, PdfViewerEngine } from './pdfViewerPages';

export class PdfDocument implements vscode.CustomDocument {
    cache: Uint8Array = new Uint8Array(0);
    /** for the build's output.pdf: the build, which the viewer loads in ranges */
    output?: PdfOutput;

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

    dispose() { }

    async refresh(): Promise<Uint8Array> {
        // The viewers load a build in ranges, as Overleaf's viewer loads it: they need only its
        // address, not its content. Other PDFs, and a build this session has not compiled, are
        // read whole.
        if (this.isBuild) {
            const vfs = await vscode.commands.executeCommand<VirtualFileSystem>('remoteFileSystem.prefetch', this.uri).then(v => v, () => undefined);
            const output = vfs?.pdfOutput();
            if (output) {
                this.output = output;
                this.cache = new Uint8Array();
                this._onDidChange.fire({output});
                return this.cache;
            }
        }
        this.output = undefined;
        try {
            this.cache = new Uint8Array(await vscode.workspace.fs.readFile(this.uri));
        } catch {
            this.cache = new Uint8Array();
        }
        this._onDidChange.fire({content:this.cache});
        return this.cache;
    }
}

export class PdfViewEditorProvider implements vscode.CustomEditorProvider<PdfDocument> {
    private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PdfDocument>>();
    readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

    /** the pieces of compiled PDFs kept between builds and sessions (src/core/pdfFetchBridge.ts) */
    private readonly pieces: PieceCache;
    /** the open viewers, which a change of overleaf-workshop.pdfViewer.engine reloads */
    private readonly editors = new Set<{ doc: PdfDocument, render: () => Promise<void> }>();

    constructor(private readonly context:vscode.ExtensionContext) {
        this.context = context;
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
        return PDF_VIEWER_ENGINES.includes(picked as PdfViewerEngine) ? picked as PdfViewerEngine : DEFAULT_PDF_VIEWER_ENGINE;
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
        if (engine !== 'pdfjs' && engine !== 'overleaf') {
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

        const updateWebview = () => {
            if (doc.output) {
                webviewPanel.webview.postMessage({type:'load', output:doc.output});
            } else if (doc.cache.buffer.byteLength !== 0) {
                webviewPanel.webview.postMessage({type:'update', content:doc.cache.buffer});
            }
        };
        // the viewer's loader fetches the build's ranges and pieces through the extension host,
        // and only outputs of the build's project
        const bridge = new PdfFetchBridge(
            (url) => doc.output!==undefined && outputsOf(doc.output.downloadDomain, doc.output.projectId)(url),
            this.pieces,
            { buildSize: () => doc.output?.file.size },
        );

        const docOnDidChangeListener = doc.onDidChange(() => {
            updateWebview();
        });

        // the page of the document's viewer; a new page reloads the webview, which then asks for
        // the document again ('ready')
        const editor = {
            doc,
            render: async () => {
                webviewPanel.webview.html = await this.getViewerPage(webviewPanel.webview, doc.engine);
            },
        };
        this.editors.add(editor);

        webviewPanel.onDidDispose(() => {
            docOnDidChangeListener.dispose();
            this.editors.delete(editor);
        });

        webviewPanel.webview.options = {enableScripts:true, localResourceRoots:[this.context.extensionUri]};
        await editor.render();

        // register event listeners
        webviewPanel.onDidChangeViewState((e) => {
            if (e.webviewPanel.active && doc.isProjectFile) {
                EventBus.fire('fileWillOpenEvent', {uri: doc.uri});
            }
        });
        webviewPanel.webview.onDidReceiveMessage((e) => {
            switch (e.type) {
                case 'syncPdf':
                    if (doc.isProjectFile) {
                        vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.syncPdf`, e.content);
                    }
                    break;
                case 'saveState':
                    GlobalStateManager.updatePdfViewPersist(this.context, doc.uri.toString(), e.content);
                    break;
                case 'fetch':
                    bridge.handle(e).then(
                        (res) => webviewPanel.webview.postMessage({type:'fetchResponse', ...res}),
                        (error) => webviewPanel.webview.postMessage({type:'fetchError', id:e.id, message:String(error?.message ?? error)}),
                    );
                    break;
                case 'fetchAbort':
                    bridge.abort(e.id);
                    break;
                case 'recompile':
                    if (doc.isProjectFile) {
                        vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.compile`);
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
                    webviewPanel.webview.postMessage({type:'initState', content:state, colorThemes, defaults});
                    updateWebview();
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
            vscode.window.registerCustomEditorProvider(`${ROOT_NAME}.pdfViewer`, this, {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            }),
        ];
    }

    /** A viewer page from views/pdf-viewer/dist/, completed with its base URL and configuration. */
    private async getViewerPage(webview: vscode.Webview, engine: PdfViewerEngine): Promise<string> {
        let template: string;
        try {
            template = (await vscode.workspace.fs.readFile(this.viewerFile('dist', `${engine}.html`))).toString();
        } catch {
            throw new Error(`the ${engine} PDF viewer is not built: run npm run build-pdf-viewer`);
        }
        return completeViewerPage(template, engine, webview.asWebviewUri(this.viewerFile()).toString() + '/');
    }

    /**
     * Save the PDF to a file the user picks. A build is downloaded from Overleaf to the file in
     * ranges (downloadInRanges), since the viewer has only the parts it showed, and the download
     * domain cuts off one long response of a large build; a PDF read whole is written out.
     */
    private async download(doc: PdfDocument) {
        const name = path.posix.basename(doc.uri.path);
        const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri ?? vscode.Uri.file(os.homedir());
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder, name), filters: { PDF: ['pdf'] } });
        if (!target) { return; }
        const output = doc.output;
        const size = output?.file.size;
        try {
            if (output && size && target.scheme === 'file') {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Saving {0}', name), cancellable: true,
                }, async (progress, token) => {
                    const abort = new AbortController();
                    token.onCancellationRequested(() => abort.abort());
                    let reported = 0;
                    await downloadInRanges(output.url, target.fsPath, size, abort.signal, {
                        onProgress: (received) => {
                            if (received - reported >= size / 100 || received === size) {
                                progress.report({ increment: (received - reported) / size * 100 });
                                reported = received;
                            }
                        },
                    });
                });
            } else {
                const content = output ? new Uint8Array(await vscode.workspace.fs.readFile(doc.uri)) : doc.cache;
                await vscode.workspace.fs.writeFile(target, content);
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(vscode.l10n.t('Could not save {0}: {1}', name, error?.message ?? String(error)));
        }
    }

}
