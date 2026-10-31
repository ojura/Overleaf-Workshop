import * as vscode from 'vscode';
import {EventEmitter} from 'events';
import { PdfDocument } from '../core/pdfViewEditorProvider';
import type { CompileOutcome } from '../core/projectBuilds';
import type { BuildStatus } from '../core/viewerProtocol';
import { StatusInfo } from '../scm';

export type Events = {
    'fileWillOpenEvent': {uri: vscode.Uri},
    'pdfWillOpenEvent': {uri: vscode.Uri, doc:PdfDocument, webviewPanel:vscode.WebviewPanel},
    'spellCheckLanguageUpdateEvent': {language:string},
    'compilerUpdateEvent': {compiler:string},
    'rootDocUpdateEvent': {rootDocId:string},
    'scmStatusChangeEvent': {status:StatusInfo},
    'socketioConnectedEvent': {publicId:string},
    /**
     * the build in use of the project at `uri` changed (VirtualFileSystem.builds): to this
     * window's compile, or to another client's from Overleaf's cache when `fromCache`
     */
    'buildChangedEvent': {uri: vscode.Uri, fromCache: boolean},
    /** what the viewers of the build of the project at `uri` show changed (ProjectBuilds.status) */
    'buildStatusEvent': {uri: vscode.Uri, status: BuildStatus},
    /** a compile of the project at `uri` ended (CompileManager.compile) */
    'compileEndedEvent': {uri: vscode.Uri, outcome: CompileOutcome},
};

export class EventBus {
    private static _eventEmitter = new EventEmitter();

    static fire<T extends keyof Events>(eventName: T, arg: Events[T]): void {
        EventBus._eventEmitter.emit(eventName, arg);
    }

    static on<T extends keyof Events>(eventName: T, cb: (arg: Events[T]) => void): vscode.Disposable {
        EventBus._eventEmitter.on(eventName, cb);
        const disposable = {
            dispose: () => { EventBus._eventEmitter.removeListener(eventName, cb); }
        };
        return disposable;
    }
}
