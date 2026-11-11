import * as vscode from 'vscode';
import { ROOT_NAME } from '../consts';
import { RemoteFileSystemProvider, parseUri } from '../core/remoteFileSystemProvider';

import { withoutTexComments } from './texSource';

function project(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== ROOT_NAME) { return; }
    const { serverName, identifier, userId, projectId } = parseUri(uri);
    return userId && projectId ? JSON.stringify([serverName, identifier]) : undefined;
}

export class ReferenceDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private readonly vfsm: RemoteFileSystemProvider) {}

    async provideDefinition(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Location | undefined> {
        const identity = project(document.uri);
        if (!identity || token.isCancellationRequested) { return; }
        const source = withoutTexComments(document.getText()), offset = document.offsetAt(position);
        const commands = /(?<!\\)\\[A-Za-z]*ref\*?(?:\s*\[[^\]]*\])*\s*\{([^}]*)\}/g;
        let label: string | undefined;
        for (const match of source.matchAll(commands)) {
            const start = match.index! + match[0].lastIndexOf('{') + 1;
            for (const value of match[1].matchAll(/[^,\s]+/g)) {
                const first = start + value.index!;
                if (offset >= first && offset <= first + value[0].length) { label = value[0]; break; }
            }
            if (label) { break; }
        }
        if (!label) { return; }
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp('(?<!\\\\)\\\\label(?:\\s*\\[[^\\]]*\\])?\\s*\\{\\s*(' + escaped + ')\\s*\\}', 'g');
        const locate = (candidate: vscode.TextDocument) => {
            if (token.isCancellationRequested) { return; }
            const match = pattern.exec(withoutTexComments(candidate.getText()));
            pattern.lastIndex = 0;
            if (!match) { return; }
            const start = match.index + match[0].indexOf('{') + 1 + match[0].slice(match[0].indexOf('{') + 1).search(/\S/);
            return new vscode.Location(candidate.uri, new vscode.Range(candidate.positionAt(start), candidate.positionAt(start + label!.length)));
        };
        const visited = new Set<string>();
        const open = [document, ...vscode.workspace.textDocuments.filter(item => item !== document && project(item.uri) === identity && /\.tex$/i.test(item.uri.path))];
        for (const candidate of open) {
            visited.add(candidate.uri.toString());
            const found = locate(candidate);
            if (found || token.isCancellationRequested) { return found; }
        }
        const vfs = await this.vfsm.prefetch(document.uri);
        if (token.isCancellationRequested) { return; }
        for (const { path } of vfs.walk(entity => /\.tex$/i.test(entity.name))) {
            if (token.isCancellationRequested) { return; }
            const uri = vfs.pathToUri(...path.split('/').filter(Boolean));
            if (project(uri) !== identity || visited.has(uri.toString())) { continue; }
            const candidate = await vscode.workspace.openTextDocument(uri);
            if (token.isCancellationRequested) { return; }
            const found = locate(candidate);
            if (found) { return found; }
        }
    }

    get triggers(): vscode.Disposable[] {
        return [vscode.languages.registerDefinitionProvider({ scheme: ROOT_NAME, pattern: '**/*.{tex,txt}' }, this)];
    }
}
