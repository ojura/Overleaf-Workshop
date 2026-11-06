import * as vscode from 'vscode';
import { IntellisenseProvider } from '.';
import { ROOT_NAME } from '../consts';
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import { EventBus } from '../utils/eventBus';

interface SpellingCache {
    language: string;
    learned: Set<string>;
    suggestions: Map<string, string[]>;
}

export class MisspellingCheckProvider extends IntellisenseProvider implements vscode.CodeActionProvider {
    private readonly caches = new Map<string, SpellingCache>();
    private readonly requests = new Map<string, symbol>();
    private disposed = false;
    private diagnosticCollection = vscode.languages.createDiagnosticCollection(ROOT_NAME);
    protected readonly contextPrefix = [];

    private key(uri: vscode.Uri) { return uri.authority + '?' + uri.query; }

    private splitText(text: string) {
        return text.split(/([\P{L}\p{N}]*\\[a-zA-Z]*|[\P{L}\p{N}]+)/gu);
    }

    private async cacheFor(uri: vscode.Uri): Promise<{ vfs: VirtualFileSystem; cache: SpellingCache }> {
        const vfs = await this.vfsm.prefetch(uri);
        const language = vfs.getSpellCheckLanguage()?.code ?? '';
        const key = this.key(uri);
        let cache = this.caches.get(key);
        if (!cache || cache.language !== language) {
            cache = { language, learned: new Set(vfs.getDictionary()), suggestions: new Map() };
            if (!this.disposed) { this.caches.set(key, cache); }
        }
        return { vfs, cache };
    }

    private async check(uri: vscode.Uri, text: string): Promise<SpellingCache | undefined> {
        const {vfs, cache} = await this.cacheFor(uri);
        if (this.disposed) { return undefined; }
        const words = [...new Set(this.splitText(text).filter((word, i) => i % 2 === 0 && word.length > 1
            && !cache.suggestions.has(word) && !cache.learned.has(word)))];
        if (!words.length) { return cache; }
        const misspellings = await vfs.spellCheck(uri, words);
        if (this.disposed || this.caches.get(this.key(uri)) !== cache) { return undefined; }
        // An unavailable spell service has not certified any word as correct.
        if (misspellings === undefined) { return cache; }
        const correct = new Set(words);
        for (const {index, suggestions} of misspellings) {
            const word = words[index];
            if (word === undefined) { continue; }
            correct.delete(word);
            cache.suggestions.set(word, suggestions);
        }
        correct.forEach(word => cache.learned.add(word));
        if (cache.suggestions.size > 1000) {
            [...cache.suggestions.keys()].slice(0, cache.suggestions.size - 900).forEach(word => cache.suggestions.delete(word));
        }
        return cache;
    }

    private async updateDocument(document: vscode.TextDocument, changedText = document.getText()) {
        if (this.disposed || document.uri.scheme !== ROOT_NAME) { return; }
        const key = document.uri.toString();
        const request = Symbol();
        const version = document.version;
        this.requests.set(key, request);
        const cache = await this.check(document.uri, changedText);
        if (!cache || this.disposed || this.requests.get(key) !== request || document.version !== version
            || this.caches.get(this.key(document.uri)) !== cache) { return; }
        const diagnostics: vscode.Diagnostic[] = [];
        for (let line = 0; line < document.lineCount; line++) {
            let offset = 0;
            this.splitText(document.lineAt(line).text).forEach((word, index) => {
                if (index % 2 === 0 && cache.suggestions.has(word)) {
                    const range = new vscode.Range(line, offset, line, offset + word.length);
                    const diagnostic = new vscode.Diagnostic(range, vscode.l10n.t('{word}: Unknown word.', {word}), vscode.DiagnosticSeverity.Information);
                    diagnostic.source = vscode.l10n.t('Spell Checker'); diagnostic.code = word;
                    diagnostics.push(diagnostic);
                }
                offset += word.length;
            });
        }
        this.diagnosticCollection.set(document.uri, diagnostics);
    }

    private invalidate(uri: vscode.Uri, account: boolean) {
        const target = parseUri(uri);
        const matches = (candidate: vscode.Uri) => candidate.authority === uri.authority
            && (account ? parseUri(candidate).userId === target.userId : this.key(candidate) === this.key(uri));
        for (const key of this.caches.keys()) {
            const [authority, query] = key.split('?');
            if (key === this.key(uri) || account && authority === uri.authority && new URLSearchParams(query).get('user') === target.userId) {
                this.caches.delete(key);
            }
        }
        const documents = vscode.workspace.textDocuments.filter(document => document.uri.scheme === ROOT_NAME && matches(document.uri));
        for (const document of documents) {
            this.diagnosticCollection.delete(document.uri);
            void this.updateDocument(document).catch(error => console.warn('Overleaf spell refresh failed:', error));
        }
    }

