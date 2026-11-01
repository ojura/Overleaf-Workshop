/* eslint-disable @typescript-eslint/naming-convention -- Overleaf's field names */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { minimatch } from 'minimatch';
import type { FolderEntity, OutputFileEntity } from '../core/remoteFileSystemProvider';
import { gitBlobHash } from '../scm/replicaSync';
import { DEFAULT_IGNORE_PATTERNS, REPLICA_SETTINGS_FILE } from '../scm/ignorePatterns';
import { LatexParser } from '../compile/compileLogParser';
import { GuardedSandbox, SandboxRecord, SandboxSafetyError, recordProblems, viewProblems } from './guard';
import { acquireLock, HeldLock, LockOwner } from './lock';
import { LocalFile, overleafText, Plan, planSync, RemoteTree } from './plan';
import { mapLimit } from './mapLimit';
import type { CompileResult, JoinedProject, OverleafClient } from './client';

export type Logger = (message: string) => void;

/** What a local replica's .overleaf/settings.json says about the project. */
export interface Replica {
    folder: string;
    serverName: string;
    userId: string;
    projectId: string;
    projectName: string;
}

const OBJECT_ID = /^[0-9a-f]{24}$/;

export function readReplica(folder: string): Replica {
    const file = path.join(folder, REPLICA_SETTINGS_FILE);
    let settings: any;
    try {
        settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error: any) {
        throw new Error(`${folder} is not a local replica: cannot read ${file}: ${error?.message ?? error}`);
    }
    // e.g. overleaf-workshop://www.overleaf.com/Name?user%3D<id>%26project%3D<id>
    const uri = new URL(settings.uri);
    const query = new URLSearchParams(decodeURIComponent(uri.search.slice(1)));
    const replica = {
        folder,
        serverName: uri.host,
        userId: query.get('user') ?? '',
        projectId: query.get('project') ?? '',
        projectName: settings.projectName ?? decodeURIComponent(uri.pathname.slice(1)),
    };
    if (!OBJECT_ID.test(replica.projectId) || !OBJECT_ID.test(replica.userId)) {
        throw new Error(`cannot read the project and user ids from "uri" in ${file}`);
    }
    return replica;
}

export const recordFile = (folder: string) => path.join(folder, '.overleaf', 'sandbox.json');
export const lockFile = (folder: string) => path.join(folder, '.overleaf', 'sandbox.lock');
/** One line per event of a run, so that the runs of several agents on one copy can be traced. */
export const runLogFile = (folder: string) => path.join(folder, '.overleaf', 'sandbox-runs.jsonl');

function logRun(folder: string, entry: Record<string, unknown>) {
    try {
        fs.appendFileSync(runLogFile(folder), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...entry }) + '\n');
    } catch {
        // the log only helps to trace runs; a run does not fail for it
    }
}

/** The last `count` entries of the run log. */
export function recentRuns(folder: string, count: number): any[] {
    try {
        return fs.readFileSync(runLogFile(folder), 'utf8').split('\n').filter(Boolean).slice(-count).map(line => JSON.parse(line));
    } catch {
        return [];
    }
}

export function readRecord(folder: string): SandboxRecord | undefined {
    try {
        return JSON.parse(fs.readFileSync(recordFile(folder), 'utf8'));
    } catch (error: any) {
        if (error?.code === 'ENOENT') { return undefined; }
        throw new Error(`cannot read ${recordFile(folder)}: ${error?.message ?? error}`);
    }
}

function writeJson(file: string, value: unknown) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(tmp, file);
}

/** The files and folders of a project, by path. */
export function treeOf(project: { rootFolder: FolderEntity[] }): RemoteTree {
    const tree: RemoteTree = { files: new Map(), folders: new Map() };
    const walk = (folder: FolderEntity, prefix: string) => {
        tree.folders.set(prefix || '/', folder._id);
        folder.docs?.forEach(doc => tree.files.set(`${prefix}/${doc.name}`, { kind: 'doc', id: doc._id }));
        folder.fileRefs?.forEach(file => tree.files.set(`${prefix}/${file.name}`, { kind: 'file', id: file._id, hash: file.hash }));
        folder.folders?.forEach(sub => walk(sub, `${prefix}/${sub.name}`));
    };
    walk(project.rootFolder[0], '');
    return tree;
}

