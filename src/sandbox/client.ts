/* eslint-disable @typescript-eslint/naming-convention -- Overleaf's field names */
import { BaseAPI, CompileResponseSchema, Identity } from '../api/base';
import type { FolderEntity, OutputFileEntity } from '../core/remoteFileSystemProvider';
import { CompileRequest, EntityType, JoinedView, ProjectView, ProjectWriter } from './guard';

/** What joinProject returns for a project, as far as the tool reads it. */
export interface JoinedProject extends JoinedView {
    project: ProjectView & {
        rootFolder: FolderEntity[];
        rootDoc_id?: string;
        compiler?: string;
        imageName?: string;
        features?: { compileTimeout?: number, compileGroup?: string };
    };
}

export interface CompileResult {
    response: Omit<CompileResponseSchema, 'status' | 'timings' | 'stats'> & {
        /** 'success', 'failure', 'timedout', 'terminated', 'compile-in-progress', ... */
        status: string,
        timings?: Record<string, number>,
        stats?: Record<string, number>,
        outputFilesArchive?: unknown,
    };
}

/** BaseAPI with the few requests the sandbox needs that the extension does not make. */
class SandboxAPI extends BaseAPI {
    async docText(identity: Identity, projectId: string, docId: string): Promise<string> {
        this.setIdentity(identity);
        const content = await this.download(`Project/${projectId}/doc/${docId}/download`);
        return content.toString('utf8');
    }

    /**
     * A compile as the editor's Recompile button starts it, not an automatic one. As the editor
     * and the extension's own compile (BaseAPI.compile) do, it asks for Overleaf's PDF caching:
     * the response then lists the pieces of output.pdf, which the extension's PDF viewers fetch
     * from the download domain and keep in their cache.
     */
    async compileProject(identity: Identity, projectId: string, request: CompileRequest) {
        this.setIdentity(identity);
        const body = {
            check: 'silent',
            draft: request.draft,
            incrementalCompilesEnabled: true,
            rootResourcePath: request.rootResourcePath,
            stopOnFirstError: request.stopOnFirstError,
        };
        return this.request('POST', `project/${projectId}/compile?enable_pdf_caching=true`, body, (res) => {
            const compile = JSON.parse(res!) as CompileResponseSchema;
            return { compile };
        }, { 'X-Csrf-Token': identity.csrfToken }, BaseAPI.compileRequestOptions);
    }
}

/**
 * Requests to one Overleaf server with one login. The write methods name their project;
 * the sandbox only reaches them through GuardedSandbox, which binds them to its copy.
 */
export class OverleafClient implements ProjectWriter {
    readonly api: SandboxAPI;
    /** how long a join may take */
    joinTimeoutMs = 30 * 1000;

    constructor(readonly url: string, private readonly identity: Identity) {
        this.api = new SandboxAPI(url);
    }

    /** Join `projectId` on a new connection, as the web editor does, and disconnect again. */
    join(projectId: string): Promise<JoinedProject> {
        const origin = new URL(this.url).origin;
        const io = require('socket.io-client');
        return new Promise((resolve, reject) => {
            const socket = io.connect(`${origin}?projectId=${encodeURIComponent(projectId)}&t=${Date.now()}`, {
                reconnect: false,
                'force new connection': true,
                extraHeaders: { Origin: origin, Cookie: this.identity.cookies },
            });
            let settled = false;
            const finish = (error?: Error, value?: JoinedProject) => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                try { socket.removeAllListeners?.(); socket.disconnect(); } catch { /* already closed */ }
                error ? reject(error) : resolve(value!);
            };
            const timer = setTimeout(() => finish(new Error(`joining project ${projectId} took more than ${this.joinTimeoutMs/1000} s`)), this.joinTimeoutMs);
            socket.on('joinProjectResponse', (res: any) => {
                if (!res?.project?._id) {
                    finish(new Error(`joining project ${projectId} returned no project`));
                } else {
                    finish(undefined, { project: res.project, permissionsLevel: res.permissionsLevel });
                }
            });
            socket.on('connectionRejected', (err: any) => finish(new Error(`Overleaf rejected joining project ${projectId}: ${err?.message ?? err} (has the login expired? Log in again with the extension.)`)));
            socket.on('connect_failed', () => finish(new Error(`could not connect to ${origin}`)));
            socket.on('error', (err: any) => finish(new Error(`connection to ${origin} failed: ${err?.message ?? err}`)));
            socket.on('disconnect', () => finish(new Error(`the connection to ${origin} closed before project ${projectId} was joined`)));
        });
    }

    docText(projectId: string, docId: string): Promise<string> {
        return this.api.docText(this.identity, projectId, docId);
    }

    async fileContent(projectId: string, fileId: string): Promise<Uint8Array> {
        const res = await this.api.getFile(this.identity, projectId, fileId);
        if (res.type !== 'success' || !res.content) {
            throw new Error(res.message ?? `the download of file ${fileId} failed`);
        }
        return res.content;
    }

    /** An output file of a compile, as the extension's PDF viewer gets it. */
    async outputFile(file: OutputFileEntity, response: CompileResult['response']): Promise<Uint8Array> {
        const res = await this.api.getFileFromClsi(this.identity, file.url, response.compileGroup || 'standard',
                                                   response.clsiServerId, response.pdfDownloadDomain);
        if (res.type !== 'success' || !res.content) {
            throw new Error(`the download of ${file.path} failed: ${res.message}`);
        }
        return res.content;
    }

    /** Clone `projectId` into a new project of this account; returns the new project's id. */
    async clone(projectId: string, name: string): Promise<string> {
        const res = await this.api.cloneProject(this.identity, projectId, name);
        if (res.type !== 'success' || !res.message) {
            throw new Error(`cloning the project failed: ${res.message}`);
        }
        return res.message;
    }

    // ---- writes; only GuardedSandbox calls these

    async upload(projectId: string, folderId: string, name: string, content: Uint8Array) {
        const res = await this.api.uploadFile(this.identity, projectId, folderId, name, content);
        if (res.type !== 'success' || !res.entity?._type) {
            throw new Error(`the upload of ${name} failed: ${res.message ?? 'the server did not create it'}`);
        }
        return { type: res.entity._type, id: res.entity._id };
    }

    async addFolder(projectId: string, parentFolderId: string, name: string) {
        const res = await this.api.addFolder(this.identity, projectId, name, parentFolderId);
        if (res.type !== 'success' || !res.entity?._id) {
            throw new Error(`creating the folder ${name} failed: ${res.message}`);
        }
        return { id: res.entity._id };
    }

    async remove(projectId: string, type: EntityType, id: string) {
        const res = await this.api.deleteEntity(this.identity, projectId, type, id);
        if (res.type !== 'success') {
            throw new Error(`deleting ${type} ${id} failed: ${res.message}`);
        }
    }

    async updateSettings(projectId: string, settings: { compiler?: string, imageName?: string }) {
        const res = await this.api.updateProjectSettings(this.identity, projectId, settings);
        if (res.type !== 'success') {
            throw new Error(`changing the settings failed: ${res.message}`);
        }
    }

    async clearOutput(projectId: string) {
        const res = await this.api.deleteAuxFiles(this.identity, projectId);
        if (res.type !== 'success') {
            throw new Error(`clearing the compile output failed: ${res.message}`);
        }
    }

    async compile(projectId: string, request: CompileRequest): Promise<CompileResult> {
        const res = await this.api.compileProject(this.identity, projectId, request);
        if (res.type !== 'success' || !res.compile) {
            throw new Error(`the compile request failed: ${res.message}`);
        }
        return { response: res.compile as CompileResult['response'] };
    }
}
