import * as vscode from 'vscode';
import { ROOT_NAME } from './consts';

import { RemoteFileSystemProvider } from './core/remoteFileSystemProvider';
import { ProjectManagerProvider } from './core/projectManagerProvider';
import { PdfViewEditorProvider } from './core/pdfViewEditorProvider';
import { CompileManager } from './compile/compileManager';
import { ProjectContexts } from './compile/projectContext';
import { LangIntellisenseProvider } from './intellisense';
import { LocalReplicaSCMProvider } from './scm/localReplicaSCM';

export function activate(context: vscode.ExtensionContext): Promise<void> {
    // Register: [core] RemoteFileSystemProvider
    const remoteFileSystemProvider = new RemoteFileSystemProvider(context);
    context.subscriptions.push( ...remoteFileSystemProvider.triggers );

    // Register: [core] ProjectManagerProvider on Activitybar
    const projectManagerProvider = new ProjectManagerProvider(context);
    context.subscriptions.push( ...projectManagerProvider.triggers );

    // Register: [core] PdfViewEditorProvider
    const pdfViewEditorProvider = new PdfViewEditorProvider(context);
    context.subscriptions.push( ...pdfViewEditorProvider.triggers );

    // Register: [compile] CompileManager on Statusbar
    const compileManager = new CompileManager(remoteFileSystemProvider);
    context.subscriptions.push( ...compileManager.triggers );

    // Register: [intellisense] LangIntellisenseProvider
    const langIntellisenseProvider = new LangIntellisenseProvider(context, remoteFileSystemProvider);
    context.subscriptions.push( ...langIntellisenseProvider.triggers );

    // Register: [scm] "Sync Local Replica Now", which tools can also ask for (src/scm/replicaControl.ts)
    context.subscriptions.push(
        vscode.commands.registerCommand(`${ROOT_NAME}.localReplica.syncNow`, () => LocalReplicaSCMProvider.syncNowCommand()),
    );

    // Recognize the local project and show its commands before its network connection starts.
    const projectContexts = new ProjectContexts(async uri => {
        const vfs = await remoteFileSystemProvider.prefetch(uri);
        await vfs.init();
    });
    context.subscriptions.push(projectContexts);
    return projectContexts.ready;
}

export function deactivate() {
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activate`, false);
    vscode.commands.executeCommand('setContext', `${ROOT_NAME}.activateCompile`, false);
}
