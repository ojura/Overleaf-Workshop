/* eslint-disable @typescript-eslint/naming-convention -- VS Code API names */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { loadWithVscode } from './standIn';

class Uri {
    readonly scheme = 'overleaf-workshop';
    constructor(readonly path: string, readonly query = 'user=u&project=p', readonly authority = 'server') {}
    with(change: { path?: string }) { return new Uri(change.path ?? this.path, this.query, this.authority); }
    toString() { return this.scheme + '://' + this.authority + this.path + '?' + this.query; }
    static joinPath(base: Uri, ...parts: string[]) { return base.with({ path: path.posix.join(base.path, ...parts) }); }
}
class Position { constructor(readonly line: number, readonly character: number) {} }
class Range {
    readonly start: Position; readonly end: Position;
    constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
        this.start = typeof a === 'number' ? new Position(a, b as number) : a;
        this.end = typeof a === 'number' ? new Position(c!, d!) : b as Position;
    }
}
class MarkdownString {
    value = ''; isTrusted = false;
    appendMarkdown(text: string) { this.value += text; return this; }
}
function parseUri(uri: Uri) {
    const query = new URLSearchParams(uri.query), projectName = decodeURIComponent(uri.path.split('/')[1]);
    return { serverName: uri.authority, projectName, pathParts: uri.path.split('/').slice(2),
        identifier: query.get('user') + '/' + query.get('project') + '/' + projectName };
}
const identity = (uri: Uri) => { const parsed = parseUri(uri); return parsed.serverName + '/' + parsed.identifier; };
function document(uri: Uri, text: string) {
    const offsetAt = (position: Position) => text.split('\n').slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
    const positionAt = (offset: number) => {
        const before = text.slice(0, offset).split('\n');
        return new Position(before.length - 1, before.at(-1)!.length);
    };
    return { uri, offsetAt, positionAt, languageId: uri.path.endsWith('.bib') ? 'bibtex' : 'latex',
        lineAt: (line: number) => ({ text: text.split('\n')[line] ?? '' }),
        getText: (range?: Range) => range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text,
        getWordRangeAtPosition(position: Position, regex: RegExp) {
            const pattern = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
            for (const match of text.matchAll(pattern)) {
                if (offsetAt(position) >= match.index! && offsetAt(position) <= match.index! + match[0].length) {
                    return new Range(positionAt(match.index!), positionAt(match.index! + match[0].length));
                }
            }
            return undefined;
        },
    };
}

