import * as vscode from 'vscode';
import { RemoteFileSystemProvider, VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { ROOT_NAME, ELEGANT_NAME, OUTPUT_FOLDER_NAME } from '../consts';
import { PdfDocument } from '../core/pdfViewEditorProvider';
import { LatexParser, ErrorSchema } from './compileLogParser';
import { EventBus } from '../utils/eventBus';
import { LocalReplicaSCMProvider } from '../scm/localReplicaSCM';
import { REPLICA_OUTPUT_FOLDER, saveCompileOutputs } from './outputFiles';

// map string level to severity
const severityMap: Record<string, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    information: vscode.DiagnosticSeverity.Information,
};

// Match the document class in the tex file
const documentClassRegex = new RegExp(/\\documentclass(?:\[[^\[\]\{\}]*\])?\{([^\[\]\{\}]+)\}/);

const pdfViewRecord: {
    [key: string]: {
        [key: string]: { doc: PdfDocument, webviewPanel: vscode.WebviewPanel }
    }
} = {};

class CompileDiagnosticProvider {
    private diagnosticCollection = vscode.languages.createDiagnosticCollection(ROOT_NAME);
    constructor(private readonly vfsm: RemoteFileSystemProvider) {};

    private async getRange(log: ErrorSchema, path: string, vfs: any) {
        let textDoc: vscode.TextDocument;
        try {
            textDoc = (await vscode.workspace.openTextDocument(vfs.pathToUri(path)));
        }
        catch (error) {
            return null;
        }
        if (log.line !== null) {
            const _range = new vscode.Range(
                new vscode.Position(log.line - 1, 0),
                new vscode.Position(log.line, 0),
            );
            const lineContent = textDoc.getText(_range);
            const lineMatch = lineContent.match(/^\s*(.*?)\s*$/)?.[1] || '';
            const lineStart = lineContent.indexOf(lineMatch);
            const lineEnd = lineStart + lineMatch.length;
            return new vscode.Range(
                new vscode.Position(log.line - 1, lineStart),
                new vscode.Position(log.line - 1, lineEnd),
            );
        }
        else {
            return new vscode.Range(
                new vscode.Position(0, 0),
                new vscode.Position(1, 0),
            );
        }
    }
    private validatePath(path: string) {
        const outputRegex = new RegExp(/\.\/(output.(aux|bbl|toc|lof|lot|bbl|bst|ttt|fff))\b/);
        const match = outputRegex.exec(path);
        if (match) {
            return path.replace(match[0], `${OUTPUT_FOLDER_NAME}/${match[1]}`);
        }
        return path;
    }

    private async updateDiagnostics(uri: vscode.Uri) {
        this.diagnosticCollection.clear();
        const vfs = await this.vfsm.prefetch(uri);
        const logPath = `${OUTPUT_FOLDER_NAME}/output.log`;
        const _uri = vfs.pathToUri(logPath);
        let content ='';
        content = new TextDecoder().decode(await vfs.openFile(_uri));
        const logs = new LatexParser(content).parse();
        if (logs === undefined) {
            return content === ''? true :false;
        }
        let hasError = false;
        const diagnosticsRecorder: { [key: string]: vscode.Diagnostic[] } = {};
        for (const log of logs.all) {
            if (!log.file.startsWith('./')) { continue; }
            const path = this.validatePath(log.file);
            const range = await this.getRange(log, path, vfs);
            if (range === null) {
                continue;
            }
            if (!diagnosticsRecorder[path]) {
                diagnosticsRecorder[path] = [];
            }
            const diagnostic = new vscode.Diagnostic(range, log.message, severityMap[log.level]);
            diagnostic.source = vscode.l10n.t('Compile Checker');
            diagnosticsRecorder[path].push(diagnostic);

            if (log.level === 'error') {
                hasError = true;
            }
        }
        for (const file in diagnosticsRecorder) {
            const diagnostics = diagnosticsRecorder[file];
            const _uri = vfs.pathToUri(file);
            this.diagnosticCollection.set(_uri, diagnostics);
        }
        return hasError;
    }

