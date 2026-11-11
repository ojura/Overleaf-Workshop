import * as vscode from 'vscode';
import { IntellisenseProvider } from '.';
import { RemoteFileSystemProvider } from '../core/remoteFileSystemProvider';
import { TexDocumentSymbolProvider } from './texDocumentSymbolProvider';
import { citationMarkdown, readCitationEntries } from './citationMetadata';
import { withoutTexComments } from './texSource';

function citationAt(document: vscode.TextDocument, position: vscode.Position): { key: string; range: vscode.Range } | undefined {
    const source = withoutTexComments(document.getText());
    const offset = document.offsetAt(position);
    const commands = /(?<!\\)\\(?:cite\w*|\w*cite)\*?(?:\s*\[[^\]]*\])*\s*\{([^}]*)\}/g;
    for (const match of source.matchAll(commands)) {
        const start = match.index! + match[0].lastIndexOf('{') + 1;
        for (const value of match[1].matchAll(/[^,\s]+/g)) {
            const first = start + value.index!;
            if (offset >= first && offset < first + value[0].length) {
                return { key: value[0], range: new vscode.Range(document.positionAt(first), document.positionAt(first + value[0].length)) };
            }
        }
    }
    return undefined;
}

export class CitationHoverProvider extends IntellisenseProvider implements vscode.HoverProvider {
    protected readonly contextPrefix = [];

    constructor(vfsm: RemoteFileSystemProvider, private readonly texSymbolProvider: TexDocumentSymbolProvider) { super(vfsm); }

    async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
        if (token.isCancellationRequested) { return; }
        const citation = citationAt(document, position);
        if (!citation) { return; }
        const vfs = await this.vfsm.prefetch(document.uri);
        if (token.isCancellationRequested) { return; }
        const paths = await this.texSymbolProvider.bibPathsFor(document, token);
        const entries = await readCitationEntries(vfs, paths, token);
        if (token.isCancellationRequested) { return; }
        const entry = entries.find(item => item.key === citation.key);
        return entry ? new vscode.Hover(citationMarkdown(entry), citation.range) : undefined;
    }

    get triggers(): vscode.Disposable[] {
        return [vscode.languages.registerHoverProvider({ ...this.selector, pattern: '**/*.{tex,txt}' }, this)];
    }
}
