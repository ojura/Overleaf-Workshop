import * as path from 'path';
import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';
import { isReplicaOwnPath } from '../scm/ignorePatterns';
import { LocalReplicaSCMProvider } from '../scm/localReplicaSCM';
import { errorMessage } from '../utils/errorMessage';

const DEBUG_SECTION = ROOT_NAME + '.debug';
const DISABLE_LOCAL_COMPILE = 'disableLocalReplicaCompilePreview';
const DEBUG_SETTING = DEBUG_SECTION + '.' + DISABLE_LOCAL_COMPILE;

/** The local workspace folder and the Overleaf project recorded in its replica settings. */
export interface LocalReplicaProject {
    folder: vscode.Uri;
    project: vscode.Uri;
}

/**
 * Recognize the workspace's local replica from its settings, without connecting to Overleaf.
 * Older settings may contain enableCompileNPreview; compile and preview are now normal replica
 * features, so that old opt-in does not affect recognition or command availability.
 */
export async function readLocalReplicaProject(): Promise<LocalReplicaProject | undefined> {
    const folders = vscode.workspace.workspaceFolders;
    const folder = folders?.length === 1 ? folders[0].uri : undefined;
    if (folder?.scheme !== 'file') { return undefined; }
    const settings = await LocalReplicaSCMProvider.readSettings();
    if (typeof settings?.uri !== 'string') { return undefined; }
    try {
        const project = vscode.Uri.parse(settings.uri);
        return project.scheme === ROOT_NAME ? { folder, project } : undefined;
    } catch {
        return undefined;
    }
}

/** The file's relative path, including the root as '', when it belongs to this local replica. */
export function localReplicaPath(resource: vscode.Uri, replica: LocalReplicaProject): string | undefined {
    if (resource.scheme !== 'file' || resource.authority !== replica.folder.authority) { return undefined; }
    const relative = path.relative(replica.folder.fsPath, resource.fsPath);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) { return undefined; }
    const projectPath = relative.split(path.sep).join('/');
    return isReplicaOwnPath('/' + projectPath) ? undefined : projectPath;
}

/** The explicit command target, else the active source editor or the workspace when a PDF has focus. */
function commandResource(target?: vscode.Uri): vscode.Uri | undefined {
    return target ?? vscode.window.activeTextEditor?.document.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
}

/**
 * The project that can compile or show the PDF for this resource. A local file must belong to
 * the replica; an unrelated file or another URI scheme must not compile the workspace's project.
 * The advanced debug option applies to the local replica only.
 */
function projectOf(resource: vscode.Uri | undefined, replica: LocalReplicaProject | undefined): vscode.Uri | undefined {
    if (resource?.scheme === ROOT_NAME) { return resource; }
    if (!resource || !replica || localReplicaPath(resource, replica) === undefined) { return undefined; }
    const disabled = vscode.workspace.getConfiguration(DEBUG_SECTION, replica.folder).get<boolean>(DISABLE_LOCAL_COMPILE, false);
    return disabled ? undefined : replica.project;
}

/** Resolve the same project for command execution as for the editor's compile and preview context. */
export async function projectForResource(target?: vscode.Uri): Promise<vscode.Uri | undefined> {
    const resource = commandResource(target);
    if (resource?.scheme === ROOT_NAME) { return resource; }
    return projectOf(resource, await readLocalReplicaProject());
}

/**
 * Keep the workbench contexts derived from the workspace, active editor and debug preference.
 * Local recognition enables the buttons before the project's connection starts. Connection
 * failures are reported once for that initialization; editor/configuration events do not retry it.
 */
export class ProjectContexts implements vscode.Disposable {
    readonly ready: Promise<void>;
    private revision = 0;
    private disposed = false;
    private initialized?: string;
    private readonly listeners: vscode.Disposable[];

    constructor(private readonly initialize: (project: vscode.Uri) => Promise<unknown>) {
        this.listeners = [
            vscode.window.onDidChangeActiveTextEditor(() => this.refresh().catch(error => this.reportContextError(error))),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh().catch(error => this.reportContextError(error))),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration(DEBUG_SETTING)) {
                    return this.refresh().catch(error => this.reportContextError(error));
                }
            }),
        ];
        this.ready = this.refresh().catch(error => this.reportContextError(error));
    }

    private reportContextError(error: unknown): void {
        if (!this.disposed) {
            void vscode.window.showErrorMessage(vscode.l10n.t(
                'The local replica commands could not be updated: {error}', { error: errorMessage(error) }
            ));
        }
    }

    private async refresh(): Promise<void> {
        const revision = ++this.revision;
        const replica = await readLocalReplicaProject();
        if (this.disposed || revision !== this.revision) { return; }
        const resource = commandResource();
        // Remote editors use their own resourceScheme condition in the menus. This context
        // describes local availability, so a remote editor cannot enable unrelated local files.
        const available = resource?.scheme === 'file' && projectOf(resource, replica) !== undefined;
        await Promise.all([
            vscode.commands.executeCommand('setContext', ROOT_NAME + '.activate', replica !== undefined),
            vscode.commands.executeCommand('setContext', ROOT_NAME + '.activateCompile', available),
        ]);
        if (this.disposed || revision !== this.revision) { return; }
        const identity = replica && replica.folder.toString() + '\n' + replica.project.toString();
        if (identity === this.initialized) { return; }
        this.initialized = identity;
        if (replica) {
            void Promise.resolve().then(() => this.initialize(replica.project)).catch(error => {
                if (!this.disposed) {
                    void vscode.window.showErrorMessage(vscode.l10n.t(
                        'The local replica could not connect to Overleaf: {error}', { error: errorMessage(error) }
                    ));
                }
            });
        }
    }

    dispose(): void {
        this.disposed = true;
        this.revision++;
        this.listeners.forEach(listener => listener.dispose());
    }
}
