/**
 * The safety checks of the sandbox: the private copy of a shared project that agents
 * compile unlanded versions in.
 *
 * The tool writes to exactly one project, the copy it created and recorded in the
 * replica's .overleaf/sandbox.json. Every write goes through `GuardedSandbox`, which is
 * bound to the recorded id and offers no way to name another project. Before each write
 * it joins the copy afresh and checks the server's answer: the project is the recorded
 * one, this account owns it, it has no collaborators, no pending invites and link sharing
 * is off. The shared project's id is refused outright, whatever the record says.
 */

import type { CompileRequest } from '../api/base';

/** What .overleaf/sandbox.json holds. */
export interface SandboxRecord {
    /** version of this file's format */
    version: 1;
    /** the server's URL, e.g. https://www.overleaf.com/ */
    server: string;
    /** the private copy */
    projectId: string;
    projectName: string;
    /** the account that created the copy */
    ownerId: string;
    /** the shared project the copy was cloned from */
    source: { projectId: string, projectName: string };
    createdAt: string;
}

/** The parts of a joinProject answer that the checks read. */
export interface ProjectView {
    _id: string;
    name: string;
    owner?: { _id: string };
    members?: unknown[];
    invites?: unknown[];
    /** Overleaf's own spelling of the field */
    publicAccesLevel?: string;
}

export interface JoinedView {
    project: ProjectView;
    /** the joining user's access level: 'owner', 'readAndWrite', ... */
    permissionsLevel?: string;
}

export class SandboxSafetyError extends Error {}

const OBJECT_ID = /^[0-9a-f]{24}$/;

/** Problems with a record that forbid using it, for the replica of `sourceProjectId` and login `userId`. */
export function recordProblems(record: SandboxRecord, sourceProjectId: string, userId: string): string[] {
    const problems: string[] = [];
    if (record?.version !== 1) {
        problems.push(`the record has format version ${record?.version}, not 1`);
    }
    if (typeof record?.projectId !== 'string' || !OBJECT_ID.test(record.projectId)) {
        problems.push(`the recorded project id "${record?.projectId}" is not a project id`);
    }
    if (record?.projectId === sourceProjectId) {
        problems.push('the recorded project is the shared project itself');
    }
    if (record?.source?.projectId !== sourceProjectId) {
        problems.push(`the record belongs to project ${record?.source?.projectId}, not to this replica's project ${sourceProjectId}`);
    }
    if (record?.ownerId !== userId) {
        problems.push(`the copy was created by account ${record?.ownerId}, not by the logged-in account ${userId}`);
    }
    return problems;
}

/**
 * Problems that forbid writing to the copy, read from a fresh joinProject answer for it.
 * `expectedName` is the name the record gives the copy.
 */
export function viewProblems(view: JoinedView, projectId: string, expectedName: string, userId: string): string[] {
    const problems: string[] = [];
    const project = view?.project;
    if (project?._id !== projectId) {
        problems.push(`the server answered for project ${project?._id}, not ${projectId}`);
        return problems;
    }
    if (project.owner?._id !== userId) {
        problems.push(`it is owned by account ${project.owner?._id}, not by the logged-in account ${userId}`);
    }
    if (view.permissionsLevel !== 'owner') {
        problems.push(`the logged-in account's access level is "${view.permissionsLevel}", not "owner"`);
    }
    if (!Array.isArray(project.members)) {
        problems.push('the server did not list its collaborators');
    } else if (project.members.length > 0) {
        problems.push(`it is shared with ${project.members.length} collaborators`);
    }
    if (!Array.isArray(project.invites)) {
        problems.push('the server did not list its pending invites');
    } else if (project.invites.length > 0) {
        problems.push(`it has ${project.invites.length} pending invites`);
    }
    if (project.publicAccesLevel !== 'private') {
        problems.push(`link sharing is "${project.publicAccesLevel}", not "private"`);
    }
    if (project.name !== expectedName) {
        problems.push(`it is named "${project.name}", not "${expectedName}" as recorded; rename it back on Overleaf to use it`);
    }
    return problems;
}

/** The kinds of entity a write can address. */
export type EntityType = 'doc' | 'file' | 'folder';

/** What the guarded writes need from a client of the server; every call names its project. */
export interface ProjectWriter {
    join(projectId: string): Promise<JoinedView>;
    upload(projectId: string, folderId: string, name: string, content: Uint8Array): Promise<{ type: string, id: string, hash?: string }>;
    addFolder(projectId: string, parentFolderId: string, name: string): Promise<{ id: string }>;
    remove(projectId: string, type: EntityType, id: string): Promise<void>;
    updateSettings(projectId: string, settings: { compiler?: string, imageName?: string }): Promise<void>;
    clearOutput(projectId: string): Promise<void>;
    compile(projectId: string, request: CompileRequest): Promise<any>;
}

/**
 * Writes to the recorded copy, and only to it. Each write first checks the id and then
 * the server's current answer about the copy; it is not sent when either check fails.
 */
export class GuardedSandbox {
    /** how many times the server's answer has been checked */
    checks = 0;
    /** the server's answer at the last check */
    lastView?: JoinedView;

    constructor(
        private readonly writer: ProjectWriter,
        readonly record: SandboxRecord,
        private readonly sourceProjectId: string,
        private readonly userId: string,
    ) {
        const problems = recordProblems(record, sourceProjectId, userId);
        if (problems.length > 0) {
            throw new SandboxSafetyError(`refusing to use the sandbox record: ${problems.join('; ')}`);
        }
    }

    get projectId() { return this.record.projectId; }

    /** Throws unless `projectId` is the recorded copy, and never for the shared project. */
    assertTarget(projectId: string) {
        if (projectId === this.sourceProjectId) {
            throw new SandboxSafetyError(`refusing to write to the shared project ${projectId}`);
        }
        if (projectId !== this.record.projectId) {
            throw new SandboxSafetyError(`refusing to write to project ${projectId}: the only project this tool writes to is the recorded sandbox ${this.record.projectId}`);
        }
    }

    /** Check the id and the server's current answer about the copy before `action`. */
    async verify(action: string): Promise<JoinedView> {
        const projectId = this.record.projectId;
        this.assertTarget(projectId);
        const view = await this.writer.join(projectId);
        this.checks += 1;
        this.lastView = view;
        const problems = viewProblems(view, projectId, this.record.projectName, this.userId);
        if (problems.length > 0) {
            throw new SandboxSafetyError(`refusing to ${action} in project ${projectId}: ${problems.join('; ')}`);
        }
        return view;
    }

    async upload(folderId: string, name: string, content: Uint8Array) {
        await this.verify(`upload ${name}`);
        return this.writer.upload(this.record.projectId, folderId, name, content);
    }

    async addFolder(parentFolderId: string, name: string) {
        await this.verify(`create the folder ${name}`);
        return this.writer.addFolder(this.record.projectId, parentFolderId, name);
    }

    async remove(type: EntityType, id: string, path: string) {
        await this.verify(`delete ${path}`);
        return this.writer.remove(this.record.projectId, type, id);
    }

    async updateSettings(settings: { compiler?: string, imageName?: string }) {
        await this.verify(`change the settings (${JSON.stringify(settings)})`);
        return this.writer.updateSettings(this.record.projectId, settings);
    }

    async clearOutput() {
        await this.verify('clear the compile output');
        return this.writer.clearOutput(this.record.projectId);
    }

    async compile(request: CompileRequest) {
        await this.verify(`compile ${request.rootResourcePath}`);
        return this.writer.compile(this.record.projectId, request);
    }
}
