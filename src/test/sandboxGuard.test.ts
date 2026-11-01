import * as assert from 'assert';
import type { CompileRequest } from '../api/base';
import {
    EntityType, GuardedSandbox, JoinedView, ProjectWriter, recordProblems, SandboxRecord,
    SandboxSafetyError, viewProblems,
} from '../sandbox/guard';

const SHARED = '5a5a5a5a5a5a5a5a5a5a5a5a';
const COPY = '6a0f0e7f1c2b3a4d5e6f7a8b';
const OTHER = '5f5f5f5f5f5f5f5f5f5f5f5f';
const USER = '5b5b5b5b5b5b5b5b5b5b5b5b';
const SOMEONE = '5d5d5d5d5d5d5d5d5d5d5d5d';

const record = (changes: Partial<SandboxRecord> = {}): SandboxRecord => ({
    version: 1,
    server: 'https://www.overleaf.com/',
    projectId: COPY,
    projectName: 'Book (sandbox)',
    ownerId: USER,
    source: { projectId: SHARED, projectName: 'Book' },
    createdAt: '2026-10-30T18:00:00.000Z',
    ...changes,
});

const privateView = (changes: Partial<JoinedView['project']> = {}, permissionsLevel = 'owner'): JoinedView => ({
    project: { _id: COPY, name: 'Book (sandbox)', owner: { _id: USER }, members: [], invites: [], publicAccesLevel: 'private', ...changes },
    permissionsLevel,
});

/** A server that records every call and answers joins with `views`, in turn. */
class FakeWriter implements ProjectWriter {
    calls: string[] = [];
    view: (projectId: string) => JoinedView = () => privateView();
    async join(projectId: string) { this.calls.push(`join ${projectId}`); return this.view(projectId); }
    async upload(projectId: string, folderId: string, name: string) { this.calls.push(`upload ${projectId} ${folderId} ${name}`); return { type: 'file', id: 'f1' }; }
    async addFolder(projectId: string, parentFolderId: string, name: string) { this.calls.push(`addFolder ${projectId} ${parentFolderId} ${name}`); return { id: 'd1' }; }
    async remove(projectId: string, type: EntityType, id: string) { this.calls.push(`remove ${projectId} ${type} ${id}`); }
    async updateSettings(projectId: string, settings: object) { this.calls.push(`settings ${projectId} ${JSON.stringify(settings)}`); }
    async clearOutput(projectId: string) { this.calls.push(`clearOutput ${projectId}`); }
    async compile(projectId: string, request: CompileRequest) { this.calls.push(`compile ${projectId} ${request.rootResourcePath}`); return { response: { status: 'success' } }; }
}

const writes = (guarded: GuardedSandbox) => [
    () => guarded.upload('root', 'main.tex', new Uint8Array([1])),
    () => guarded.addFolder('root', 'fig'),
    () => guarded.remove('doc', 'd9', '/old.tex'),
    () => guarded.updateSettings({ imageName: 'texlive-full:2025.1' }),
    () => guarded.clearOutput(),
    () => guarded.compile({ rootResourcePath: 'main.tex', draft: false, stopOnFirstError: false }),
];

