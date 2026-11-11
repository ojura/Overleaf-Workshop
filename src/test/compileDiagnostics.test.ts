/* eslint-disable @typescript-eslint/naming-convention -- VS Code API names */
import * as assert from 'assert';
import { loadWithVscode, strict } from './standIn';

const disposable = { dispose() {} };
class FileSystemError extends Error { constructor(readonly code: string) { super(code); } }
const handlers = new Map<string, (...args: any[]) => any>();
let clears = 0;
const standIn = strict('vscode', {
    Disposable: class { dispose() {} }, TreeItem: class {}, QuickPickItem: class {},
    EventEmitter: class { event = () => disposable; fire() {} dispose() {} },
    MarkdownString: class {}, ThemeColor: class {}, FileSystemError,
    l10n: { t: (message: string) => message },
    workspace: { getConfiguration: () => ({ get: (_key: string, value: unknown) => value }) },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    languages: { createDiagnosticCollection: () => ({ clear() { clears++; }, set() {}, dispose() {} }) },
    commands: { registerCommand: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); return disposable; } },
});
const { CompileDiagnosticProvider } = loadWithVscode(standIn, () => require('../compile/compileManager'));

describe('compile diagnostics output availability', () => {
    async function check(read: () => Promise<Uint8Array>) {
        const provider = new CompileDiagnosticProvider({ prefetch: async () => ({ pathToUri: (...parts: string[]) => parts.join('/'), openFile: read }) });
        const owned = provider.triggers;
        try { return await handlers.get('overleaf-workshop.compileManager.compileErrorCheck')!({}); }
        finally { owned.forEach((resource: any) => resource.dispose()); handlers.clear(); }
    }
    it('handles an absent output log without inventing a compile error', async () => {
        const before = clears;
        const result = await check(async () => { throw new FileSystemError('FileNotFound'); });
        assert.strictEqual(result, false);
        assert.strictEqual(clears, before + 1);
    });
    it('preserves unexpected output read failures', async () => {
        const failure = new Error('permission denied');
        await assert.rejects(check(async () => { throw failure; }), (error: unknown) => error === failure);
    });
});
