import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { OUTPUT_FOLDER_NAME, ROOT_NAME } from '../consts';
import { EventBus } from '../utils/eventBus';
import { GlobalStateManager } from '../utils/globalStateManager';
import { parseUri } from './remoteFileSystemProvider';
import type { PdfOutput, VirtualFileSystem } from './remoteFileSystemProvider';
import { downloadTo, outputsOf, PdfFetchBridge, PieceCache } from './pdfFetchBridge';
import { completeViewerPage, isBuildPath, PDF_VIEWER_ENGINES, PdfViewerEngine } from './pdfViewerPages';

export class PdfDocument implements vscode.CustomDocument {
    cache: Uint8Array = new Uint8Array(0);
    /** for the build's output.pdf in a viewer that loads in ranges: the build to load */
    output?: PdfOutput;

    private readonly _onDidChange = new vscode.EventEmitter<{}>();
    readonly onDidChange = this._onDidChange.event;

    /** `engine`: the viewer that shows this document (setting overleaf-workshop.pdfViewer.engine) */
    constructor(readonly uri: vscode.Uri, readonly engine: PdfViewerEngine = 'legacy') {
        this.uri = uri;
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
        // The viewers other than the legacy one load a build in ranges, as Overleaf's viewer
        // loads it: they need only its address, not its content. Other PDFs are read whole.
        if (this.engine !== 'legacy' && this.isBuild) {
            const vfs = await vscode.commands.executeCommand<VirtualFileSystem>('remoteFileSystem.prefetch', this.uri).then(v => v, () => undefined);
            this.output = vfs?.pdfOutput();
            if (this.output) {
                this.cache = new Uint8Array();
                this._onDidChange.fire({output: this.output});
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

    constructor(private readonly context:vscode.ExtensionContext) {
        this.context = context;
        const sizeMB = vscode.workspace.getConfiguration('overleaf-workshop.pdfViewer').get<number>('pieceCacheSizeMB', 1024);
        this.pieces = new PieceCache(path.join(context.globalStorageUri.fsPath, 'pdf-pieces'), Math.max(0, sizeMB) * 1024 * 1024);
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
        const doc = new PdfDocument(uri, await this.engine());
        await doc.refresh();
        return doc;
    }

    /**
     * The viewer that the setting overleaf-workshop.pdfViewer.engine picks, or the legacy viewer
     * when this install does not have the picked viewer's page. A change of the setting applies
     * to the PDFs opened after it.
     */
    private async engine(): Promise<PdfViewerEngine> {
        const picked = vscode.workspace.getConfiguration('overleaf-workshop.pdfViewer').get<string>('engine', 'legacy') as PdfViewerEngine;
        if (picked === 'legacy' || !PDF_VIEWER_ENGINES.includes(picked)) {
            return 'legacy';
        }
        try {
            await vscode.workspace.fs.stat(this.viewerFile('dist', `${picked}.html`));
            return picked;
        } catch {
            console.warn(`overleaf-workshop: the ${picked} PDF viewer is not built (npm run build-pdf-viewer); using the legacy viewer`);
            return 'legacy';
        }
    }

    private viewerFile(...parts: string[]) {
        return vscode.Uri.joinPath(this.context.extensionUri, 'views/pdf-viewer', ...parts);
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

        webviewPanel.onDidDispose(() => {
            docOnDidChangeListener.dispose();
        });

        webviewPanel.webview.options = {enableScripts:true};
        webviewPanel.webview.html = doc.engine === 'legacy'
            ? await this.getHtmlForWebview(webviewPanel.webview)
            : await this.getViewerPage(webviewPanel.webview, doc.engine);

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
            vscode.window.registerCustomEditorProvider(`${ROOT_NAME}.pdfViewer`, this, {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            }),
        ];
    }

    private patchViewerHtml(webview: vscode.Webview, html: string): string {
        const patchPath = (...path:string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'views/pdf-viewer', ...path)).toString();

        // adjust original path
        html = html.replace('../build/pdf.js', patchPath('vendor','build','pdf.js'));
        html = html.replace('viewer.css', patchPath('vendor','web','viewer.css'));
        html = html.replace('viewer.js',  patchPath('vendor','web','viewer.js'));

        // patch custom files
        const workerScript = `<script src="${patchPath('vendor','build','pdf.worker.js')}"></script>`;
        const customScript = `<script src="${patchPath('index.js')}"></script>`;
        const customStyle = `<link rel="stylesheet" href="${patchPath('index.css')}" />`;
        html = html.replace(/\<\/head\>/, `${workerScript}\n${customScript}\n${customStyle}\n</head>`);

        return html;
    }

    /** A viewer page from views/pdf-viewer/dist/, completed with its base URL and configuration. */
    private async getViewerPage(webview: vscode.Webview, engine: Exclude<PdfViewerEngine, 'legacy'>): Promise<string> {
        const template = (await vscode.workspace.fs.readFile(this.viewerFile('dist', `${engine}.html`))).toString();
        return completeViewerPage(template, engine, webview.asWebviewUri(this.viewerFile()).toString() + '/');
    }

    /**
     * Save the PDF to a file the user picks. A build is downloaded from Overleaf to the file as
     * it arrives, since the viewer has only the parts it showed; a PDF read whole is written out.
     */
    private async download(doc: PdfDocument) {
        const name = path.posix.basename(doc.uri.path);
        const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.scheme === 'file')?.uri ?? vscode.Uri.file(os.homedir());
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder, name), filters: { PDF: ['pdf'] } });
        if (!target) { return; }
        const output = doc.output;
        try {
            if (output && target.scheme === 'file') {
                await vscode.window.withProgress({
                    location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Saving {0}', name), cancellable: true,
                }, async (progress, token) => {
                    const abort = new AbortController();
                    token.onCancellationRequested(() => abort.abort());
                    let reported = 0;
                    await downloadTo(output.url, target.fsPath, abort.signal, (received, total) => {
                        if (total && received - reported >= total / 100) {
                            progress.report({ increment: (received - reported) / total * 100 });
                            reported = received;
                        }
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

    private async getHtmlForWebview(webview: vscode.Webview): Promise<string> {
        const htmlPath = vscode.Uri.joinPath(this.context.extensionUri, 'views/pdf-viewer/vendor/web/viewer.html');
        let html = (await vscode.workspace.fs.readFile(htmlPath)).toString();
        return this.patchViewerHtml(webview, html);
    }

}