describe('sandbox guard', () => {
    it('accepts the record of a copy this account made of this replica\'s project', () => {
        assert.deepStrictEqual(recordProblems(record(), SHARED, USER), []);
    });

    it('refuses a record that names the shared project, another replica\'s project, another account or no id', () => {
        assert.match(recordProblems(record({ projectId: SHARED }), SHARED, USER).join(), /the shared project itself/);
        assert.match(recordProblems(record({ source: { projectId: OTHER, projectName: 'x' } }), SHARED, USER).join(), /belongs to project/);
        assert.match(recordProblems(record({ ownerId: SOMEONE }), SHARED, USER).join(), /created by account/);
        assert.match(recordProblems(record({ projectId: 'not an id' }), SHARED, USER).join(), /not a project id/);
        assert.match(recordProblems({ ...record(), version: 2 } as any, SHARED, USER).join(), /format version/);
    });

    it('does not even construct with such a record', () => {
        const writer = new FakeWriter();
        assert.throws(() => new GuardedSandbox(writer, record({ projectId: SHARED }), SHARED, USER), SandboxSafetyError);
        assert.deepStrictEqual(writer.calls, []);
    });

    it('passes a private copy owned by this account', () => {
        assert.deepStrictEqual(viewProblems(privateView(), COPY, 'Book (sandbox)', USER), []);
    });

    it('finds every way in which the copy is not private, or not the recorded one', () => {
        const problems = (view: JoinedView) => viewProblems(view, COPY, 'Book (sandbox)', USER).join(' | ');
        assert.match(problems(privateView({ owner: { _id: SOMEONE } })), /owned by account/);
        assert.match(problems(privateView({}, 'readAndWrite')), /access level/);
        assert.match(problems(privateView({ members: [{ _id: SOMEONE }] })), /shared with 1 collaborators/);
        assert.match(problems(privateView({ invites: [{ email: 'x@example.com' }] })), /1 pending invites/);
        assert.match(problems(privateView({ publicAccesLevel: 'tokenBased' })), /link sharing is "tokenBased"/);
        assert.match(problems(privateView({ members: undefined })), /did not list its collaborators/);
        assert.match(problems(privateView({ name: 'Book' })), /named "Book"/);
        assert.match(problems(privateView({ _id: OTHER })), /answered for project/);
    });

    it('refuses the shared project\'s id and every id but the recorded one', () => {
        const guarded = new GuardedSandbox(new FakeWriter(), record(), SHARED, USER);
        assert.throws(() => guarded.assertTarget(SHARED), /refusing to write to the shared project/);
        assert.throws(() => guarded.assertTarget(OTHER), /the only project this tool writes to/);
        guarded.assertTarget(COPY);
    });

    it('joins the copy afresh before each write and sends the write only to the copy', async () => {
        const writer = new FakeWriter();
        const guarded = new GuardedSandbox(writer, record(), SHARED, USER);
        for (const write of writes(guarded)) { await write(); }
        assert.deepStrictEqual(writer.calls, [
            `join ${COPY}`, `upload ${COPY} root main.tex`,
            `join ${COPY}`, `addFolder ${COPY} root fig`,
            `join ${COPY}`, `remove ${COPY} doc d9`,
            `join ${COPY}`, `settings ${COPY} {"imageName":"texlive-full:2025.1"}`,
            `join ${COPY}`, `clearOutput ${COPY}`,
            `join ${COPY}`, `compile ${COPY} main.tex`,
        ]);
        assert.strictEqual(guarded.checks, 6);
    });

    it('sends no write once the copy has a collaborator, an invite or a sharing link', async () => {
        for (const view of [privateView({ members: [{}] }), privateView({ invites: [{}] }), privateView({ publicAccesLevel: 'tokenBased' })]) {
            const writer = new FakeWriter();
            writer.view = () => view;
            const guarded = new GuardedSandbox(writer, record(), SHARED, USER);
            for (const write of writes(guarded)) {
                await assert.rejects(write(), SandboxSafetyError);
            }
            assert.deepStrictEqual(writer.calls.filter(call => !call.startsWith('join ')), []);
        }
    });

    it('sends no write when the check itself fails', async () => {
        const writer = new FakeWriter();
        writer.join = async () => { throw new Error('getaddrinfo EAI_AGAIN www.overleaf.com'); };
        const guarded = new GuardedSandbox(writer, record(), SHARED, USER);
        await assert.rejects(guarded.upload('root', 'a.tex', new Uint8Array()), /EAI_AGAIN/);
        assert.deepStrictEqual(writer.calls, []);
    });

    it('stops writing as soon as a check fails, e.g. the copy was shared in the middle of a run', async () => {
        const writer = new FakeWriter();
        let joins = 0;
        writer.view = () => (++joins <= 2 ? privateView() : privateView({ members: [{ _id: SOMEONE }] }));
        const guarded = new GuardedSandbox(writer, record(), SHARED, USER);
        await guarded.upload('root', 'a.tex', new Uint8Array());
        await guarded.upload('root', 'b.tex', new Uint8Array());
        await assert.rejects(guarded.upload('root', 'c.tex', new Uint8Array()), /shared with 1 collaborators/);
        assert.deepStrictEqual(writer.calls.filter(call => call.startsWith('upload')), [`upload ${COPY} root a.tex`, `upload ${COPY} root b.tex`]);
    });
});
