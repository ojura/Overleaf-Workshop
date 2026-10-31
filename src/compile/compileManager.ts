import * as vscode from 'vscode';
import { RemoteFileSystemProvider, VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { ROOT_NAME, ELEGANT_NAME, OUTPUT_FOLDER_NAME } from '../consts';
import { PdfDocument } from '../core/pdfViewEditorProvider';
import { LatexParser, ErrorSchema } from './compileLogParser';
import { EventBus } from '../utils/eventBus';
import { LocalReplicaSCMProvider } from '../scm/localReplicaSCM';
import { CompileRecord, REPLICA_OUTPUT_FOLDER, saveCompileOutputs } from './outputFiles';
import { windowCompileSettings } from './compileSettings';
import type { CompileOutcome, CompileStart } from '../core/projectBuilds';

// map string level to severity
const severityMap: Record<string, vscode.DiagnosticSeverity> = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    information: vscode.DiagnosticSeverity.Information,
};

// Match the document class in the tex file
const documentClassRegex = new RegExp(/\\documentclass(?:\[[^\[\]\{\}]*\])?\{([^\[\]\{\}]+)\}/);

/** Why compile `record` made no build, as the viewers' banner says it. */
function failureOf(record: CompileRecord | undefined): string {
    const status = record?.response?.status;
    if (status === undefined) {
        return `the compile request failed: ${record?.message}`;
    }
    return status === 'success' ? 'the compile made no output.pdf' : `Overleaf's status is "${status}"`;
}

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
    /**
     * the compile that runs, from the request (compile) to its end (run); the promise settles when
     * the compile has ended, however it ended
     */
    private running?: Promise<void>;
    private diagnosticProvider: CompileDiagnosticProvider;
    /** the saves of local replica logs, one after another */
    private outputSaves: Promise<void> = Promise.resolve();
    /**
     * the handling of the last build from Overleaf's cache: the Problems view, the status and the
     * replica's logs (showCachedBuild); it settles when they are done
     */
    cachedBuildShown: Promise<void> = Promise.resolve();
    /** the event listeners of the constructor, which `triggers` hands on for disposal */
    private readonly listeners: vscode.Disposable[] = [];

    constructor(
        private vfsm: RemoteFileSystemProvider,
    ) {
        this.vfsm = vfsm;
        this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -1);
        this.status.command = `${ROOT_NAME}.compilerManager.settings`;
        this.diagnosticProvider = new CompileDiagnosticProvider(vfsm);
        // another client's compile became the build in use (the web editor, another window, a
        // command-line tool): the Problems view, the status and the replica's copy of the logs
        // show it, as they show this window's compiles at their end (run)
        this.listeners.push(EventBus.on('buildChangedEvent', ({uri, fromCache}) => {
            if (fromCache) {
                this.cachedBuildShown = this.showCachedBuild(uri);
            }
        }));
        // listen pdf open event
        this.listeners.push(EventBus.on('pdfWillOpenEvent', ({uri, doc, webviewPanel}) => {
            const {identifier,pathParts} = parseUri(uri);
            const filePath = pathParts.join('/');
            if (pdfViewRecord[identifier]) {
                pdfViewRecord[identifier][filePath] = {doc, webviewPanel};
            } else {
                pdfViewRecord[identifier] = {[filePath]:{doc, webviewPanel}};
            }
        }));
    }

    /** whether a compile runs: from the request (compile) to its end (run) */
    get inCompiling(): boolean {
        return this.running !== undefined;
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

    /** Show `status` for the project of `target`, else of the active editor or the workspace (check). */
    async update(status: 'idle'|'success'|'compiling'|'failed'|'alert', target?: vscode.Uri) {
        const uri = await CompileManager.check(target);
        if (uri) {
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
            }).catch((error) => console.error(`${ELEGANT_NAME}: showing the compile status failed:`, error));
        } else {
            this.status.hide();
        }
        return uri;
    }

    /**
     * Compile the project of `target`, else of the active editor or the workspace (check).
     * Answers 'started' when the compile started, and its end fires compileEndedEvent, however it
     * ends; 'busy' while another compile of this window runs, with the promise of that compile's
     * end; and 'unavailable' when there is no project to compile. A request that does not start
     * a compile, because there is no project or because saving or finding the project failed,
     * fires no compileEndedEvent, and its end settles the promise of 'busy' all the same.
     */
    async compile(force:boolean=false, fromScratch:boolean=false, target?: vscode.Uri): Promise<CompileStart> {
        if (this.running) { return { kind: 'busy', ended: this.running }; }
        // taken before the first wait, so that a request meanwhile finds the window busy
        let settle!: () => void;
        const running = new Promise<void>(resolve => { settle = resolve; });
        this.running = running;
        const end = () => {
            if (this.running === running) { this.running = undefined; }
            settle();
        };
        let started = false;
        try {
            await vscode.workspace.saveAll(); // save all dirty files
            const uri = await this.update('compiling', target);
            if (!uri) { return { kind: 'unavailable' }; }
            started = true;
            void this.run(uri, force, fromScratch, end);
            return { kind: 'started' };
        } finally {
            if (!started) { end(); }
        }
    }

    /** The compile of the project at `uri` that `compile` started, up to its diagnostics; it calls `end` when it ends. */
    private async run(uri: vscode.Uri, force: boolean, fromScratch: boolean, end: () => void) {
        let outcome: CompileOutcome = { result: 'failure', detail: 'the compile did not start' };
        try {
            const vfs = await this.vfsm.prefetch(uri);
            await this.waitForLocalReplica(vfs);
            // Compile the open document as the main document when it has a
            // \documentclass. For a local replica `uri` is the project folder.
            const {fileType, fileId} = await vfs._resolveUri(uri);
            let rootDocId: string | undefined = undefined;
            if (fileType==='doc') {
                const content = new TextDecoder().decode( await vfs.openFile(uri) );
                rootDocId = RegExp(documentClassRegex).exec(content) ? fileId : undefined;
            }
            const res = await vfs.compile(force, windowCompileSettings.draft, windowCompileSettings.stopOnFirstError, rootDocId, fromScratch);
            if (res===undefined) {
                // nothing changed since the last compile
                outcome = { result: 'skipped' };
                await this.update('success', uri);
                return;
            }
            // not awaited: the PDF and the diagnostics do not wait for the local copies of the logs
            this.saveLocalReplicaOutputs(vfs);
            if (res===false) {
                outcome = { result: 'failure', detail: failureOf(vfs.lastCompile) };
                await this.update('failed', uri);
                return;
            }
            // the build is in use already (VirtualFileSystem.compile): the viewers load it
            outcome = { result: 'success' };
            const hasError = await this.problemsOf(uri);
            await this.update(hasError ? 'failed' : 'success', uri);
        } catch (error) {
            outcome = { result: 'failure', detail: String((error as Error)?.message ?? error) };
            console.error(`${ELEGANT_NAME}: the compile failed:`, error);
            await this.update('failed', uri).catch((statusError) => console.error(`${ELEGANT_NAME}: showing the compile's status failed:`, statusError));
        } finally {
            // in one step: the waiters of a 'busy' answer go on after the event's listeners have run
            end();
            EventBus.fire('compileEndedEvent', { uri, outcome });
        }
    }

    /**
     * Show the Problems of the build in use's output.log; whether it reports errors. When the log
     * cannot be read, the user is told, and the Problems view stays as it was.
     */
    private async problemsOf(uri: vscode.Uri): Promise<boolean> {
        try {
            return await vscode.commands.executeCommand<boolean>(`${ROOT_NAME}.compileManager.compileErrorCheck`, uri);
        } catch (error) {
            vscode.window.showWarningMessage( vscode.l10n.t('The compile log could not be read, so the Problems view does not show its errors: {error}', {error: String((error as Error)?.message ?? error)}) );
            return false;
        }
    }

    /** Another client's compile became the build in use of the project at `uri`. */
    private async showCachedBuild(uri: vscode.Uri) {
        try {
            const vfs = await this.vfsm.prefetch(uri);
            const build = vfs.builds.build;
            if (!build) { return; }
            const saved = this.saveLocalReplicaOutputs(vfs, build.record);
            const hasError = await this.problemsOf(uri);
            // a compile of this window shows its own status when it ends
            if (!this.inCompiling) {
                await this.update(hasError ? 'failed' : 'success', uri);
            }
            await saved;
        } catch (error) {
            console.error(`${ELEGANT_NAME}: showing another client's compile failed:`, error);
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
     * folder. Saves run one after another, so the folder ends up with the last one's logs:
     * `compile` is this window's last compile, whatever its status, or another client's compile
     * that became the build in use.
     */
    private saveLocalReplicaOutputs(vfs: VirtualFileSystem, compile: CompileRecord | undefined = vfs.lastCompile): Promise<void> {
        if (compile===undefined) { return this.outputSaves; }
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
        return this.outputSaves;
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

    /** The path inside the project of `docUri`: a document of the project, or a file of its local replica. */
    static async projectPathOf(docUri: vscode.Uri): Promise<string | undefined> {
        if (docUri.scheme===ROOT_NAME) {
            return parseUri(docUri).pathParts.join('/');
        }
        if (docUri.scheme==='file') {
            const path = await LocalReplicaSCMProvider.uriToPath(docUri); // like '/dir/name.tex'
            if (path!==undefined && path.startsWith('/') && !path.startsWith('/.overleaf/')) {
                return path.slice(1);
            }
        }
        return undefined;
    }

    /**
     * Where to open `file`, a path inside the project that SyncTeX names: the local replica's
     * copy when the workspace is a replica of this project and has the file, else the project's.
     */
    static async sourceUriOf(projectUri: vscode.Uri, projectId: string, file: string): Promise<vscode.Uri> {
        const { projectName } = parseUri(projectUri);
        if (/^output\.[^.]+$/.test(file)) {
            return projectUri.with({ path: `/${projectName}/${OUTPUT_FOLDER_NAME}/${file}` });
        }
        const setting = await LocalReplicaSCMProvider.readSettings();
        if (setting?.uri && parseUri(vscode.Uri.parse(setting.uri)).projectId===projectId) {
            const local = await LocalReplicaSCMProvider.pathToUri(`/${file}`);
            if (local) {
                try {
                    await vscode.workspace.fs.stat(local);
                    return local;
                } catch {
                    // not in the replica: open the project's copy
                }
            }
        }
        return projectUri.with({ path: `/${projectName}/${file}` });
    }

    async syncCode() {
        const editor = vscode.window.activeTextEditor;
        const uri = await CompileManager.check();
        if (!uri || !editor) { return; }
        const filePath = await CompileManager.projectPathOf(editor.document.uri);
        if (!filePath) {
            vscode.window.showInformationMessage( vscode.l10n.t('This file is not part of the Overleaf project.') );
            return;
        }
        const { identifier } = parseUri(uri);
        const startPoint = editor.selection.start;
        const vfs = await this.vfsm.prefetch(uri);
        // SyncTeX counts lines from 1, as the web editor sends them
        const res = await vfs.syncCode(filePath, startPoint.line + 1, startPoint.character);
        if (!res) { return; }
        const pdfPath = `${OUTPUT_FOLDER_NAME}/output.pdf`;
        if (!pdfViewRecord[identifier]?.[pdfPath]) {
            await this.openPdf();
            for (let i = 0; i < 50 && !pdfViewRecord[identifier]?.[pdfPath]; i++) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        }
        pdfViewRecord[identifier]?.[pdfPath]?.webviewPanel.webview.postMessage({
            type: 'syncCode',
            content: res,
        });
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
                .then(async (vfs) => {
                    const res = await vfs.syncPdf(r.page, r.h, r.v);
                    return res && {res, fileUri: await CompileManager.sourceUriOf(uri, vfs.projectId, res.file)};
                })
                .then((found) => {
                    if (found) {
                        const { res: { line }, fileUri } = found;

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

        const currentDraftMode = windowCompileSettings.draft ? vscode.l10n.t('Draft Mode') : vscode.l10n.t('Normal Mode');
        const currentStopOnError = windowCompileSettings.stopOnFirstError ? vscode.l10n.t('Stop on first error') : vscode.l10n.t('Try to compile despite errors');
        const settingItems = [
            {label: vscode.l10n.t('Compile Mode'), description: currentDraftMode},
            {label: vscode.l10n.t('Compile Error Handling'), description: currentStopOnError},
            {label: '', kind: vscode.QuickPickItemKind.Separator},
            {label: vscode.l10n.t('Setting: Compiler'), description: currentCompiler?.name, },
            {label: vscode.l10n.t('Setting: Main Document'), description: currentRootDoc, },
        ];
        settingItems.unshift({label: vscode.l10n.t('Recompile from Scratch'), description: vscode.l10n.t('clears the compile output on Overleaf first')});
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
            case vscode.l10n.t('Recompile from Scratch'):
                this.compile(true, true);
                break;
            case vscode.l10n.t('Compile Mode'):
                windowCompileSettings.draft = !windowCompileSettings.draft;
                this.compileSettings();
                break;
            case vscode.l10n.t('Compile Error Handling'):
                windowCompileSettings.stopOnFirstError = !windowCompileSettings.stopOnFirstError;
                this.compileSettings();
                break;
            default:
                break;
        }
    }

    get triggers() {
        return [
            ...this.listeners,
            // register status bar
            this.status,
            // register compile commands
            // the editor's title menu passes the editor's file; the compiles for a project's build,
            // the automatic one and the viewers' Recompile, pass the project's folder
            // (VirtualFileSystem.compileProject)
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.compile`, (target?: vscode.Uri) => this.compile(true, false, target)),
            vscode.commands.registerCommand(`${ROOT_NAME}.compileManager.recompileFromScratch`, () => this.compile(true, true)),
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
