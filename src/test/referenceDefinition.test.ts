/* eslint-disable @typescript-eslint/naming-convention -- VS Code API names */
import * as assert from 'assert';
import { loadWithVscode } from './standIn';
class Position { constructor(readonly line: number, readonly character: number) {} }
class Range { constructor(readonly start: Position, readonly end: Position) {} }
class Location { constructor(readonly uri: any, readonly range: Range) {} }
const workspace = { textDocuments: [] as any[], openTextDocument: async (_uri: any): Promise<any> => { throw new Error('unexpected read'); }, getConfiguration: () => ({ get: (_key: string, value: unknown) => value }) };
const { ReferenceDefinitionProvider } = loadWithVscode({ workspace, Position, Range, Location }, () => require('../intellisense/referenceDefinitionProvider'), {
    '../core/remoteFileSystemProvider': { parseUri: (value: any) => {
        const query = new URLSearchParams(value.query), userId = query.get('user'), projectId = query.get('project');
        return { serverName: value.authority, userId, projectId, identifier: userId + '/' + projectId + '/' + value.path.split('/')[1] };
    } },
});
function uri(path: string, project = 'p') { return { scheme: 'overleaf-workshop', authority: 'server', path, query: 'user=u&project=' + project, toString() { return this.authority + this.path + '?' + this.query; } }; }
function doc(path: string, text: string, project = 'p') {
    const offsetAt = (p: Position) => text.split('\n').slice(0, p.line).reduce((n, line) => n + line.length + 1, 0) + p.character;
    const positionAt = (offset: number) => { const before = text.slice(0, offset).split('\n'); return new Position(before.length - 1, before.at(-1)!.length); };
    return { uri: uri(path, project), offsetAt, positionAt,
        getText: (range?: Range) => range ? text.slice(offsetAt(range.start), offsetAt(range.end)) : text,
        getWordRangeAtPosition: (position: Position, regex: RegExp) => {
            const match = regex.exec(text);
            return match && offsetAt(position) >= match.index && offsetAt(position) <= match.index + match[0].length
                ? new Range(positionAt(match.index), positionAt(match.index + match[0].length)) : undefined;
        } };
}
const token = () => ({ isCancellationRequested: false });
describe('project-scoped reference definitions', () => {
    function fixture() {
        workspace.textDocuments = [];
        const files: any[] = []; let reads = 0;
        const provider = new ReferenceDefinitionProvider({ prefetch: async () => ({ walk: () => files.map(file => ({ path: file.uri.path })), pathToUri: (...parts: string[]) => uri('/' + parts.join('/')) }) });
        workspace.openTextDocument = async target => { reads++; return files.find(file => file.uri.toString() === target.toString()); };
        return { provider, files, reads: () => reads };
    }
    it('prefers the current unsaved document and selects the cursor token in comma references', async () => {
        const f = fixture(), d = doc('/book/main.tex', '\\ref{other, target}\n\\label{target}');
        workspace.textDocuments = [doc('/book/open.tex', '\\label{target}')];
        const found = await f.provider.provideDefinition(d, new Position(0, 15), token());
        assert.strictEqual(found.uri, d.uri); assert.strictEqual(found.range.start.line, 1); assert.strictEqual(f.reads(), 0);
    });
    it('ignores other projects and commented labels while retaining unsaved open labels', async () => {
        const f = fixture(), d = doc('/book/main.tex', '\\ref{target}');
        const correct = doc('/book/open.tex', '% \\label{target}\n\\label{target}');
        workspace.textDocuments = [doc('/other/main.tex', '\\label{target}', 'other'), correct];
        const found = await f.provider.provideDefinition(d, new Position(0, 7), token());
        assert.strictEqual(found.uri, correct.uri); assert.strictEqual(found.range.start.line, 1); assert.strictEqual(f.reads(), 0);
    });
    it('never falls back to stale saved content of an open document and ignores commented references', async () => {
        const f = fixture(), d = doc('/book/main.tex', '\\ref{target}');
        workspace.textDocuments = [doc('/book/open.tex', '% \\label{target}')];
        f.files.push(doc('/book/open.tex', '\\label{target}'));
        assert.strictEqual(await f.provider.provideDefinition(d, new Position(0, 7), token()), undefined);
        const commented = doc('/book/main.tex', '% \\ref{target}\n\\label{target}');
        assert.strictEqual(await f.provider.provideDefinition(commented, new Position(0, 9), token()), undefined);
        assert.strictEqual(f.reads(), 0);
    });
    it('stops after cancellation during a file read instead of returning or reading another file', async () => {
        const f = fixture(), d = doc('/book/main.tex', '\\ref{target}'), stop = token();
        f.files.push(doc('/book/first.tex', '\\label{target}'), doc('/book/second.tex', '\\label{target}'));
        let reads = 0;
        workspace.openTextDocument = async () => { reads++; stop.isCancellationRequested = true; return f.files[0]; };
        assert.strictEqual(await f.provider.provideDefinition(d, new Position(0, 7), stop), undefined);
        assert.strictEqual(reads, 1);
    });
});
