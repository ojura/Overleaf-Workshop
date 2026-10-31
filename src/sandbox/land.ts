/* eslint-disable @typescript-eslint/naming-convention -- environment variable names */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { FolderEntity, OutputFileEntity } from '../core/remoteFileSystemProvider';
import { Repo } from '../gitbridge/plumbing';
import { ControlAnswer, ControlRequest, NoReplicaWindowError } from '../scm/replicaControl';
import { OVERLEAF_REF } from '../scm/replicaGit';
import { BuildCheck, checkBuild } from './buildCheck';
import type { CompileResult, JoinedProject } from './client';
import type { CompileRequest } from './guard';
import type { ProjectRanges } from './ranges';

/*
 * Landing a commit of a local replica's repository in its Overleaf project (replica-land):
 *
 * 1. the IDE window that keeps the replica in sync syncs it, and Overleaf's state
 *    (refs/remotes/overleaf/main) must be the checked-out commit, the commit's parent;
 * 2. Overleaf must hold the parent file for file (a check of its own, as the editor reads the
 *    project: documents by their text, binary files by the hash Overleaf reports);
 * 3. the window pushes the commit (the land request of src/scm/replicaControl.ts): it
 *    fast-forwards the branch, uploads what the commit changed, renames as renames, and waits
 *    for Overleaf's acknowledgements;
 * 4. Overleaf must hold the commit, checked as in 2, for up to three minutes;
 * 5. one compile of the project, repeated while Overleaf answers that another compile of the
 *    user runs; its logs are kept in <git dir>/overleaf/compiles/<commit>, and checked for
 *    errors (buildCheck.ts);
 * 6. the command in git config overleaf.landCheck, if set, runs with the compile's folder and
 *    the parent's, e.g. a project's own check of where its pages fall.
 *
 * Without a commit, it checks and compiles the checked-out commit: steps 1, 2, 5 and 6.
 *
 * With the push through the git bridge, step 3 is git's: the branch fast-forwards to the
 * commit, the bridge's newest commit is joined with an anchor merge (src/gitbridge/anchor.ts),
 * and git pushes the branch after the check of comments and tracked changes. The window must
 * not upload meanwhile (its push mode "bridge"); without a window, the replica's repository
 * says what Overleaf's state is.
 */

export type Logger = (message: string) => void;

/** What the landing needs of Overleaf. */
export interface LandClient {
    readProject(projectId: string): Promise<{ joined: JoinedProject, ranges: ProjectRanges }>;
    compile(projectId: string, request: CompileRequest): Promise<CompileResult>;
    outputFile(file: OutputFileEntity, response: CompileResult['response']): Promise<Uint8Array>;
}

/** A request to the IDE window that keeps the replica in sync. */
export type AskWindow = (request: ControlRequest, timeoutMs: number) => Promise<ControlAnswer>;

export interface LandOptions {
    /** the commit to land; the checked-out commit when undefined */
    commit?: string;
    /** the replica folder, the repository's work tree */
    folder: string;
    projectId: string;
    /** whether the sync leaves a path ('/dir/name') out; such paths are not compared */
    isIgnored: (path: string) => boolean;
    /** how long the window may take to sync, and to push */
    windowTimeoutMs: number;
    /** how long Overleaf may take to show the commit, and how often to look */
    verifyTimeoutMs?: number;
    verifyIntervalMs?: number;
    /** compile after landing (default true) */
    compile?: boolean;
    /** the main document, relative to the project; the project's main document by default */
    main?: string;
    /** how the commit goes to Overleaf: through the window's uploads (default), or a git push through the bridge */
    push?: 'native' | 'bridge';
    /** the push through the bridge of the checked-out branch, which holds the commit */
    bridgePush?: (repo: Repo) => Promise<{ pushed: boolean, head: string }>;
    log: Logger;
    sleep?: (ms: number) => Promise<void>;
}

export interface LandReport {
    /** the commit landed or checked */
    commit: string;
    /** the checked-out commit before, which Overleaf held */
    parent: string;
    /** whether a push was needed */
    pushed: boolean;
    /** what the window answered to the push */
    push?: ControlAnswer;
    /** Overleaf's ref afterwards: the commit, or a commit on top of it with edits made meanwhile */
    overleaf?: string;
    /** files compared with Overleaf after the push */
    verified?: number;
    compile?: { status: string, attempts: number, dir: string, check?: BuildCheck };
    parentCompile?: { status: string, dir: string };
    hook?: { command: string, status: number | null, output: string };
}

