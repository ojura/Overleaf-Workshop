import * as fs from 'fs';
import * as path from 'path';
import type { CompileResponseSchema } from '../api/base';
import type { OutputFileEntity } from '../core/remoteFileSystemProvider';
import { REPLICA_FOLDER } from '../scm/ignorePatterns';
import { errorMessage } from '../utils/errorMessage';

/**
 * One compile on Overleaf, whatever its status: this window's, or another client's from Overleaf's
 * cache of compile outputs, whose answer has `fromCache` set.
 */
export interface CompileRecord {
    /** Overleaf's answer; undefined when the request itself failed */
    response?: CompileResponseSchema;
    /** why the request failed */
    message?: string;
    rootResourcePath: string | null;
    /** for this window's compile: when the request was sent and answered */
    startedAt?: number;
    finishedAt?: number;
    /** for a compile from Overleaf's cache: when Overleaf answered, which says nothing of when the compile ran */
    answeredAt?: number;
}

/**
 * Where a local replica keeps the logs of its last compile: a folder in the replica's own folder,
 * which the sync leaves out, as a path of the sync ('/dir/name').
 */
export const REPLICA_OUTPUT_FOLDER = `${REPLICA_FOLDER}/output`;

/** The output files that a local replica keeps of each compile: the logs. */
export const REPLICA_OUTPUT_FILES: readonly string[] = ['output.log', 'output.blg', 'output.ilg', 'output.stdout', 'output.stderr'];

/**
 * Replace `folder` with the outputs of `compile`: the files of `names` that Overleaf
 * returned, `compile-response.json` (Overleaf's answer, with its timings) and
 * `compile.json` (when the compile ran, how long the request took, what was saved).
 * The new files are written next to `folder` first and then moved in its place, so a
 * reader never sees the logs of two compiles mixed. Returns what was saved.
 */
export async function saveCompileOutputs(
    folder: string,
    compile: CompileRecord,
    download: (file: OutputFileEntity) => Promise<Uint8Array>,
    names: readonly string[] = REPLICA_OUTPUT_FILES,
) {
    const outputs = (compile.response?.outputFiles ?? []).filter(file => names.includes(file.path));
    const results = await Promise.all(outputs.map(async (file) => {
        try {
            return { file, content: await download(file) };
        } catch (error: any) {
            return { file, error: errorMessage(error) };
        }
    }));

    const parent = path.dirname(folder);
    await fs.promises.mkdir(parent, { recursive: true });
    const staging = await fs.promises.mkdtemp(path.join(parent, `${path.basename(folder)}.new-`));
    const saved: Array<{ path: string, bytes: number }> = [];
    const failed: Array<{ path: string, error: string }> = [];
    try {
        for (const result of results) {
            if (result.content) {
                await fs.promises.writeFile(path.join(staging, result.file.path), result.content);
                saved.push({ path: result.file.path, bytes: result.content.byteLength });
            } else {
                failed.push({ path: result.file.path, error: result.error! });
            }
        }
        if (compile.response) {
            await fs.promises.writeFile(path.join(staging, 'compile-response.json'), JSON.stringify(compile.response, null, 2) + '\n');
        }
        const { startedAt, finishedAt, answeredAt } = compile;
        const summary = {
            status: compile.response?.status ?? 'request failed',
            message: compile.message,
            rootResourcePath: compile.rootResourcePath,
            ...(startedAt !== undefined ? { startedAt: new Date(startedAt).toISOString() } : {}),
            ...(finishedAt !== undefined ? { finishedAt: new Date(finishedAt).toISOString() } : {}),
            ...(startedAt !== undefined && finishedAt !== undefined ? { requestMs: finishedAt - startedAt } : {}),
            buildId: compile.response?.outputFiles?.[0]?.build,
            ...(compile.response?.fromCache ? { fromCache: true } : {}),
            ...(answeredAt !== undefined ? { answeredAt: new Date(answeredAt).toISOString() } : {}),
            saved,
            failed,
            notSaved: (compile.response?.outputFiles ?? []).map(file => file.path).filter(p => !names.includes(p)),
        };
        await fs.promises.writeFile(path.join(staging, 'compile.json'), JSON.stringify(summary, null, 2) + '\n');

        // swap the folders: the old one aside, the new one in, the old one away
        const old = `${staging}.old`;
        let moved = false;
        try {
            await fs.promises.rename(folder, old);
            moved = true;
        } catch (error: any) {
            if (error?.code !== 'ENOENT') { throw error; }
        }
        await fs.promises.rename(staging, folder);
        if (moved) { await fs.promises.rm(old, { recursive: true, force: true }); }
        return summary;
    } catch (error) {
        await fs.promises.rm(staging, { recursive: true, force: true });
        throw error;
    }
}