    get triggers() {
        return [
            this.diagnosticCollection,
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.compileErrorCheck`, async (uri) => {
                return await this.updateDiagnostics(uri);
            }),
        ];
    }
}

export class CompileManager {
    /** how long a compile waits for a local replica to upload its changes */
    static uploadWaitMs = 60 * 1000;
    readonly status: vscode.StatusBarItem;
    public inCompiling: boolean = false;
    private diagnosticProvider: CompileDiagnosticProvider;
    private compileAsDraft: boolean = false;
    private compileStopOnFirstError: boolean = false;
    /** the saves of local replica logs, one after another */
    private outputSaves: Promise<void> = Promise.resolve();

    constructor(
        private vfsm: RemoteFileSystemProvider,
    ) {
        this.vfsm = vfsm;
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
        this.status.command = `${ROOT_NAME}.compilerManager.settings`;
        this.diagnosticProvider = new CompileDiagnosticProvider(vfsm);
        // listen pdf open event
        EventBus.on('pdfWillOpenEvent', ({uri, doc, webviewPanel}) => {
            const {identifier,pathParts} = parseUri(uri);
            const filePath = pathParts.join('/');
            if (pdfViewRecord[identifier]) {
                pdfViewRecord[identifier][filePath] = {doc, webviewPanel};
            } else {
                pdfViewRecord[identifier] = {[filePath]:{doc, webviewPanel}};
            }
        });
    }

    static async check(uri?: vscode.Uri) {
        // check if supported vfs
        uri = uri || vscode.window.activeTextEditor?.document.uri;
        uri = uri || vscode.workspace.workspaceFolders?.[0].uri;
        if (uri?.scheme === ROOT_NAME) {
            return uri;
        }
        // check if supported local replica
        const localSetting = await LocalReplicaSCMProvider.readSettings();
        if (localSetting?.uri && localSetting?.enableCompileNPreview===true) {
            return vscode.Uri.parse(localSetting.uri);
        }
        // otherwise return undefined
        return undefined;
    }

    async update(status: 'idle'|'success'|'compiling'|'failed'|'alert') {
        const uri = await CompileManager.check();
        if (uri) {
            this.inCompiling = status === 'compiling';
            this.vfsm.prefetch(uri).then((vfs) => {
                const rootDocName = vfs.getRootDocName().slice(1);
                const compilerName = vfs.getCompiler()?.name || '';
                this.status.tooltip = new vscode.MarkdownString();
                switch (status) {
                    case 'idle':
                        this.status.text = `${compilerName}`;
                        this.status.tooltip.appendMarkdown(`\`${rootDocName}\``);
                        this.status.backgroundColor = undefined;
                        break;
                    case 'success':
                        this.status.text = `${compilerName}`;
                        this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Compile Success')}**`);
                        this.status.backgroundColor = undefined;
                        break;
                    case 'compiling':
                        this.status.text = `${compilerName} $(sync~spin)`;
                        this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Compiling')}**`);
                        this.status.backgroundColor = undefined;
                        break;
                    case 'failed':
                        this.status.text = `${compilerName} $(x)`;
                        this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Compile Failed')}**`);
                        this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
                        break;
                    case 'alert':
                        this.status.text = `$(alert)`;
                        this.status.tooltip.appendMarkdown(`\`${rootDocName}\` **${vscode.l10n.t('Not Connected')}**`);
                        this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
                        break;
                }
                this.status.tooltip.appendMarkdown(`\n\n*${vscode.l10n.t('Click to manage compile settings.')}*`);
                this.status.show();
            });
        } else {
            this.status.hide();
        }
        return uri;
    }

    async compile(force:boolean=false) {
        if (this.inCompiling) { return; }
        await vscode.workspace.saveAll(); // save all dirty files

        const uri = await this.update('compiling');
        if (uri) {
            this.vfsm.prefetch(uri)
                .then(async (vfs) => {
                    await this.waitForLocalReplica(vfs);
                    // Compile the open document as the main document when it has a
                    // \documentclass. For a local replica `uri` is the project folder.
                    const {fileType, fileId} = await vfs._resolveUri(uri);
                    let rootDocId: string | undefined = undefined;
                    if (fileType==='doc') {
                        const content = new TextDecoder().decode( await vfs.openFile(uri) );
                        rootDocId = RegExp(documentClassRegex).exec(content) ? fileId : undefined;
                    }
                    const res = await vfs.compile(force, this.compileAsDraft, this.compileStopOnFirstError, rootDocId);
                    if (res!==undefined) {
                        // not awaited: the PDF and the diagnostics do not wait for the local copies of the logs
                        this.saveLocalReplicaOutputs(vfs);
                    }
                    return res;
                })
                .then(async (res) => {
                    switch (res) {
                        case undefined:
                            await this.update('success');
                            break;
                        case false:
                            await this.update('failed');
                            break;
                        case true:
                            return true;
                        default:
                            await this.update('alert');
                            break;
                    }
                })
                .then(status =>
                    status ?
                        vscode.commands.executeCommand(`${ROOT_NAME}.compileManager.compileErrorCheck`, uri)
                        : Promise.reject()
                )
                .then(async (hasError) => {
                    if (hasError) {
                        await this.update('failed');
                    } else {
                        await this.update('success');
                    }
                    // refresh pdf
                    const { identifier } = parseUri(uri);
                    pdfViewRecord[identifier] && Object.values(pdfViewRecord[identifier]).forEach(
                        (record) => record.doc.refresh()
                    );
                });

        }
    }

    /**
     * A local replica uploads its changes in the background. Wait for them, so the compile on
     * Overleaf sees what was just saved, but compile anyway when they take too long.
     */
    private async waitForLocalReplica(vfs: VirtualFileSystem) {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), CompileManager.uploadWaitMs); });
        try {
            const res = await Promise.race([LocalReplicaSCMProvider.flushAll(vfs).then(() => 'done' as const), timeout]);
            if (res==='timeout') {
                vscode.window.showWarningMessage( vscode.l10n.t('Local changes are still being synced with Overleaf, so the PDF may not include all of them yet.') );
            }
        } catch (error) {
            vscode.window.showWarningMessage( vscode.l10n.t('Some local changes could not be uploaded to Overleaf, so the PDF may not include them: {error}', {error: String((error as Error)?.message ?? error)}) );
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Keep the logs of a local replica's compile in the replica's .overleaf/output folder, so
     * that editors and tools can read Overleaf's log locally. The replica never syncs that
     * folder. Saves run one after another, so the folder ends up with the last compile's logs.
     */
    private saveLocalReplicaOutputs(vfs: VirtualFileSystem) {
        const compile = vfs.lastCompile;
        if (compile===undefined) { return; }
        this.outputSaves = this.outputSaves.then(async () => {
            const setting = await LocalReplicaSCMProvider.readSettings();
            if (!setting?.uri || parseUri(vscode.Uri.parse(setting.uri)).projectId!==vfs.projectId) { return; }
            const folder = await LocalReplicaSCMProvider.pathToUri(REPLICA_OUTPUT_FOLDER);
            if (folder?.scheme!=='file') { return; }
            const summary = await saveCompileOutputs(folder.fsPath, compile, file => vfs.downloadCompileOutput(file, compile.response!));
            summary.failed.forEach(f => console.warn(`${ELEGANT_NAME}: ${f.path} of the compile was not saved in ${folder.fsPath}: ${f.error}`));
        }).catch(error => {
            console.error(`${ELEGANT_NAME}: could not save the compile's logs in ${REPLICA_OUTPUT_FOLDER}:`, error);
        });
    }

    /** Switch compiling on Overleaf and the PDF preview on or off for the workspace's local replica. */
    async toggleLocalReplicaCompile() {
        const setting = await LocalReplicaSCMProvider.readSettings();
        if (!setting?.uri) {
            vscode.window.showInformationMessage( vscode.l10n.t('This workspace is not a local replica of an Overleaf project.') );
            return;
        }
        const enabled = setting.enableCompileNPreview!==true;
        await LocalReplicaSCMProvider.writeSettings({...setting, enableCompileNPreview: enabled});
        await vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activateCompile`, enabled);
        if (enabled) {
            await this.update('idle');
            vscode.window.showInformationMessage( vscode.l10n.t('Compile and preview are on for this local replica: "Compile Project" compiles it on Overleaf and "View Compiled PDF" shows the result.') );
        } else {
            this.status.hide();
            vscode.window.showInformationMessage( vscode.l10n.t('Compile and preview are off for this local replica.') );
        }
    }

    async stopCompile() {
        const uri = await CompileManager.check();
        if (uri && this.inCompiling) {
            const vfs = await this.vfsm.prefetch(uri);
            await vfs.stopCompile();
            await this.update('failed');
        }
    }

    async openPdf() {
        const uri = await CompileManager.check();
        if (uri) {
            const rootPath = uri.path.split('/', 2)[1];
            const pdfUri = uri.with({
                path: `/${rootPath}/${OUTPUT_FOLDER_NAME}/output.pdf`,
            });
            vscode.commands.executeCommand('vscode.openWith', pdfUri,
                `${ROOT_NAME}.pdfViewer`,
                { preview: false, viewColumn: vscode.ViewColumn.Beside }
            );
        }
    }

    async syncCode() {
        const uri = await CompileManager.check();
        if (uri && vscode.window.activeTextEditor) {
            const { identifier, pathParts } = parseUri(uri);
            const startPoint = vscode.window.activeTextEditor.selection.start;
            const filePath = pathParts.join('/');
            const line = startPoint.line;
            const column = startPoint.character;
            this.vfsm.prefetch(uri)
                .then((vfs) => vfs.syncCode(filePath, line, column))
                .then((res) => {
                    if (res) {
                        const pdfPath = `${OUTPUT_FOLDER_NAME}/output.pdf`;
                        const webview = pdfViewRecord[identifier][pdfPath].webviewPanel.webview;
                        // get page
                        webview.postMessage({
                            type: 'syncCode',
                            content: res
                        });
                    }
                });
        }
    }

    private _revealSelectionInEditor(editor: vscode.TextEditor, targetLine: number, identifier: string) {
        const _identifier = identifier.replace(/\s+/g, '\\s+');
        // targetLine is 1-based from the syncTeX result
        const lineIndex = targetLine - 1;

        if (lineIndex < 0 || lineIndex >= editor.document.lineCount) {
            console.warn(`${ELEGANT_NAME}: Invalid line number ${targetLine} for revealing in editor. Document has ${editor.document.lineCount} lines.`);
            // Optionally, just focus the editor if the line is invalid
            vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: false });
            return;
        }

        const lineText = editor.document.lineAt(lineIndex).text;
        const match = lineText.match(_identifier);
        const matchIndex = match?.index ?? 0;

        let newSelections: vscode.Selection[];
        const newSelection = new vscode.Selection(lineIndex, matchIndex, lineIndex, matchIndex);
        if (editor.selections.length > 0) {
            newSelections = editor.selections.map((sel, index) =>
                index === 0 ? newSelection : sel
            );
        } else {
            newSelections = [newSelection];
        }
        editor.selections = newSelections;

        editor.revealRange(new vscode.Range(lineIndex, matchIndex, lineIndex, matchIndex), vscode.TextEditorRevealType.InCenter);
    }

    async syncPdf(r: { page: number, h: number, v: number, identifier: string }) {
        const uri = await CompileManager.check();
        if (uri) {
            this.vfsm.prefetch(uri)
                .then((vfs) => vfs.syncPdf(r.page, r.h, r.v))
                .then((res) => {
                    if (res) {
                        const { projectName } = parseUri(uri);
                        const { file, line, column } = res;
                        const _file = file.match(/output\.[^\.]+$/) ? `${OUTPUT_FOLDER_NAME}/${file}` : file;
                        const fileUri = uri.with({ path: `/${projectName}/${_file}` });

                        let viewColumnToUse: vscode.ViewColumn | undefined;
                        const existingEditor = vscode.window.visibleTextEditors.find(
                            e => e.document.uri.toString() === fileUri.toString()
                        );

                        if (existingEditor) {
                            viewColumnToUse = existingEditor.viewColumn;
                        } else {
                            viewColumnToUse = vscode.window.visibleTextEditors.at(-1)?.viewColumn || vscode.ViewColumn.Beside;
                        }

                        vscode.window.showTextDocument(fileUri, { viewColumn: viewColumnToUse, preserveFocus: false })
                            .then(
                                (openedEditor) => {
                                    if (openedEditor) {
                                        this._revealSelectionInEditor(openedEditor, line, r.identifier);
                                    }
                                },
                                (error) => {
                                    console.error(`${ELEGANT_NAME}: Failed to open document ${fileUri.fsPath} for syncPdf:`, error);
                                }
                            );
                    }
                })
                .catch(error => {
                    console.error(`${ELEGANT_NAME}: Error in syncPdf promise chain:`, error);
                });
        }
    }

    async setCompiler() {
        const uri = await CompileManager.check();
        const vfs = uri && await this.vfsm.prefetch(uri);
        const currentCompiler = vfs?.getCompiler();
        const compilers = vfs?.getAllCompilers();
        compilers && vscode.window.showQuickPick(compilers.map((item) => {
            return {
                label: item.name,
                description: item.code,
                picked: item.code === currentCompiler?.code,
            };
        }), {
            canPickMany: false,
            placeHolder: vscode.l10n.t('Select Compiler'),
        }).then(async (option) => {
            option && await vfs?.updateSettings({ compiler: option.description }) && this.compile(true);
        });
    }

    async setRootDoc() {
        const uri = await CompileManager.check();
        const vfs = uri && await this.vfsm.prefetch(uri);
        const currentRootDoc = vfs?.getRootDocName();
        const rootDocs = vfs?.getValidMainDocs();
        rootDocs && vscode.window.showQuickPick(rootDocs.map((item) => {
            return {
                id: item.entity._id,
                label: item.path,
                picked: item.path === currentRootDoc,
            };
        }), {
            canPickMany: false,
            placeHolder: vscode.l10n.t('Select Main Document'),
        }).then(async (option) => {
            option && await vfs?.updateSettings({ rootDocId: option.id }) && this.compile(true);
        });
    }

    async compileSettings() {
        const uri = await CompileManager.check();
        const vfs = uri && await this.vfsm.prefetch(uri);
        const currentCompiler = vfs?.getCompiler();
        const currentRootDoc = vfs?.getRootDocName();

        const currentDraftMode = this.compileAsDraft ? vscode.l10n.t('Draft Mode') : vscode.l10n.t('Normal Mode');
        const currentStopOnError = this.compileStopOnFirstError ? vscode.l10n.t('Stop on first error') : vscode.l10n.t('Try to compile despite errors');
        const settingItems = [
            {label: vscode.l10n.t('Compile Mode'), description: currentDraftMode},
            {label: vscode.l10n.t('Compile Error Handling'), description: currentStopOnError},
            {label: '', kind: vscode.QuickPickItemKind.Separator},
            {label: vscode.l10n.t('Setting: Compiler'), description: currentCompiler?.name, },
            {label: vscode.l10n.t('Setting: Main Document'), description: currentRootDoc, },
        ];
        if (this.inCompiling) {
            settingItems.unshift({label: vscode.l10n.t('Stop compilation'), description: undefined});
        }

        const setting = await vscode.window.showQuickPick(settingItems);
        switch (setting?.label) {
            case vscode.l10n.t('Setting: Compiler'):
                this.setCompiler();
                break;
            case vscode.l10n.t('Setting: Main Document'):
                this.setRootDoc();
                break;
            case vscode.l10n.t('Stop compilation'):
                this.stopCompile();
                break;
            case vscode.l10n.t('Compile Mode'):
                this.compileAsDraft = !this.compileAsDraft;
                this.compileSettings();
                break;
            case vscode.l10n.t('Compile Error Handling'):
                this.compileStopOnFirstError = !this.compileStopOnFirstError;
                this.compileSettings();
                break;
            default:
                break;
        }
    }

    get triggers() {
        return [
            // register status bar
            this.status,
            // register compile commands
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.compile`, () => this.compile(true)),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.viewPdf`, () =>  this.openPdf()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.syncCode`, () => this.syncCode()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.syncPdf`, (r) => this.syncPdf(r)),
            vscode.commands.registerCommand(`${ROOT_NAME}.compilerManager.settings`, ()=> this.compileSettings()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.setCompiler`, () => this.setCompiler()),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.setRootDoc`, () => this.setRootDoc()),
            vscode.commands.registerCommand(`${ROOT_NAME}.localReplica.toggleCompileNPreview`, () => this.toggleLocalReplicaCompile()),
            // register compile conditions
            vscode.workspace.onDidSaveTextDocument(async (e) => {
                const uri = await CompileManager.check.bind(this)(e.uri);
                const vfs = uri && await this.vfsm.prefetch(uri);
                const compileCondition = vscode.workspace.getConfiguration(`${ROOT_NAME}.compileOnSave`).get('enabled', true);
                const postfixCondition = e.fileName.match(/\.tex$|\.sty$|\.cls$|\.bib$/i);
                if (compileCondition && postfixCondition && vfs?.isInvisibleMode===false) {
                    this.compile();
                }
            }),
            EventBus.on('compilerUpdateEvent', () => {
                this.compile(true);
            }),
            EventBus.on('rootDocUpdateEvent', () => {
                this.compile(true);
            }),
            // register diagnostics triggers
            ...this.diagnosticProvider.triggers,
        ];
    }
}