/** Stopped before anything was pushed, or the push failed. */
export class LandError extends Error {
    constructor(message: string, readonly details: string[] = []) { super(message); }
}

/**
 * The files of `commit` that Overleaf does not hold as the commit has them; `checked` counts the
 * compared files, and `joined` is the project as Overleaf answered.
 */
export async function overleafDifferences(repo: Repo, commit: string, client: LandClient, projectId: string,
                                          isIgnored: (path: string) => boolean): Promise<{ checked: number, differing: string[], joined: JoinedProject }> {
    const { joined, ranges } = await client.readProject(projectId);
    const docs = new Map(ranges.docs.map(doc => [doc.path, doc.text]));
    const files = new Map<string, string | undefined>();
    const walk = (folder: FolderEntity, prefix: string) => {
        folder.fileRefs?.forEach(file => files.set(prefix + file.name, file.hash));
        folder.folders?.forEach(sub => walk(sub, `${prefix}${sub.name}/`));
    };
    walk(joined.project.rootFolder[0], '');
    const tree = repo.flatTree(commit);
    const differing: string[] = [];
    let checked = 0;
    for (const [p, entry] of tree) {
        if (isIgnored(`/${p}`)) { continue; }
        checked += 1;
        if (docs.has(p)) {
            const text = repo.run(['cat-file', 'blob', entry.oid]).stdout.toString('utf8');
            if (docs.get(p) !== text) { differing.push(`${p}: the document on Overleaf differs`); }
        } else if (files.has(p)) {
            if (files.get(p) !== entry.oid) { differing.push(`${p}: Overleaf's file has the hash ${files.get(p)}, the commit's ${entry.oid}`); }
        } else {
            differing.push(`${p}: not on Overleaf`);
        }
    }
    for (const p of [...docs.keys(), ...files.keys()]) {
        if (!tree.has(p) && !isIgnored(`/${p}`)) { differing.push(`${p}: on Overleaf, not in the commit`); }
    }
    return { checked, differing, joined };
}

/** The path of the project's main document, from the joined project. */
function mainDocument(joined: JoinedProject): string | undefined {
    const find = (folder: FolderEntity, prefix: string): string | undefined => {
        const doc = folder.docs?.find(d => d._id === joined.project.rootDoc_id);
        if (doc) { return prefix + doc.name; }
        for (const sub of folder.folders ?? []) {
            const found = find(sub, `${prefix}${sub.name}/`);
            if (found) { return found; }
        }
        return undefined;
    };
    return find(joined.project.rootFolder[0], '');
}

/** The outputs kept: the logs, and the files a check of the pages reads; the PDF stays on Overleaf. */
const keepOutput = (file: OutputFileEntity) => /^output\.(log|stdout|stderr|blg|ilg|aux|toc|lof|lot|idx|ind|bbl)$/.test(file.path);