function fixture() {
    const files = new Map<string, Map<string, string>>();
    const reads: string[] = [];
    const workspace = { textDocuments: [] as ReturnType<typeof document>[],
        getConfiguration: () => ({ get: (_key: string, value: unknown) => value }),
        fs: { readFile: async () => Buffer.from('[]') } };
    const window = { activeTextEditor: undefined as { document: ReturnType<typeof document> } | undefined };
    const registrations: unknown[] = [];
    const vscode = {
        Uri, Position, Range, MarkdownString,
        Hover: class { constructor(readonly contents: MarkdownString, readonly range?: Range) {} },
        CompletionItem: class { constructor(readonly label: string, readonly kind: number) {} },
        CompletionItemKind: { Reference: 18 },
        DocumentSymbol: class { children: unknown[] = []; constructor(readonly name: string, readonly detail: string, readonly kind: number, readonly range: Range, readonly selectionRange: Range) {} },
        SymbolKind: { Struct: 22, Package: 3, Number: 15, File: 0, Class: 4, Constant: 13, String: 14 },
        Disposable: class { dispose() {} }, EventEmitter: class {},
        TreeItem: class {}, workspace, window,
        languages: { registerHoverProvider: (selector: unknown, provider: unknown) => {
            const registration = { selector, provider }; registrations.push(registration);
            return { dispose: () => registrations.splice(registrations.indexOf(registration), 1) };
        } },
    };
    const vfsm = { prefetch: async (uri: Uri) => ({
        getRootDocName: () => '/main.tex',
        pathToUri: (name: string) => uri.with({ path: '/Book/' + name.replace(/^\//, '') }),
        openFile: async (target: Uri) => {
            reads.push(target.toString());
            const text = files.get(identity(target))?.get(parseUri(target).pathParts.join('/'));
            if (text === undefined) { throw new Error('Missing fixture file: ' + target.toString()); }
            return new TextEncoder().encode(text);
        },
    }) };
    const loaded = loadWithVscode(vscode, () => ({
        ...require('../intellisense/langCompletionProvider'),
        ...require('../intellisense/texDocumentSymbolProvider'),
        ...(['.js', '.ts'].some(extension => fs.existsSync(path.join(__dirname, '../intellisense/citationHoverProvider' + extension)))
            ? require('../intellisense/citationHoverProvider') : {}),
    }), { '../core/remoteFileSystemProvider': { parseUri } });
    const symbols = new loaded.TexDocumentSymbolProvider(vfsm);
    const completion = new loaded.ReferenceCompletionProvider(vfsm, symbols);
    const hover = loaded.CitationHoverProvider && new loaded.CitationHoverProvider(vfsm, symbols);
    async function project(id: string, bibliography: string, content: string, authority = 'server', prewarm = true) {
        const uri = new Uri('/Book/main.tex', 'user=u&project=' + id, authority);
        const main = document(uri, '\\bibliography{' + bibliography.replace(/\.bib$/, '') + '}\n\\cite{');
        files.set(identity(uri), new Map([['main.tex', main.getText()], [bibliography, content]]));
        window.activeTextEditor = { document: main };
        if (prewarm) { await symbols.provideDocumentSymbols(main); }
        return main;
    }
    const token = () => ({ isCancellationRequested: false });
    return { files, reads, workspace, window, registrations, symbols, hover, project, token,
        async complete(main: ReturnType<typeof document>) {
            return completion.provideCompletionItems(main, main.positionAt(main.getText().length), token(), {});
        },
    };
}

describe('citation metadata and project-scoped hover', () => {
    it('enriches existing citation completion with nested titles, authors, venue and a numeric bare year', async () => {
        const f = fixture();
        const main = await f.project('p', 'references.bib', '@article{paper,\n title = {A {Nested} Title},\n author = "Ada and Grace",\n year = 2024,\n journal = {Robotics}\n}');
        const [item] = await f.complete(main);
        assert.strictEqual(item.label, 'paper');
        assert.match(item.detail ?? '', /Ada and Grace.*2024/);
        assert.match(item.documentation?.value ?? '', /A Nested Title/);
        assert.match(item.documentation.value, /Robotics/);
        assert.strictEqual(item.documentation.isTrusted, false);
    });

    it('keeps completed and incomplete editable BibTeX keys in the current completion path', async () => {
        const f = fixture();
        const main = await f.project('p', 'references.bib', '@article{complete, title={Ready}}\n@book{editing,\n title = {Still editing\n\n@article{later, title={Ready after the edit}, year=2025}');
        const items = await f.complete(main);
        assert.deepStrictEqual(items.map((item: any) => item.label), ['complete', 'editing', 'later']);
        assert.match(items[2].detail ?? '', /2025/);
    });

    it('escapes authored Markdown characters and keeps quoted or braced years readable', async () => {
        const f = fixture();
        const main = await f.project('p', 'references.bib', '@book{book, title={A [link](command:unsafe) and {B}}, year="2023"}\n@article{other, year={2022}}');
        const items = await f.complete(main);
        assert.match(items[0].documentation?.value ?? '', /A \\\[link\\\]\\\(command:unsafe\\\) and B/);
        assert.match(items[0].detail ?? '', /2023/);
        assert.match(items[1].detail ?? '', /2022/);
        assert.strictEqual(items[0].documentation.isTrusted, false);
    });

    it('uses the requested document bibliography after focus changes between same-name projects and servers', async () => {
        const f = fixture();
        const first = await f.project('first', 'first.bib', '@article{firstKey, title={First}}');
        const second = await f.project('second', 'second.bib', '@article{secondKey, title={Second}}');
        const otherServer = await f.project('first', 'third.bib', '@article{thirdKey, title={Third}}', 'another-server');
        f.window.activeTextEditor = { document: second };
        assert.deepStrictEqual((await f.complete(first)).map((item: any) => item.label), ['firstKey']);
        assert.deepStrictEqual((await f.complete(second)).map((item: any) => item.label), ['secondKey']);
        assert.deepStrictEqual((await f.complete(otherServer)).map((item: any) => item.label), ['thirdKey']);
    });

    it('resolves cold completion and hover from current unsaved source and bibliography documents', async () => {
        const results: unknown[] = [];
        for (const operation of ['completion', 'hover']) {
            const f = fixture();
            const main = await f.project('p', 'saved.bib', '@article{savedKey, title={Saved}}', 'server', false);
            const files = f.files.get(identity(main.uri))!;
            files.set('chapter.tex', '\\bibliography{saved}');
            files.set('draft.bib', '@article{draftKey, title={Saved draft}}');
            f.workspace.textDocuments.push(
                document(main.uri.with({ path: '/Book/chapter.tex' }), '\\bibliography{draft}\n\\input{main}'),
                document(main.uri.with({ path: '/Book/draft.bib' }), '@article{draftKey, title={Unsaved draft}, year=2026}'),
            );
            const source = document(main.uri, '\\input{chapter}\n\\cite{' + (operation === 'hover' ? 'draftKey}' : ''));
            if (operation === 'completion') {
                const items = await f.complete(source);
                results.push(items.map((item: any) => ({ key: item.label, unsaved: /Unsaved draft/.test(item.documentation?.value ?? '') })));
            } else {
                const result = await f.hover.provideHover(source, source.positionAt(source.getText().indexOf('draftKey') + 1), f.token());
                results.push({ unsaved: /Unsaved draft/.test(result?.contents.value ?? ''), key: result && source.getText(result.range) });
            }
        }
        assert.deepStrictEqual(results, [[{ key: 'draftKey', unsaved: true }], { unsaved: true, key: 'draftKey' }]);
    });

    it('shows metadata for the hovered comma-separated key from its source project', async () => {
        const f = fixture();
        const first = await f.project('first', 'first.bib', '@article{one, title={First title}, year=2024}\n@article{two, title={Second title}, author={Author}}');
        await f.project('second', 'second.bib', '@article{two, title={Wrong project}}');
        assert.ok(f.hover, 'citation hover is available alongside citation completion');
        const source = document(first.uri, '\\bibliography{first}\n\\cite[see][p. 2]{one, two}');
        const result = await f.hover.provideHover(source, source.positionAt(source.getText().indexOf('two') + 1), f.token());
        assert.match(result?.contents.value ?? '', /Second title/);
        assert.doesNotMatch(result.contents.value, /Wrong project/);
        assert.strictEqual(result.contents.isTrusted, false);
        assert.strictEqual(source.getText(result.range), 'two');
    });

    it('ignores commented citations and cancellation before bibliography reads', async () => {
        const f = fixture();
        const main = await f.project('p', 'references.bib', '@article{key, title={Title}}');
        assert.ok(f.hover, 'citation hover is available');
        const before = f.reads.length;
        const commented = document(main.uri, '% \\cite{key}');
        assert.strictEqual(await f.hover.provideHover(commented, new Position(0, 9), f.token()), undefined);
        const cancelled = { isCancellationRequested: true };
        const citation = document(main.uri, '\\cite{key}');
        assert.strictEqual(await f.hover.provideHover(citation, new Position(0, 7), cancelled), undefined);
        assert.strictEqual(f.reads.length, before);
    });

    it('preserves the existing bbl key fallback when no bibliography has entries', async () => {
        const f = fixture();
        const main = await f.project('p', 'references.bib', '');
        f.files.get(identity(main.uri))!.set('.output/output.bbl', '\\bibitem{compiled-key}');
        assert.deepStrictEqual((await f.complete(main)).map((item: any) => item.label), ['compiled-key']);
    });
});