    provideCodeActions(document: vscode.TextDocument, _range: vscode.Range, context: vscode.CodeActionContext, _token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeAction[]> {
        if (!context.diagnostics.length) { return []; }
        const diagnostic = context.diagnostics[0];
        const suggestions = this.caches.get(this.key(document.uri))?.suggestions.get(diagnostic.code as string) ?? [];
        const actions = suggestions.slice(0, 8).map(suggestion => {
            const action = new vscode.CodeAction(suggestion, vscode.CodeActionKind.QuickFix);
            action.diagnostics = [diagnostic];
            action.edit = new vscode.WorkspaceEdit();
            action.edit.replace(document.uri, diagnostic.range, suggestion);
            return action;
        });
        const learn = new vscode.CodeAction(vscode.l10n.t('Add to Dictionary'), vscode.CodeActionKind.QuickFix);
        learn.diagnostics = [diagnostic];
        learn.command = { title: learn.title, command: 'langIntellisense.learnSpelling', arguments: [document.uri, diagnostic.code as string] };
        actions.push(learn);
        return actions;
    }

    async learnSpelling(uri: vscode.Uri, word: string) {
        const vfs = await this.vfsm.prefetch(uri);
        // VFS publishes dictionary invalidation only after the server accepted the change.
        await vfs.spellLearn(word);
    }

    async dictionarySettings(vfs: VirtualFileSystem) {
        await vfs.refreshSettings();
        while (!this.disposed) {
            const word = await vscode.window.showQuickPick(vfs.getDictionary() ?? [], {
                canPickMany: false, placeHolder: vscode.l10n.t('Select a word to unlearn'),
            });
            if (!word || this.disposed) { return; }
            if (!await vfs.spellUnlearn(word)) { return; }
        }
    }

    async spellCheckSettings() {
        const uri = vscode.workspace.workspaceFolders?.[0].uri;
        const vfs = uri && await this.vfsm.prefetch(uri);
        if (!vfs || this.disposed) { return; }
        await vfs.refreshSettings();
        const languages = vfs.getAllSpellCheckLanguages();
        const currentLanguage = vfs.getSpellCheckLanguage();
        const items: Array<vscode.QuickPickItem & {id?: string}> = [
            { id: 'dictionary', label: vscode.l10n.t('Manage Dictionary'), iconPath: new vscode.ThemeIcon('book') },
            { label: '', kind: vscode.QuickPickItemKind.Separator },
            ...(languages ?? []).map(item => ({ label: item.name, description: item.code, picked: item.code === currentLanguage?.code })),
        ];
        const option = await vscode.window.showQuickPick(items, {
            placeHolder: vscode.l10n.t('Select spell check language'), canPickMany: false, ignoreFocusOut: true,
            matchOnDescription: true, matchOnDetail: true,
        });
        if (this.disposed) { return; }
        if (option?.id === 'dictionary') { await this.dictionarySettings(vfs); }
        else if (option) { await vfs.updateSettings({ spellCheckLanguage: option.description }); }
    }

    dispose() {
        this.disposed = true; this.caches.clear(); this.requests.clear(); this.diagnosticCollection.dispose();
    }

    get triggers(): vscode.Disposable[] {
        return [
            this,
            vscode.languages.registerCodeActionsProvider(this.selector, this),
            vscode.commands.registerCommand('langIntellisense.learnSpelling', (uri: vscode.Uri, word: string) => this.learnSpelling(uri, word)),
            vscode.commands.registerCommand('langIntellisense.settings', () => this.spellCheckSettings()),
            EventBus.on('projectStateChangedEvent', ({uri, kind}) => {
                if (kind === 'dictionary' || kind === 'joined' || kind === 'settings') { this.invalidate(uri, kind === 'dictionary'); }
            }),
            vscode.workspace.onDidOpenTextDocument(document => this.updateDocument(document)),
            vscode.workspace.onDidChangeTextDocument(async event => {
                if (event.document.uri.scheme !== ROOT_NAME || !event.contentChanges.length) { return; }
                const lines = new Set<number>();
                for (const change of event.contentChanges) {
                    const end = Math.min(event.document.lineCount - 1, change.range.start.line + change.text.split('\n').length);
                    for (let line = Math.max(0, change.range.start.line - 1); line <= end; line++) { lines.add(line); }
                }
                await this.updateDocument(event.document, [...lines].map(line => event.document.lineAt(line).text).join(' '));
            }),
            vscode.workspace.onDidCloseTextDocument(document => {
                this.requests.delete(document.uri.toString());
                this.diagnosticCollection.delete(document.uri);
            }),
        ];
    }
}