/** Compile the project as it is on Overleaf, and save the outputs and Overleaf's answer in `dir`. */
export async function compileProject(client: LandClient, projectId: string, main: string, dir: string, log: Logger,
                                     sleep: (ms: number) => Promise<void>) {
    let attempts = 0;
    let result: CompileResult;
    for (;;) {
        attempts += 1;
        const started = Date.now();
        result = await client.compile(projectId, { rootResourcePath: main, draft: false, stopOnFirstError: false });
        const status = result.response.status;
        log(`compile status "${status}" after ${((Date.now() - started) / 1000).toFixed(1)} s`);
        if (status === 'too-recently-compiled' && attempts < 5) { await sleep(2000); continue; }
        // another compile of this user runs, e.g. the editor's after a change
        if (status === 'compile-in-progress' && attempts < 13) { await sleep(15000); continue; }
        break;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const response = result.response;
    for (const file of (response.outputFiles ?? []).filter(keepOutput)) {
        try {
            fs.writeFileSync(path.join(dir, file.path), await client.outputFile(file, response));
        } catch (error: any) {
            log(`could not save ${file.path}: ${error?.message ?? error}`);
        }
    }
    fs.writeFileSync(path.join(dir, 'compile-response.json'), JSON.stringify(response, null, 2) + '\n');
    return { status: response.status, attempts, dir };
}

export async function landCommit(repo: Repo, client: LandClient, ask: AskWindow, options: LandOptions): Promise<LandReport> {
    const log = options.log;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const gitDir = repo.gitDir();
    const compiles = path.join(gitDir, 'overleaf', 'compiles');

    // 1. the window syncs, and Overleaf's state is the checked-out commit
    const bridge = options.push === 'bridge';
    let synced: any;
    try {
        synced = await ask({ op: 'sync' }, options.windowTimeoutMs);
    } catch (error) {
        if (!(bridge && error instanceof NoReplicaWindowError)) { throw error; }
        log('no IDE window keeps the replica in sync; its repository says what Overleaf holds');
        synced = { ok: true, connected: true, window: false, git: { head: repo.commit('HEAD'), overleaf: repo.commit(OVERLEAF_REF), unmerged: [] } };
    }
    if (!synced.ok) { throw new LandError(`the IDE window could not sync the replica: ${synced.error}`); }
    if (!synced.connected) { throw new LandError('the IDE window is not connected to Overleaf'); }
    if (bridge && synced.window !== false && synced.modes?.push !== 'bridge') {
        throw new LandError('the IDE window uploads the files a commit changes (push mode native); for a push through the bridge set overleaf-workshop.localReplica.pushMode to "bridge", or land without --push bridge');
    }
    const head = synced.git?.head as string | undefined;
    const overleaf = synced.git?.overleaf as string | undefined;
    if (!head || head !== overleaf) {
        throw new LandError(`Overleaf's state (${OVERLEAF_REF}, ${overleaf?.slice(0, 7) ?? 'none'}) is not the checked-out commit (${head?.slice(0, 7) ?? 'none'}); commit or undo the local changes, or wait for the replica to record Overleaf's state`);
    }
    if (synced.git?.unmerged?.length) { throw new LandError(`the replica has conflicts to resolve: ${synced.git.unmerged.join(', ')}`); }
    const commit = repo.mustCommit(options.commit ?? head);
    if (commit !== head && !repo.isAncestor(head, commit)) {
        throw new LandError(`${commit.slice(0, 7)} does not descend from Overleaf's state ${head.slice(0, 7)}; rebase it onto ${head.slice(0, 7)} first`);
    }
    const report: LandReport = { commit, parent: head, pushed: false };

    // 2. Overleaf holds the parent, file for file
    const before = await overleafDifferences(repo, head, client, options.projectId, options.isIgnored);
    if (before.differing.length) {
        throw new LandError(`Overleaf does not hold ${head.slice(0, 7)}, which the replica recorded as its state`, before.differing);
    }
    log(`Overleaf holds ${head.slice(0, 7)} (${before.checked} files compared)`);

    // the main document, and a compile of the parent for the check hook to compare with
    const hook = repo.config('overleaf.landCheck');
    let main = options.main;
    if (options.compile !== false) {
        main ??= mainDocument(before.joined);
        if (!main) { throw new LandError('the project names no main document; give --main'); }
        const parentDir = path.join(compiles, head);
        if (hook && commit !== head && !fs.existsSync(path.join(parentDir, 'output.log'))) {
            log(`compiling ${head.slice(0, 7)} first, for overleaf.landCheck to compare with`);
            report.parentCompile = await compileProject(client, options.projectId, main, parentDir, log, sleep);
        }
    }

    // 3. the push, through the window or through the bridge
    if (commit !== head) {
        let expect = commit;
        if (bridge) {
            if (!options.bridgePush) { throw new LandError('no push through the bridge is available'); }
            if (repo.text(['status', '--porcelain', '--untracked-files=no'])) { throw new LandError('the replica folder has changes that are not committed'); }
            repo.run(['merge', '--ff-only', '--quiet', commit]);
            log(`pushing ${commit.slice(0, 7)} through the git bridge`);
            const pushed = await options.bridgePush(repo);
            report.pushed = true;
            report.push = { ok: true, ...pushed };
            log(`${pushed.pushed ? 'pushed' : 'nothing to push:'} ${pushed.head.slice(0, 7)} through the bridge`);
        } else {
            log(`pushing ${commit.slice(0, 7)} through the IDE window`);
            const answer = await ask({ op: 'land', commit }, options.windowTimeoutMs) as any;
            report.push = answer;
            report.pushed = true;
            if (!answer.ok) { throw new LandError(`the push failed: ${answer.error}`); }
            report.overleaf = answer.overleaf;
            log(`the window pushed ${commit.slice(0, 7)}; ${OVERLEAF_REF} is ${String(answer.overleaf).slice(0, 7)}${answer.editedSince ? ', with edits made on Overleaf meanwhile on top' : ''}`);
            // with edits made meanwhile, Overleaf holds the window's newer state
            if (answer.editedSince) { expect = answer.overleaf; }
        }

        // 4. Overleaf holds the commit
        const end = Date.now() + (options.verifyTimeoutMs ?? 180_000);
        for (;;) {
            const after = await overleafDifferences(repo, expect, client, options.projectId, options.isIgnored);
            if (after.differing.length === 0) {
                report.verified = after.checked;
                log(`Overleaf holds ${expect.slice(0, 7)} (${after.checked} files compared)`);
                break;
            }
            if (bridge && synced.window !== false) {
                // the window downloads what the bridge changed, then records it
                await ask({ op: 'sync' }, options.windowTimeoutMs).catch(() => undefined);
            }
            if (Date.now() > end) {
                throw new LandError(`the window pushed ${commit.slice(0, 7)}, but Overleaf still differs from it`, after.differing);
            }
            await sleep(options.verifyIntervalMs ?? 10_000);
        }
        if (bridge && synced.window !== false) {
            const after = await ask({ op: 'sync' }, options.windowTimeoutMs).catch(() => undefined) as any;
            report.overleaf = after?.git?.overleaf;
        }
    } else {
        report.overleaf = head;
        report.verified = before.checked;
    }

    // 5. the compile, and its check
    if (options.compile !== false) {
        const dir = path.join(compiles, commit);
        const compiled = await compileProject(client, options.projectId, main!, dir, log, sleep);
        report.compile = { ...compiled, check: compiled.status === 'success' ? checkBuild(dir) : undefined };

        // 6. the project's own check; a check of the checked-out commit compares with its parent's compile
        if (hook) {
            const parent = commit === head ? repo.commit(`${head}^`) : head;
            const parentDir = parent ? path.join(compiles, parent) : undefined;
            const result = spawnSync(hook, {
                shell: true, cwd: options.folder, encoding: 'utf8',
                env: {
                    ...process.env, OVERLEAF_COMMIT: commit, OVERLEAF_PARENT: parent ?? '', OVERLEAF_COMPILE: dir,
                    OVERLEAF_PARENT_COMPILE: parentDir && fs.existsSync(path.join(parentDir, 'output.log')) ? parentDir : '',
                    OVERLEAF_REPLICA: options.folder,
                },
            });
            report.hook = { command: hook, status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trimEnd() };
        }
    }
    const line = `${new Date().toISOString()} ${commit} parent ${head} ${report.pushed ? 'pushed' : 'checked'}`
        + `${report.compile ? `, compile ${report.compile.status}${report.compile.check ? (report.compile.check.ok ? ', no errors' : ', ERRORS') : ''}` : ''}`
        + `${report.hook ? `, landCheck exit ${report.hook.status}` : ''}\n`;
    fs.mkdirSync(path.join(gitDir, 'overleaf'), { recursive: true });
    fs.appendFileSync(path.join(gitDir, 'overleaf', 'landings.log'), line);
    return report;
}

/**
 * Bring `commit` (a commit or a ref of the repository `from`, e.g. a clone of the replica's
 * repository where the work happens) into the replica's repository, and return its id. It
 * fetches the commit itself, or else every branch of `from`, into refs/land/from/.
 */
export function fetchCommitFrom(repo: Repo, from: string, commit: string): string {
    const source = new Repo(from);
    const oid = source.mustCommit(commit);
    if (repo.commit(oid)) { return oid; }
    const direct = repo.run(['fetch', '--quiet', '--no-tags', from, oid], { allowFailure: true });
    if (direct.status !== 0 || !repo.commit(oid)) {
        repo.run(['fetch', '--quiet', '--no-tags', from, '+refs/heads/*:refs/land/from/*']);
    }
    return repo.mustCommit(oid);
}

/** Whether the landing's compile and checks all passed, by its report. */
export function landedCleanly(report: LandReport): boolean {
    if (report.compile && (report.compile.status !== 'success' || !report.compile.check?.ok)) { return false; }
    return !report.hook || report.hook.status === 0;
}