/** Products of a local index build, which the replica's patterns do not name. */
const EXTRA_IGNORE_PATTERNS = ['**/*.idx', '**/*.ind', '**/*.ilg'];

export function ignoreMatcher(ignore: string[], include: string[]): (path: string) => boolean {
    const patterns = [...DEFAULT_IGNORE_PATTERNS, ...EXTRA_IGNORE_PATTERNS, ...ignore];
    // patterns are matched against the path without its leading slash, e.g. "slike/a.jpg"
    const matches = (list: string[], p: string) => list.some(pattern => minimatch(p.replace(/^\//, ''), pattern, { dot: true }));
    return (p: string) => !matches(include, p) && matches(patterns, p);
}

export interface ScannedFile extends LocalFile {
    absolute: string;
}

/** Hash every file of `dir` that is not ignored. Paths are like '/sub/name.tex'. */
export async function scanLocal(dir: string, isIgnored: (path: string) => boolean) {
    const files = new Map<string, ScannedFile>();
    const ignored: string[] = [];
    const skipped: Array<{ path: string, reason: string }> = [];
    const pending: Array<{ path: string, absolute: string }> = [];
    const walk = async (relative: string, absolute: string) => {
        const entries = await fsp.readdir(absolute, { withFileTypes: true });
        for (const entry of entries) {
            const p = `${relative}/${entry.name}`;
            const a = path.join(absolute, entry.name);
            if (isIgnored(p)) { ignored.push(p); continue; }
            let isDirectory = entry.isDirectory();
            let isFile = entry.isFile();
            if (entry.isSymbolicLink()) {
                const target = await fsp.stat(a).catch(() => undefined);
                if (target?.isDirectory()) { skipped.push({ path: p, reason: 'a symbolic link to a folder' }); continue; }
                isFile = target?.isFile() ?? false;
                isDirectory = false;
            }
            if (isDirectory) {
                await walk(p, a);
            } else if (isFile) {
                pending.push({ path: p, absolute: a });
            } else {
                skipped.push({ path: p, reason: 'not a regular file' });
            }
        }
    };
    await walk('', path.resolve(dir));
    let next = 0;
    await Promise.all(Array.from({ length: 16 }, async () => {
        while (next < pending.length) {
            const { path: p, absolute } = pending[next++];
            const bytes = new Uint8Array(await fsp.readFile(absolute));
            files.set(p, { hash: gitBlobHash(bytes), text: overleafText(bytes), size: bytes.byteLength, absolute });
        }
    }));
    return { files, ignored: ignored.sort(), skipped };
}

// ---------------------------------------------------------------- init and status

export interface ProjectSettings {
    compiler?: string;
    imageName?: string;
    rootDoc?: string;
}

export function settingsOf(joined: JoinedProject): ProjectSettings {
    const rootDoc = joined.project.rootDoc_id === undefined ? undefined
        : [...treeOf(joined.project).files.entries()].find(([, file]) => file.id === joined.project.rootDoc_id)?.[0];
    return { compiler: joined.project.compiler, imageName: joined.project.imageName, rootDoc };
}

/** The settings of `copy` that differ from the shared project's and decide how it compiles. */
function settingsToCopy(shared: ProjectSettings, copy: ProjectSettings) {
    const update: { compiler?: string, imageName?: string } = {};
    if (shared.compiler && shared.compiler !== copy.compiler) { update.compiler = shared.compiler; }
    if (shared.imageName && shared.imageName !== copy.imageName) { update.imageName = shared.imageName; }
    return update;
}

export function sandboxUrl(record: SandboxRecord) {
    return `${record.server.replace(/\/*$/, '/')}project/${record.projectId}`;
}

/**
 * Clone the replica's project into a new private project of this account and record it in
 * the replica's .overleaf/sandbox.json. The clone is the one request that names the shared
 * project; Overleaf reads it to make the copy and does not change it.
 */
export async function createSandbox(client: OverleafClient, replica: Replica, userId: string, name: string, log: Logger) {
    if (readRecord(replica.folder)) {
        throw new Error(`${recordFile(replica.folder)} already records a sandbox; it is reused, not made again`);
    }
    if (userId !== replica.userId) {
        throw new Error(`the login is for account ${userId}, but the replica belongs to account ${replica.userId}`);
    }
    const shared = await client.join(replica.projectId);
    const sharedSettings = settingsOf(shared);
    log(`the shared project "${shared.project.name}": compiler ${sharedSettings.compiler}, image ${sharedSettings.imageName}, main document ${sharedSettings.rootDoc}`);

    log(`cloning it as "${name}" ...`);
    const started = Date.now();
    const projectId = await client.clone(replica.projectId, name);
    log(`cloned in ${((Date.now() - started) / 1000).toFixed(1)} s: project ${projectId}`);
    if (!OBJECT_ID.test(projectId) || projectId === replica.projectId) {
        throw new SandboxSafetyError(`the clone request returned "${projectId}", which is not a new project id`);
    }
    const copy = await client.join(projectId);
    const problems = viewProblems(copy, projectId, name, userId);
    if (problems.length > 0) {
        throw new SandboxSafetyError(`the new project ${projectId} is not private to this account, so it is not recorded: ${problems.join('; ')}. Delete it on Overleaf.`);
    }
    const record: SandboxRecord = {
        version: 1,
        server: client.url,
        projectId,
        projectName: name,
        ownerId: userId,
        source: { projectId: replica.projectId, projectName: shared.project.name },
        createdAt: new Date().toISOString(),
    };
    writeJson(recordFile(replica.folder), record);
    logRun(replica.folder, { event: 'created', projectId, projectName: name });
    log(`recorded in ${recordFile(replica.folder)}`);

    // A clone gets Overleaf's current default TeX Live image, not the source's.
    const guarded = new GuardedSandbox(client, record, replica.projectId, userId);
    const update = settingsToCopy(sharedSettings, settingsOf(copy));
    if (Object.keys(update).length > 0) {
        log(`setting ${JSON.stringify(update)} in the copy, as in the shared project (the clone had compiler ${copy.project.compiler}, image ${copy.project.imageName})`);
        await guarded.updateSettings(update);
    }
    return { record, checks: guarded.checks };
}

export async function sandboxStatus(client: OverleafClient, replica: Replica, userId: string) {
    const record = readRecord(replica.folder);
    if (!record) { return { record }; }
    const problems = recordProblems(record, replica.projectId, userId);
    const copy = await client.join(record.projectId).catch((error: Error) => error);
    const shared = await client.join(replica.projectId).catch((error: Error) => error);
    if (!(copy instanceof Error)) {
        problems.push(...viewProblems(copy, record.projectId, record.projectName, userId));
    }
    let lock: LockOwner | undefined;
    try { lock = JSON.parse(fs.readFileSync(lockFile(replica.folder), 'utf8')); } catch { lock = undefined; }
    return { record, problems, copy, shared, lock };
}


// ---------------------------------------------------------------- the run

export interface RunOptions {
    dir: string;
    /** the main document, relative to `dir`, e.g. main.tex */
    main: string;
    /** where to save the outputs; a new folder in the system's temp folder when undefined */
    out?: string;
    mirror: boolean;
    keep: string[];
    ignore: string[];
    include: string[];
    /** keep the previous compile's output on Overleaf instead of clearing it first */
    incremental: boolean;
    draft: boolean;
    stopOnFirstError: boolean;
    /** also download output.pdf, which for the book is 885 MB */
    pdf: boolean;
    /** only say what would be written */
    dryRun: boolean;
    lockTimeoutMs: number;
    /** shown to runs that wait for the lock */
    purpose: string;
}

export interface LogSummary {
    errors: number;
    warnings: number;
    badBoxes: number;
    undefinedReferences: string[];
    undefinedCitations: string[];
    firstErrors: string[];
    firstWarnings: string[];
    rerunWarning: boolean;
}

export function summarizeLog(text: string): LogSummary {
    const parsed = new LatexParser(text).parse();
    const all = parsed?.all ?? [];
    const references = new Set<string>();
    const citations = new Set<string>();
    for (const entry of all) {
        const reference = /Reference [`'](.+?)' on page \d+ undefined/.exec(entry.message);
        if (reference) { references.add(reference[1]); }
        const citation = /Citation [`'](.+?)' on page \d+ undefined/.exec(entry.message);
        if (citation) { citations.add(citation[1]); }
    }
    const errors = all.filter(entry => entry.level === 'error');
    const warnings = all.filter(entry => entry.level === 'warning');
    const where = (entry: { file: string, line: number | null }) => `${entry.file}${entry.line !== null ? `:${entry.line}` : ''}`;
    return {
        errors: errors.length,
        warnings: warnings.length,
        badBoxes: all.filter(entry => /^(Over|Under)full/.test(entry.message)).length,
        undefinedReferences: [...references].sort(),
        undefinedCitations: [...citations].sort(),
        firstErrors: errors.slice(0, 20).map(entry => `${where(entry)}: ${entry.message}`),
        firstWarnings: warnings.slice(0, 40).map(entry => `${where(entry)}: ${entry.message}`),
        rerunWarning: /Rerun to get|Label\(s\) may have changed/.test(text),
    };
}

/** A path from the server that is safe to write below the output folder. */
function safeOutputPath(p: string): string | undefined {
    const parts = p.split(/[\\/]+/).filter(part => part !== '' && part !== '.');
    if (parts.length === 0 || parts.some(part => part === '..')) { return undefined; }
    return parts.join(path.sep);
}

const RUN_FILE = 'run.json';
const TOOL = 'overleaf-sandbox';

/** Make `out` an empty folder: refuse a folder with other content than an earlier run's. */
function prepareOutputFolder(out: string) {
    if (!fs.existsSync(out)) {
        fs.mkdirSync(out, { recursive: true });
        return;
    }
    const entries = fs.readdirSync(out);
    if (entries.length === 0) { return; }
    let previous: any;
    try { previous = JSON.parse(fs.readFileSync(path.join(out, RUN_FILE), 'utf8')); } catch { previous = undefined; }
    if (previous?.tool !== TOOL) {
        throw new Error(`${out} is not empty and holds no earlier run of this tool; give an empty or new folder`);
    }
    for (const entry of entries) {
        fs.rmSync(path.join(out, entry), { recursive: true, force: true });
    }
}

function defaultOutputFolder(record: SandboxRecord) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(os.tmpdir(), TOOL, record.projectId, `${stamp}-${process.pid}`);
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface RunResult {
    /** what run.json holds */
    summary: any;
    /** the folder with the outputs */
    out?: string;
    /** the compile's status, undefined when the run stopped before compiling */
    status?: string;
}

/**
 * Make the sandbox hold `options.dir` laid over the shared project (see plan.ts), compile
 * it, and save every output file Overleaf returns, the compile response and the run's
 * timings in the output folder. Runs on the same sandbox wait for each other.
 */
export async function runCompile(client: OverleafClient, replica: Replica, userId: string, options: RunOptions, log: Logger): Promise<RunResult> {
    const started = Date.now();
    const timings: Record<string, number> = {};
    const time = async <T>(phase: string, work: () => Promise<T>): Promise<T> => {
        const t = Date.now();
        try { return await work(); } finally { timings[phase] = (timings[phase] ?? 0) + Date.now() - t; }
    };

    const record = readRecord(replica.folder);
    if (!record) {
        throw new Error(`no sandbox is recorded in ${recordFile(replica.folder)}; create it once with: init --replica "${replica.folder}"`);
    }
    const guarded = new GuardedSandbox(client, record, replica.projectId, userId);
    const main = options.main.replace(/^\/+/, '');
    const summary: any = {
        tool: TOOL,
        version: 1,
        startedAt: new Date(started).toISOString(),
        sandbox: { projectId: record.projectId, projectName: record.projectName, url: sandboxUrl(record) },
        source: { projectId: replica.projectId, projectName: record.source.projectName },
        dir: path.resolve(options.dir),
        main,
        options: {
            mirror: options.mirror, keep: options.keep, ignore: options.ignore, include: options.include,
            incremental: options.incremental, draft: options.draft, stopOnFirstError: options.stopOnFirstError,
            pdf: options.pdf, dryRun: options.dryRun,
        },
        timingsMs: timings,
    };

    const out = options.dryRun ? undefined : path.resolve(options.out ?? defaultOutputFolder(record));
    if (out !== undefined && out === path.resolve(options.dir)) {
        throw new Error('the output folder must not be the directory to compile');
    }

    let lock: HeldLock | undefined;
    if (!options.dryRun) {
        lock = await time('lockWait', () => acquireLock(lockFile(replica.folder), {
            timeoutMs: options.lockTimeoutMs,
            purpose: options.purpose,
            onWait: (owner, waited) => log(owner
                ? `waiting for the sandbox lock (${Math.round(waited/1000)} s): pid ${owner.pid} has held it since ${owner.acquiredAt} for: ${owner.purpose}`
                : `waiting for the sandbox lock (${Math.round(waited/1000)} s)`),
        }));
        if (lock.waitedMs > 1000) { log(`got the sandbox lock after ${Math.round(lock.waitedMs/1000)} s`); }
    }
    // also when the process is ended by a signal; the CLI exits through process.exit()
    const releaseOnExit = () => lock?.release();
    process.on('exit', releaseOnExit);
    if (lock) {
        logRun(replica.folder, { event: 'start', purpose: options.purpose, dir: path.resolve(options.dir), main, out: options.out ? path.resolve(options.out) : undefined, lockWaitMs: lock.waitedMs });
    }
    /** the output folder is this run's, so run.json may be written there */
    let outReady = false;
    try {
        if (out) {
            prepareOutputFolder(out);
            outReady = true;
            summary.out = out;
        }

        // ---- what the copy has and what it should have
        const matcher = ignoreMatcher(options.ignore, options.include);
        // the results of earlier runs are not part of the version, when --out is inside --dir
        const outInDir = out === undefined ? undefined : path.relative(path.resolve(options.dir), out);
        const outPath = outInDir && !outInDir.startsWith('..') && !path.isAbsolute(outInDir) ? `/${outInDir.split(path.sep).join('/')}` : undefined;
        const isIgnored = (p: string) => matcher(p) || (outPath !== undefined && (p === outPath || p.startsWith(`${outPath}/`)));
        const scanned = await time('scanLocal', () => scanLocal(options.dir, isIgnored));
        log(`${options.dir}: ${scanned.files.size} files, ${scanned.ignored.length} ignored${scanned.skipped.length ? `, ${scanned.skipped.length} skipped` : ''}`);
        const [copy, shared] = await time('join', () => Promise.all([
            guarded.verify('start a run'),
            client.join(replica.projectId),
        ])) as [JoinedProject, JoinedProject];
        const copyTree = treeOf(copy.project);
        const sharedTree = treeOf(shared.project);
        if (!scanned.files.has(`/${main}`) && !(sharedTree.files.has(`/${main}`) && (!options.mirror || options.keep.some(k => minimatch(main, k, { dot: true }))))) {
            throw new Error(`the main document ${main} is neither in ${options.dir} nor taken from the shared project`);
        }
        const keep = (p: string) => options.keep.some(pattern => minimatch(p.replace(/^\//, ''), pattern, { dot: true }));
        const docTexts = new Map<string, Promise<string>>();
        const cachedText = (projectId: string, id: string) => {
            const key = `${projectId}/${id}`;
            if (!docTexts.has(key)) { docTexts.set(key, client.docText(projectId, id)); }
            return docTexts.get(key)!;
        };
        const plan: Plan = await time('plan', () => planSync(scanned.files, copyTree, sharedTree, { mirror: options.mirror, keep }, {
            copy: (_p, file) => cachedText(record.projectId, file.id),
            shared: (_p, file) => cachedText(replica.projectId, file.id),
        }));
        const settings = settingsToCopy(settingsOf(shared), settingsOf(copy));
        summary.plan = {
            uploads: plan.uploads,
            deletions: plan.deletions.map(d => ({ path: d.path, kind: d.kind })),
            folders: plan.folders,
            unchangedFromLocal: plan.unchanged.local.length,
            unchangedFromShared: plan.unchanged.shared.length,
            settings,
            problems: plan.problems,
        };
        summary.local = { files: scanned.files.size, ignored: scanned.ignored, skipped: scanned.skipped };
        const fromShared = plan.uploads.filter(u => u.from === 'shared').length;
        log(`plan: upload ${plan.uploads.length - fromShared} local files and ${fromShared} files from the shared project, delete ${plan.deletions.length}, create ${plan.folders.length} folders; ${plan.unchanged.local.length + plan.unchanged.shared.length} files are already as wanted`);
        for (const upload of plan.uploads) { log(`  upload ${upload.path} (${upload.reason === 'missing' ? 'not in the copy' : 'differs'}; from ${upload.from === 'local' ? 'the directory' : 'the shared project'})`); }
        for (const deletion of plan.deletions) { log(`  delete ${deletion.path} (not in the directory or the shared project)`); }
        if (Object.keys(settings).length > 0) { log(`  set ${JSON.stringify(settings)} as in the shared project`); }
        if (plan.problems.length > 0) {
            throw new Error(`nothing was written, because: ${plan.problems.map(p => `${p.path}: ${p.message}`).join('; ')}`);
        }
        if (options.dryRun) {
            summary.finishedAt = new Date().toISOString();
            return { summary };
        }

        // ---- writes, each checked by the guard
        const folderIds = new Map(copyTree.folders);
        await time('folders', async () => {
            for (const folder of plan.folders) {
                const parent = folder.slice(0, folder.lastIndexOf('/')) || '/';
                const created = await guarded.addFolder(folderIds.get(parent)!, folder.slice(folder.lastIndexOf('/') + 1));
                folderIds.set(folder, created.id);
            }
        });
        const uploaded = await time('upload', () => mapLimit(plan.uploads, 4, async (upload) => {
            let content: Uint8Array;
            if (upload.from === 'local') {
                content = new Uint8Array(await fsp.readFile(scanned.files.get(upload.path)!.absolute));
            } else {
                const file = sharedTree.files.get(upload.path)!;
                if (file.kind === 'doc') {
                    content = new TextEncoder().encode(await cachedText(replica.projectId, file.id));
                } else {
                    content = await client.fileContent(replica.projectId, file.id);
                    if (file.hash && gitBlobHash(content) !== file.hash) {
                        throw new Error(`the download of ${upload.path} from the shared project does not match its hash`);
                    }
                }
            }
            const folder = upload.path.slice(0, upload.path.lastIndexOf('/')) || '/';
            const name = upload.path.slice(upload.path.lastIndexOf('/') + 1);
            const entity = await guarded.upload(folderIds.get(folder)!, name, content);
            return { path: upload.path, type: entity.type, hash: gitBlobHash(content), bytes: content.byteLength };
        }));
        await time('delete', () => mapLimit(plan.deletions, 4, (deletion) => guarded.remove(deletion.kind, deletion.id, deletion.path)));
        if (Object.keys(settings).length > 0) {
            await time('settings', () => guarded.updateSettings(settings));
        }
        if (!options.incremental) {
            await time('clearOutput', () => guarded.clearOutput());
        }

        // ---- compile
        let result: CompileResult | undefined;
        let attempts = 0;
        const compileStarted = Date.now();
        await time('compile', async () => {
            for (;;) {
                attempts += 1;
                log(`compiling ${main} in "${record.projectName}"${attempts > 1 ? ` (attempt ${attempts})` : ''} ...`);
                const t = Date.now();
                const attempt = await guarded.compile({ rootResourcePath: main, draft: options.draft, stopOnFirstError: options.stopOnFirstError });
                result = attempt;
                const status = attempt.response.status;
                log(`compile status "${status}" after ${((Date.now() - t) / 1000).toFixed(1)} s`);
                if (status === 'too-recently-compiled' && attempts < 5) { await sleep(2000); continue; }
                // a compile that an aborted run left running, or one started on overleaf.com
                if (status === 'compile-in-progress' && Date.now() - compileStarted < 6 * 60 * 1000) { await sleep(20 * 1000); continue; }
                break;
            }
        });
        const response = result!.response;
        summary.compile = {
            status: response.status,
            attempts,
            timings: response.timings,
            stats: response.stats,
            compileGroup: response.compileGroup,
            clsiServerId: response.clsiServerId,
            buildId: response.outputFiles?.[0]?.build,
        };

        // ---- did the uploads arrive as sent? The guard's last check read the copy's tree.
        const after = guarded.lastView ? treeOf((guarded.lastView as JoinedProject).project) : undefined;
        summary.uploaded = uploaded.map(u => {
            const there = after?.files.get(u.path);
            const arrived = there === undefined ? 'missing' : there.kind === 'file' ? (there.hash === u.hash ? 'same hash' : `hash ${there.hash}`) : 'document';
            return { ...u, inCopy: arrived };
        });
        summary.settings = { ...settingsOf(shared), copyBefore: settingsOf(copy) };

        // ---- outputs
        const files = (response.outputFiles ?? []).filter(file => options.pdf || file.path !== 'output.pdf');
        const saved: Array<{ path: string, bytes: number }> = [];
        const failed: Array<{ path: string, error: string }> = [];
        await time('download', () => mapLimit(files, 4, async (file: OutputFileEntity) => {
            const relative = safeOutputPath(file.path);
            if (!relative) { failed.push({ path: file.path, error: 'not a path below the output folder' }); return; }
            try {
                const content = await client.outputFile(file, response);
                const target = path.join(out!, relative);
                await fsp.mkdir(path.dirname(target), { recursive: true });
                await fsp.writeFile(target, content);
                saved.push({ path: file.path, bytes: content.byteLength });
            } catch (error: any) {
                failed.push({ path: file.path, error: String(error?.message ?? error) });
            }
        }));
        saved.sort((a, b) => a.path.localeCompare(b.path));
        summary.outputs = { saved, failed, notDownloaded: (response.outputFiles ?? []).filter(file => !files.includes(file)).map(file => file.path) };
        fs.writeFileSync(path.join(out!, 'compile-response.json'), JSON.stringify(response, null, 2) + '\n');
        const logPath = path.join(out!, 'output.log');
        if (fs.existsSync(logPath)) {
            summary.log = summarizeLog(fs.readFileSync(logPath, 'utf8'));
        }
        const ilgPath = path.join(out!, 'output.ilg');
        if (fs.existsSync(ilgPath)) {
            summary.indexLog = fs.readFileSync(ilgPath, 'utf8').split('\n').slice(0, 3).join('\n');
        }
        summary.checks = guarded.checks;
        return { summary, out, status: response.status };
    } catch (error: any) {
        summary.error = String(error?.message ?? error);
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { summary, out: outReady ? out : undefined });
    } finally {
        timings.total = Date.now() - started;
        summary.finishedAt = new Date().toISOString();
        if (lock) {
            logRun(replica.folder, {
                event: 'end', status: summary.compile?.status, error: summary.error, out: summary.out,
                uploaded: summary.plan?.uploads?.map((u: any) => u.path), deleted: summary.plan?.deletions?.map((d: any) => d.path),
                compileE2EMs: summary.compile?.timings?.compileE2E, totalMs: timings.total,
            });
        }
        if (out && outReady) {
            try { writeJson(path.join(out, RUN_FILE), summary); } catch { /* reported by the caller */ }
        }
        lock?.release();
        process.off('exit', releaseOnExit);
    }
}
