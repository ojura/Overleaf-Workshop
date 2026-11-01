/* eslint-disable @typescript-eslint/naming-convention -- mirrors the 'vscode' and the modules' export names */
import * as assert from 'assert';
import { loadWithVscode } from './standIn';
import { Uri, withStubs } from './replicaTestWorld';

// The collection of a project's source controls (src/scm/scmCollectionProvider.ts) starts the
// source controls that the project's settings name, e.g. a local replica.
describe('the collection of a project\'s source controls', () => {
    it('says why a source control did not start, in one notice', async () => {
        const notices: string[] = [];
        let noticed!: () => void;
        const noticeShown = new Promise<void>(resolve => { noticed = resolve; });
        class TestUri extends Uri {
            static parse(text: string) { return new TestUri('file', text); }
        }
        const vscode = withStubs({
            Uri: TestUri,
            Disposable: class {
                constructor(private readonly onDispose?: () => void) {}
                dispose() { this.onDispose?.(); }
            },
            StatusBarAlignment: { Left: 1 },
            l10n: { t: (message: string, args?: any) => message.replace(/\{(\w+)\}/g, (_m, k) => String(args?.[k])) },
            window: withStubs({
                showErrorMessage: async (message: string) => { notices.push(message); noticed(); return undefined; },
                createStatusBarItem: () => withStubs({}),
            }),
        });
        // a local replica that fails to start, as when its temporary folder cannot be read
        const failure = Object.assign(new Error('EACCES: permission denied, scandir \'/replica/.overleaf/tmp\''), { code: 'EACCES' });
        class FailingReplica {
            static label = 'Local Replica';
            readonly triggers = Promise.reject(failure);
        }
        const { SCMCollectionProvider } = loadWithVscode(vscode, () => require('../scm/scmCollectionProvider'), {
            './localReplicaSCM': { LocalReplicaSCMProvider: FailingReplica },
            // its refresh timer would keep the test's process alive
            './historyViewProvider': { HistoryViewProvider: class {} },
            '../utils/globalStateManager': {
                GlobalStateManager: { getServerProjectSCMPersists: () => ({ replica: { label: 'Local Replica', baseUri: '/replica', enabled: true } }) },
            },
        });
        const vfs = { serverName: 'www.overleaf.com', projectId: 'p', origin: new TestUri('overleaf-workshop', '/project') };
        const collection = new SCMCollectionProvider(vfs, {});
        try {
            await noticeShown;
            assert.strictEqual(notices.length, 1, JSON.stringify(notices));
            assert.ok(notices[0].includes(failure.message), notices[0]);
        } finally {
            collection.dispose();
        }
    });
});
