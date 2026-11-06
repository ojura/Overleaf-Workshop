/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' and the modules' export names */
import * as assert from 'assert';
import { loadWithVscode } from './standIn';
import { Uri, withStubs } from './replicaTestWorld';

// The collection of a project's source controls (src/scm/scmCollectionProvider.ts) starts the
// source controls that the project's settings name, e.g. a local replica.
describe('the collection of a project\'s source controls', () => {
    class TestUri extends Uri {
        static parse(text: string) { return new TestUri('file', text); }
    }
    // a local replica that fails to start, as when its temporary folder cannot be read
    const failure = Object.assign(new Error('EACCES: permission denied, scandir \'/replica/.overleaf/tmp\''), { code: 'EACCES' });
    class FailingReplica {
        static label = 'Local Replica';
        /** while set, making the replica throws it, as a provider that cannot be made */
        static fails?: Error;
        /** the provider's check of a new replica's path */
        static validate: (uri: string) => Promise<unknown> = async uri => TestUri.parse(uri);
        static start: () => Promise<Array<{dispose():void}>> = () => Promise.reject(failure);
        static validateBaseUri(uri: string) { return FailingReplica.validate(uri); }
        /** the input box for a new replica's path, where the user enters /replica and accepts */
        static get baseUriInputBox() {
            return { value: '/replica', activeItems: [], show() {}, hide() {}, onDidTriggerButton() {}, onDidAccept(accept: () => void) { accept(); } };
        }
        constructor() { if (FailingReplica.fails) { throw FailingReplica.fails; } }
        readonly scmKey = 'replica';
        readonly baseUri = TestUri.parse('/replica');
        /** the real replica's icon, vscode.ThemeIcon('folder-library') */
        readonly iconPath = { id: 'folder-library' };
        readonly settingItems = [];
        readonly status = { status: 'idle', message: '' };
        /** each access starts it, as the replica's own getter does */
        get triggers(): Promise<Array<{dispose():void}>> { return FailingReplica.start(); }
    }

    /**
     * The collection, for a project whose settings name the failing replica, enabled or not.
     * `answers` are the user's choices in the quick picks, in order; the notices are collected.
     * With `saveFails`, saving the project's settings throws it.
     */
    function collectionWith(enabled: boolean, answers: ((items: any[]) => any)[] = [], saveFails?: Error) {
        const notices: string[] = [];
        let noticed!: () => void;
        const noticeShown = new Promise<void>(resolve => { noticed = resolve; });
        const vscode = withStubs({
            Uri: TestUri,
            Disposable: class {
                constructor(private readonly onDispose?: () => void) {}
                dispose() { this.onDispose?.(); }
            },
            StatusBarAlignment: { Left: 1 },
            QuickPickItemKind: { Separator: -1 },
            l10n: { t: (message: string, args?: any) => message.replace(/\{(\w+)\}/g, (_m, k) => String(args?.[k])) },
            window: withStubs({
                showErrorMessage: async (message: string) => { notices.push(message); noticed(); return undefined; },
                showWarningMessage: async (message: string) => { notices.push(message); return undefined; },
                showQuickPick: async (items: any[]) => answers.shift()?.(items),
                createStatusBarItem: () => withStubs({}),
            }),
        });
        const { SCMCollectionProvider } = loadWithVscode(vscode, () => require('../scm/scmCollectionProvider'), {
            './localReplicaSCM': { LocalReplicaSCMProvider: FailingReplica },
            // its refresh timer would keep the test's process alive
            './historyViewProvider': { HistoryViewProvider: class { dispose() {} } },
            '../utils/globalStateManager': {
                GlobalStateManager: { getServerProjectSCMPersists: () => ({ replica: { label: 'Local Replica', baseUri: '/replica', enabled } }) },
            },
        });
        const persist = { label: 'Local Replica', baseUri: '/replica', enabled };
        /** the settings that the collection saved, in order */
        const saved: (typeof persist)[] = [];
        let disabled!: () => void;
        const savedDisabled = new Promise<void>(resolve => { disabled = resolve; });
        const vfs = {
            serverName: 'www.overleaf.com', projectId: 'p', origin: new TestUri('overleaf-workshop', '/project'),
            getProjectSCMPersist: () => ({ ...persist }),
            setProjectSCMPersist: (_key: string, value: typeof persist) => {
                if (saveFails) { throw saveFails; }
                Object.assign(persist, value);
                saved.push({ ...value });
                if (!value.enabled) { disabled(); }
            },
        };
        const collection = new SCMCollectionProvider(vfs, {});
        return { collection, notices, noticeShown, saved, savedDisabled };
    }

    it('says why a source control did not start, in one notice', async () => {
        const { collection, notices, noticeShown } = collectionWith(true);
        try {
            await noticeShown;
            assert.strictEqual(notices.length, 1, JSON.stringify(notices));
            assert.ok(notices[0].includes(failure.message), notices[0]);
        } finally {
            collection.dispose();
        }
    });

    it('says why a source control that the user enables did not start, and keeps it disabled', async () => {
        const { collection, notices, noticeShown, saved, savedDisabled } = collectionWith(false, [
            items => items.find(item => item.item !== undefined), // the replica
            items => items.find(item => item.label === 'Enable'),
        ]);
        try {
            collection.showSCMConfiguration();
            await noticeShown;
            assert.strictEqual(notices.length, 1, JSON.stringify(notices));
            assert.ok(notices[0].includes(failure.message), notices[0]);
            await savedDisabled;
            assert.deepStrictEqual(saved.map(value => value.enabled), [true, false], 'enabled for the start, then disabled again');
        } finally {
            collection.dispose();
        }
    });

    afterEach(() => {
        FailingReplica.fails = undefined;
        FailingReplica.validate = async uri => TestUri.parse(uri);
        FailingReplica.start = () => Promise.reject(failure);
    });

    it('releases a late replica start instead of installing it in a disposed project session', async () => {
        let resolve!: (triggers:Array<{dispose():void}>) => void;
        const late = new Promise<Array<{dispose():void}>>(done => { resolve = done; });
        const {collection, notices} = collectionWith(false);
        FailingReplica.start = () => late;
        let released = 0;
        const pending = (collection as any).createSCM(FailingReplica, TestUri.parse('/replica'));
        collection.dispose();
        resolve([{dispose:()=>{released++;}}]);
        assert.strictEqual(await pending, undefined);
        assert.strictEqual(released,1);
        assert.strictEqual((collection as any).scms.length,0);
        assert.deepStrictEqual(notices,[]);
    });

    it('shows only the provider\'s notice when the provider refuses the path of a new source control', async () => {
        const { collection, notices } = collectionWith(false);
        try {
            FailingReplica.validate = async () => {
                notices.push('Invalid Path.'); // the provider's own notice, which says why
                throw new Error('EACCES: permission denied, mkdir \'/replica\'');
            };
            await (collection as any).createNewSCM(FailingReplica);
            assert.deepStrictEqual(notices, ['Invalid Path.']);
        } finally {
            collection.dispose();
        }
    });

    it('says why a new source control could not be made, in a notice', async () => {
        const { collection, notices } = collectionWith(false);
        try {
            FailingReplica.fails = new Error('the provider cannot be made');
            await (collection as any).createNewSCM(FailingReplica);
            assert.deepStrictEqual(notices, ['"Local Replica" creation failed: the provider cannot be made']);
        } finally {
            collection.dispose();
        }
    });

    it('says why a source control of the project\'s settings could not be made when the window loads, in a notice', async () => {
        FailingReplica.fails = new Error('the provider cannot be made');
        const { collection, notices, noticeShown } = collectionWith(true);
        try {
            await noticeShown;
            assert.deepStrictEqual(notices, ['"Local Replica" creation failed: the provider cannot be made']);
        } finally {
            collection.dispose();
        }
    });

    it('says why the user\'s choice in the quick pick of a source control failed, in a notice', async () => {
        const unsaved = new Error('the project\'s settings cannot be saved');
        const { collection, notices, noticeShown, saved } = collectionWith(false, [
            items => items.find(item => item.item !== undefined), // the replica
            items => items.find(item => item.label === 'Enable'),
        ], unsaved);
        try {
            collection.showSCMConfiguration();
            await noticeShown;
            assert.deepStrictEqual(notices, [`"Local Replica": Enable failed: ${unsaved.message}`]);
            assert.deepStrictEqual(saved, [], 'nothing was saved');
        } finally {
            collection.dispose();
        }
    });
});
