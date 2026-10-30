import * as fs from 'fs';
import * as path from 'path';
import type { CompileResponseSchema } from '../api/base';
import type { OutputFileEntity } from '../core/remoteFileSystemProvider';

/** One compile on Overleaf, whatever its status. */
export interface CompileRecord {
    /** Overleaf's answer; undefined when the request itself failed */
    response?: CompileResponseSchema;
    /** why the request failed */
    message?: string;
    rootResourcePath: string | null;
    startedAt: number;
    finishedAt: number;
}

/** Where a local replica keeps the logs of its last compile, relative to the replica's folder. */
export const REPLICA_OUTPUT_FOLDER = '.overleaf/output';

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
            return { file, error: String(error?.message ?? error) };
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
        const summary = {
            status: compile.response?.status ?? 'request failed',
            message: compile.message,
            rootResourcePath: compile.rootResourcePath,
            startedAt: new Date(compile.startedAt).toISOString(),
            finishedAt: new Date(compile.finishedAt).toISOString(),
            requestMs: compile.finishedAt - compile.startedAt,
            buildId: compile.response?.outputFiles?.[0]?.build,
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
