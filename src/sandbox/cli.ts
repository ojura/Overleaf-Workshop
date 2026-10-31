#!/usr/bin/env node
/* eslint-disable @typescript-eslint/naming-convention */
import * as fs from 'fs';
import * as path from 'path';
import { formatGitTokenStatus, gitTokenStatus, knownGitBridgeUrl } from '../api/gitBridge';
import { OverleafClient } from './client';
import { cloneProject, credentialAnswer, credentialHelperCommand, fetchProject, parseCredentialInput, stableNodePath } from './git';
import { readStoredLogin, StoredLogin } from './login';
import { formatProjectInfo, gatherProjectInfo } from './projectInfo';
import { SandboxSafetyError } from './guard';
import { LockTimeoutError } from './lock';
import { describeFindings, describeRanges, exitStatusOf, pushCheck, RANGES_HELP } from './rangesCli';
import { ControlAnswer, NoReplicaWindowError, ReplicaTimeoutError, requestReplica } from '../scm/replicaControl';
import { describe, SyncSummary } from '../scm/replicaSync';
import { DEFAULT_IGNORE_PATTERNS } from '../scm/ignorePatterns';
import { Repo } from '../gitbridge/plumbing';
import { minimatch } from 'minimatch';
import { fetchCommitFrom, LandError, landCommit, landedCleanly, LandReport } from './land';
import { anchorBridge } from '../gitbridge/anchor';
import { bridgeBranch, pushToBridge } from '../gitbridge/flow';
import { OverleafHistory, Pacer } from '../gitbridge/history';
import { addBridgeRemote, rangesCheck } from '../gitbridge/overleaf';
import { connectReplica, CONNECT_REF } from '../scm/replicaConnect';
import { BaseAPI } from '../api/base';
import {
    createSandbox, readRecord, readReplica, recentRuns, recordFile, runCompile, runLogFile, RunOptions, sandboxStatus, sandboxUrl,
    settingsOf,
} from './sandbox';

const HELP = `Compile a local directory on Overleaf, in a private copy of a shared project;
describe a project; reach it through Overleaf's git bridge, and check what a push
would do to its comments and tracked changes; and have the IDE sync a local replica.

usage:
  node out/sandbox/cli.js init    --replica <folder> [--name <name>]
  node out/sandbox/cli.js status  --replica <folder>
  node out/sandbox/cli.js compile --replica <folder> --dir <folder> --main <file> [options]
  node out/sandbox/cli.js plan    --replica <folder> --dir <folder> --main <file> [options]
  node out/sandbox/cli.js ranges  --project <id> | --replica <folder>
  node out/sandbox/cli.js push-check --repo <folder> [--from <rev>] [--to <rev>] [--project <id>] [--user <id>]
  node out/sandbox/cli.js project-info (--replica <folder> | --project <id>) [--server <name>] [--json]
  node out/sandbox/cli.js git-token [--replica <folder>] [--server <name>]
  node out/sandbox/cli.js git-clone (--replica <folder> | --project <id>) --into <folder> [--server <name>]
  node out/sandbox/cli.js git-fetch --into <folder>
  node out/sandbox/cli.js git-credential get|store|erase --server <name> --bridge <url>
  node out/sandbox/cli.js replica-sync   --replica <folder> [--timeout <s>] [--json]
  node out/sandbox/cli.js replica-status --replica <folder> [--json]
  node out/sandbox/cli.js replica-land   --replica <folder> [<commit>] [--from <repo>] [--push native|bridge] [--main <file>] [--no-compile] [--timeout <s>] [--json]
  node out/sandbox/cli.js replica-connect --replica <folder> --history <repo> [--ref <branch>] [--start-version <n>] [--not-own <glob>] [--pace <ms>] [--json]
  node out/sandbox/cli.js replica-bridge  --replica <folder> [--label <comment>] [--remote <name>] [--bridge <url>] [--json]

--replica <folder>  the shared project's local replica. Its .overleaf/settings.json names
                    the project; .overleaf/sandbox.json records the private copy.

init     Clones the shared project once into a new project of this account, named
         "<project> (sandbox)" unless --name says otherwise, sets the copy's compiler
         and TeX Live image to the shared project's, and records the copy. Every later
         run reuses it.
status   Checks the recorded copy (owned by this account, no collaborators, no invites,
         link sharing off) and shows its settings, the shared project's, and who holds
         the lock.
compile  Makes the copy hold --dir laid over the shared project, compiles --main there
         and saves the results in --out. Runs on the same copy wait for each other.
plan     Says what compile would upload and delete, without writing anything.

${RANGES_HELP}
project-info  Reads a project without changing it: its settings and features (gitBridge
              among them), the owner, your access level, the collaborators and invites,
              link sharing, who has track changes on, the comments and tracked changes of
              every document and the comment threads, and the git token's state. It joins
              the project once, as the editor does, so others see you online meanwhile.
git-token     Says whether the extension keeps a git token for this account, whether the
              git bridge accepts it, and how Account Settings lists it. The check asks the
              bridge for a project id that no project can have, so it does not make a
              commit on Overleaf; it does count as a use of the token.
git-clone     Clones the project through the git bridge into --into. git gets the token
              from git-credential, and the clone keeps that helper in its own
              configuration, so git fetch and git pull work there. Neither the address nor
              any configuration holds the token. Overleaf makes a commit for the
              project's current state when none exists yet.
git-fetch     git fetch in such a clone. It too makes Overleaf commit the current state
              when none exists yet.
git-credential  The credential helper that git-clone configures; git starts it.

--server <name>  the server's name in the extension, e.g. www.overleaf.com; by default the
                 replica's, or www.overleaf.com
--bridge <url>   the server's git bridge; www.overleaf.com's is known. A project's editor
                 page names it in the meta tag ol-gitBridgePublicBaseUrl.

The git token is the one the extension keeps next to its login (Overleaf Workshop: Git
Token..., on a server of the Projects view). OVERLEAF_LOGIN may give it as "gitToken".

What the copy holds for a compile:
  a path in --dir                 the directory's file
  a path only in the shared       the shared project's current version
  project
  a path only in the copy         deleted: an earlier run uploaded it
Only files that differ from the copy are uploaded: binary files are compared by the
hash Overleaf reports for them, documents by their text.

compile and plan options:
  --dir <folder>          the version to compile, e.g. a git archive of a commit
  --main <file>           the main document, relative to --dir, e.g. main.tex
  --out <folder>          where to save the results. It must be new, empty, or an
                          earlier run's output folder, which is emptied first.
                          Default: a new folder below $TMPDIR/overleaf-sandbox/.
  --mirror                --dir is the whole project: paths it lacks are deleted
                          from the copy instead of taken from the shared project,
                          except the paths --keep matches
  --keep <glob>           with --mirror, take these paths from the shared project
                          (repeatable), e.g. --keep 'slike/**'
  --ignore <glob>         also skip these paths of --dir (repeatable). Dot files and
                          folders and the products of a local LaTeX build are
                          skipped by default, as by the local replica.
  --include <glob>        do not skip these paths (repeatable), e.g. .latexmkrc
  --incremental           keep the previous compile's output on Overleaf. By default
                          it is cleared first, as by "Recompile from scratch".
  --draft                 compile in draft mode
  --stop-on-first-error   stop at the first error
  --pdf                   also download output.pdf. It is left on Overleaf by default:
                          the book's PDF is 885 MB, and each run saves a new copy.
  --lock-timeout <s>      how long to wait for another run on the copy; default 3600,
                          0 fails at once
  --purpose <text>        what this run is for, shown to runs that wait for it
  --json                  print run.json instead of the summary

Each run adds its start and its end to .overleaf/sandbox-runs.jsonl in the replica:
what it was for, the directory, the main document, its status and where its results
are. status shows the latest entries.

Results in --out: every output file Overleaf returned (output.log, output.blg,
output.ilg, output.stdout, output.stderr, ...; output.pdf with --pdf); compile-response.json,
Overleaf's answer with "status", "timings" (milliseconds) and "stats"; and run.json:
what was uploaded and deleted, the settings, the tool's own timings in milliseconds,
and a summary of output.log.

Exit status: 0 the compile's status is "success"; 3 the compile ran with another
status (failure, timedout, ...) and its results are saved; 1 the tool failed; 2 wrong
arguments.

replica-sync    Asks the IDE window that keeps the replica in sync with Overleaf to look
                for files changed on disk, upload them, and wait until Overleaf has
                acknowledged every local change so far; e.g. after a program wrote files
                into the folder. The window answers on a local socket, also while it is in
                the background, and does not come to the front. It also scans when
                overleaf-workshop.localReplica.syncOnFileChange is off.
replica-status  Shows whether the window is connected to Overleaf, how it watches the
                folder, what it synced in the last 10 minutes, and the replica's git state:
                the checked-out commit and Overleaf's state (refs/remotes/overleaf/main).
--timeout <s>   how long to wait for the window's answer; default 300
Exit status of both: 0 in sync (replica-status: the window answered); 3 a file could not
be synced or has conflict markers, listed; 4 no IDE window keeps the folder in sync (the
IDE is not running, or it has not opened the folder as a replica); 5 the window did not
answer in time; 1 the tool failed; 2 wrong arguments.

replica-land    Lands <commit> of the replica's git repository in the project, then compiles
                the project. The commit must descend from the checked-out commit, which
                must be Overleaf's state: the window syncs first, and the tool checks that
                Overleaf holds that commit file for file (documents by their text, binary
                files by the hash Overleaf reports). Then the window pushes the commit: it
                fast-forwards the branch, uploads what the commit changed (a rename as a
                rename on Overleaf, so documents keep their comments) and waits for
                Overleaf's acknowledgements. The tool checks again that Overleaf holds the
                commit, for up to three minutes, and compiles the project once (again while
                Overleaf answers that another compile of yours runs). The compile's logs are
                kept in <git dir>/overleaf/compiles/<commit>/ and checked: an error line
                ("! ") in output.log, no "Output written on output.pdf", latexmk's
                "Collected error summary", an "Automatic index:" line in output.stderr, or
                "The index was not built/sorted" fails the landing. The warnings are listed
                by kind. Then, when git config overleaf.landCheck names a command, it runs in
                the replica folder with OVERLEAF_COMPILE (the compile's folder),
                OVERLEAF_PARENT_COMPILE (the parent's, compiled first when missing),
                OVERLEAF_COMMIT and OVERLEAF_PARENT, e.g. a check of where the pages of the
                contents fall. Without <commit>, the checked-out commit is checked and
                compiled. <git dir>/overleaf/landings.log lists the landings.
--from <repo>   take <commit> from that repository, e.g. a clone of the replica's
                repository where the work happens: <commit> is resolved there (HEAD by
                default) and fetched into the replica's repository first
--push bridge   push through the git bridge instead: the branch fast-forwards to the
                commit, the bridge's newest commit is joined with an anchor merge (as
                node out/sandbox/cli.js replica-bridge does), and git pushes the branch to
                the remote "bridge" (added when missing) after the check of comments and
                tracked changes (push-check). Overleaf shows the push as one version "via
                Git", and every file of the commit goes into the project, also the ones the
                replica's ignore patterns leave out. The window must not upload meanwhile:
                its overleaf-workshop.localReplica.pushMode must be "bridge". Without a
                window it works from the repository's refs.
--main <file>   the main document; by default the project's
--no-compile    land and check, without the compile
Exit status: 0 landed and compiled without errors; 3 landed, but the compile or a check
failed; 1 stopped before the push, or the push failed (the message says why); 4 and 5 as
for replica-sync; 2 wrong arguments.

replica-connect Connects a development history with the replica's repository, for a history
                that started from a copy of the project's files. It fetches --ref (default
                master) of --history, which it only reads, writes its commits again on top of
                the project's state where the history started (from the project's history,
                or --start-version), each with a Rewritten-from trailer, and merges them with
                Overleaf's state as the replica recorded it (refs/remotes/overleaf/main). The
                result is in refs/connect/merge, on top of the replica's checked-out commit;
                replica-land lands it, which uploads the files the history adds to the
                project. It lists those files, and the project files the history changes. The
                replica must be in sync: its checked-out commit is Overleaf's state. Running
                it again gives the same rewritten commits, and once the replica's branch
                contains them it says so.
--not-own <glob>  a file of the history to leave out of the project (repeatable)
--pace <ms>     the pause between requests to the project's history (default 3000); Overleaf
                answers faster ones with HTTP 429

replica-bridge  Brings the git bridge's newest commit into the replica's repository and joins
                it with the replica's commits, so that a push through the bridge is a
                fast-forward; the fetch modes "mixed" and "bridge" run it. It fetches --remote
                (default bridge, added for the project's address on the bridge when missing,
                with git-credential of this tool as its credential helper) and, when the
                checked-out branch lacks the bridge's commit, makes an anchor merge: parents
                the checked-out commit and the bridge's, tree unchanged. That needs a commit
                of the replica's with the bridge commit's files, or a bridge commit older than
                the replica's newest recorded state; a bridge commit with changes the replica
                has not recorded yet waits for a later fetch. --label <comment> first labels
                the project's current version, which collaborators see in the history's
                Labels tab, so that the bridge's commit holds exactly that version. Exit
                status 3 when nothing was joined.

Safety: the tool writes only to the project recorded in .overleaf/sandbox.json, which
init created, and refuses the shared project's id and every other one. Before each
write it joins the copy again and stops unless this account owns it, it has no
collaborators and no pending invites, link sharing is off, and its name is the
recorded one.

Login: the Overleaf Workshop extension's login, read from the IDE's state database
(Antigravity, VS Code and its variants), which is opened read-only. --state-db <file>
names the database. The environment variable OVERLEAF_LOGIN, a JSON object
{"url", "cookies", "csrfToken", "userId"}, takes precedence.
`;

const VALUE_FLAGS = new Set(['replica', 'dir', 'main', 'out', 'keep', 'ignore', 'include', 'lock-timeout', 'purpose', 'name', 'state-db',
    'project', 'repo', 'from', 'to', 'user', 'server', 'into', 'bridge',
    'timeout', 'push', 'from', 'history', 'ref', 'start-version', 'not-own', 'pace', 'label', 'remote']);
const GIT_AND_INFO_COMMANDS = ['project-info', 'git-token', 'git-clone', 'git-fetch', 'git-credential'];
const OBJECT_ID = /^[0-9a-f]{24}$/;
const REPEATABLE = new Set(['keep', 'ignore', 'include', 'not-own']);
const BOOLEAN_FLAGS = new Set(['mirror', 'incremental', 'draft', 'stop-on-first-error', 'pdf', 'json', 'help', 'no-compile']);

class UsageError extends Error {}

function parseArgs(argv: string[]) {
    const values: Record<string, string> = {};
    const lists: Record<string, string[]> = { keep: [], ignore: [], include: [], 'not-own': [] };
    const flags = new Set<string>();
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) { positional.push(arg); continue; }
        const eq = arg.indexOf('=');
        const key = arg.slice(2, eq < 0 ? undefined : eq);
        if (BOOLEAN_FLAGS.has(key)) {
            if (eq >= 0) { throw new UsageError(`--${key} takes no value`); }
            flags.add(key);
        } else if (VALUE_FLAGS.has(key)) {
            const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
            if (value === undefined) { throw new UsageError(`--${key} needs a value`); }
            if (REPEATABLE.has(key)) { lists[key].push(value); } else { values[key] = value; }
        } else {
            throw new UsageError(`unknown option --${key}`);
        }
    }
    return { values, lists, flags, positional };
}

const log = (message: string) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${message}\n`);
const kb = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} kB`;

function printSummary(summary: any, out?: string) {
    const lines: string[] = [];
    const compile = summary.compile;
    if (compile) {
        lines.push(`status: ${compile.status}${compile.attempts > 1 ? ` (after ${compile.attempts} attempts)` : ''}`);
        if (compile.timings) {
            lines.push(`Overleaf's timings (ms): ${Object.entries(compile.timings).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        }
        if (compile.stats) {
            lines.push(`Overleaf's stats: ${Object.entries(compile.stats).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        }
    }
    if (summary.settings) {
        lines.push(`compiled with: ${summary.settings.compiler}, image ${summary.settings.imageName}, main document ${summary.main}`);
    }
    if (summary.plan) {
        const uploads = summary.plan.uploads as Array<{ path: string, from: string }>;
        lines.push(`synced: ${uploads.length} uploaded${uploads.length ? ` (${uploads.map(u => u.path.slice(1) + (u.from === 'shared' ? ' from the shared project' : '')).join(', ')})` : ''}, ${summary.plan.deletions.length} deleted${summary.plan.deletions.length ? ` (${summary.plan.deletions.map((d: any) => d.path.slice(1)).join(', ')})` : ''}, ${summary.plan.unchangedFromLocal + summary.plan.unchangedFromShared} already as wanted`);
    }
    if (summary.log) {
        const l = summary.log;
        lines.push(`output.log: ${l.errors} errors, ${l.warnings} warnings, ${l.undefinedReferences.length} undefined references, ${l.undefinedCitations.length} undefined citations, ${l.badBoxes} over- or underfull boxes${l.rerunWarning ? ', asks for a rerun' : ''}`);
        l.firstErrors.slice(0, 5).forEach((e: string) => lines.push(`  error: ${e}`));
    }
    if (summary.indexLog) {
        lines.push(`output.ilg begins: ${summary.indexLog.split('\n')[0]}`);
    }
    if (summary.outputs) {
        lines.push(`saved in ${out}: ${summary.outputs.saved.map((f: any) => `${f.path} (${kb(f.bytes)})`).join(', ')}, compile-response.json, run.json`);
        summary.outputs.failed.forEach((f: any) => lines.push(`  not saved: ${f.path}: ${f.error}`));
        if (summary.outputs.notDownloaded.length) { lines.push(`  not downloaded: ${summary.outputs.notDownloaded.join(', ')} (--pdf downloads output.pdf)`); }
    }
    if (summary.timingsMs) {
        lines.push(`this run's timings (ms): ${Object.entries(summary.timingsMs).map(([k, v]) => `${k} ${v}`).join(', ')}; ${summary.checks ?? 0} safety checks`);
    }
    process.stdout.write(lines.join('\n') + '\n');
}

/** The server name and project id: --replica, or --server and --project. */
function serverAndProject(values: Record<string, string>): { serverName: string, projectId?: string } {
    const replica = values.replica ? readReplica(path.resolve(values.replica)) : undefined;
    const projectId = values.project ?? replica?.projectId;
    if (projectId !== undefined && !OBJECT_ID.test(projectId)) { throw new UsageError(`--project takes a project id (24 hexadecimal digits), not ${projectId}`); }
    return { serverName: values.server ?? replica?.serverName ?? 'www.overleaf.com', projectId };
}

/** The git bridge for `login`: --bridge, or the known one of its server. */
const bridgeOf = (login: StoredLogin, values: Record<string, string>) => values.bridge ?? knownGitBridgeUrl(login.url);

async function gitAndInfoCommand(command: string, values: Record<string, string>, flags: Set<string>, positional: string[]): Promise<number> {
    if (command === 'git-credential') {
        // git starts this with "get", "store" or "erase" and the request on stdin; only the
        // answer may go to stdout
        const action = positional[1];
        if (!['get', 'store', 'erase'].includes(action)) { throw new UsageError('git-credential takes get, store or erase'); }
        if (!values.bridge) { throw new UsageError('git-credential needs --bridge'); }
        const request = parseCredentialInput(fs.readFileSync(0, 'utf8'));
        let token: string | undefined;
        if (action === 'get') {
            const serverName = values.server ?? 'www.overleaf.com';
            token = readStoredLogin(serverName, values['state-db']).gitToken;
            if (!token) { log(`no git token is stored for ${serverName}; store one with the extension (Overleaf Workshop: Git Token...)`); }
        }
        process.stdout.write(credentialAnswer(action, request, values.bridge, token));
        return 0;
    }
    if (positional.length > 1) { throw new UsageError(`unexpected argument ${positional[1]}`); }

    if (command === 'git-fetch') {
        if (!values.into) { throw new UsageError('--into is required'); }
        log('fetching; Overleaf makes a commit for the project\'s current state when none exists yet');
        fetchProject({ into: path.resolve(values.into) });
        return 0;
    }

    const { serverName, projectId } = serverAndProject(values);
    const login = readStoredLogin(serverName, values['state-db']);
    const client = new OverleafClient(login.url, login.identity);

    if (command === 'git-token') {
        if (!login.gitToken) {
            process.stdout.write(`${formatGitTokenStatus({ stored: false })} (account ${login.userId} on ${serverName})\n`);
            return 1;
        }
        const status = await gitTokenStatus(() => client.gitTokens(), login.gitToken, bridgeOf(login, values));
        process.stdout.write(`${formatGitTokenStatus(status)} (account ${login.userId} on ${serverName})\n`);
        return status.check === 'accepted' ? 0 : 1;
    }

    if (!projectId) { throw new UsageError(`${command} needs --replica or --project`); }

    if (command === 'project-info') {
        const info = await gatherProjectInfo(client, projectId, { token: login.gitToken, bridgeUrl: bridgeOf(login, values) });
        process.stdout.write(flags.has('json') ? JSON.stringify(info, null, 2) + '\n' : formatProjectInfo(info));
        return 0;
    }

    // git-clone
    if (!values.into) { throw new UsageError('--into is required'); }
    if (!login.gitToken) { throw new Error(`no git token is stored for ${serverName}; store one with the extension (Overleaf Workshop: Git Token...)`); }
    const bridgeUrl = bridgeOf(login, values);
    if (!bridgeUrl) { throw new Error(`the git bridge of ${serverName} is not known; give --bridge <url> (a project's editor page names it in ol-gitBridgePublicBaseUrl)`); }
    const into = path.resolve(values.into);
    log(`cloning ${projectId} from ${bridgeUrl}; Overleaf makes a commit for the project's current state when none exists yet`);
    cloneProject({ bridgeUrl, projectId, into, helper: credentialHelperCommand(stableNodePath(process.execPath), __filename, serverName, bridgeUrl) });
    process.stdout.write(`cloned ${projectId} into ${into}; git fetch and git pull there get the token from this tool\n`);
    return 0;
}

/** replica-sync and replica-status: ask the IDE window that keeps the replica in sync. */
async function replicaCommand(command: 'replica-sync' | 'replica-status', folder: string, timeoutS: number, json: boolean): Promise<number> {
    let answer: ControlAnswer;
    try {
        answer = await requestReplica(folder, { op: command === 'replica-sync' ? 'sync' : 'status' }, timeoutS * 1000);
    } catch (error: any) {
        if (error instanceof NoReplicaWindowError) { log(error.message); return 4; }
        if (error instanceof ReplicaTimeoutError) { log(error.message); return 5; }
        throw error;
    }
    if (json) {
        process.stdout.write(JSON.stringify(answer, null, 2) + '\n');
    } else {
        const a = answer as any;
        const lines = [`${a.folder ?? folder}: ${a.connected ? 'connected to' : 'not connected to'} ${a.project?.server ?? 'Overleaf'} ("${a.project?.name ?? '?'}"), changes reported by ${a.watcher === 'node' ? "Node's watcher" : "the IDE's file events"}${a.modes ? `, fetch mode ${a.modes.fetch}, push mode ${a.modes.push}` : ''}${a.fullSyncRunning ? ', a full sync is running' : ''}`];
        if (a.git) {
            const g = a.git as { head?: string, overleaf?: string, branch?: string, unmerged?: string[] };
            lines.push(`git: ${g.branch ?? 'detached HEAD'} at ${g.head?.slice(0, 7) ?? 'no commit'}, Overleaf's state (refs/remotes/overleaf/main) ${g.overleaf?.slice(0, 7) ?? 'not recorded yet'}${g.head && g.head === g.overleaf ? ', the same' : ''}${g.unmerged?.length ? `; conflicts to resolve in ${g.unmerged.join(', ')}` : ''}`);
        }
        if (a.summary) { lines.push(`this sync: ${describe(a.summary as SyncSummary)}`); }
        if (!answer.ok) { lines.push(`not in sync: ${answer.error}`); }
        const recent = (a.recent ?? []) as Array<{ path: string, what: string, at: string }>;
        lines.push(recent.length
            // local time, as in the IDE's log of the replica
            ? `synced in the last 10 minutes: ${recent.map(r => `${r.path} ${r.what} at ${new Date(r.at).toTimeString().slice(0, 8)}`).join(', ')}`
            : 'synced in the last 10 minutes: nothing');
        process.stdout.write(lines.join('\n') + '\n');
    }
    return answer.ok ? 0 : 3;
}

/** The paths the replica leaves out, by its default ignore patterns; '/dir/name' */
const replicaIgnored = (p: string) => p === '/.overleaf' || p.startsWith('/.overleaf/') || DEFAULT_IGNORE_PATTERNS.some(g => minimatch(p, g, { dot: true }));

/** replica-connect: join a development history with the replica's repository (src/scm/replicaConnect.ts). */
async function replicaConnectCommand(folder: string, values: Record<string, string>, notOwn: string[], json: boolean): Promise<number> {
    if (!values.history) { throw new UsageError('replica-connect needs --history'); }
    const replica = readReplica(folder);
    const login = readStoredLogin(replica.serverName, values['state-db']);
    const pace = values.pace ? Number(values.pace) : 3000;
    if (!Number.isFinite(pace) || pace < 0) { throw new UsageError('--pace takes milliseconds'); }
    let startVersion: number | undefined;
    if (values['start-version'] !== undefined) {
        startVersion = Number(values['start-version']);
        if (!Number.isInteger(startVersion) || startVersion < 0) { throw new UsageError('--start-version takes a version number'); }
    }
    const result = await connectReplica(new Repo(folder), {
        historyRepo: path.resolve(values.history), ref: values.ref ?? 'master', startVersion, log,
        history: new OverleafHistory(login.url, login.identity, replica.projectId, new Pacer(pace, undefined, log)),
        notOwn: notOwn.length ? (p: string) => notOwn.some(g => minimatch(p, g, { dot: true })) : undefined,
    });
    const short = (oid: string) => oid.slice(0, 7);
    if (json) {
        process.stdout.write(JSON.stringify(result, null, 1) + '\n');
    } else if (result.already) {
        process.stdout.write(`the replica's branch already contains ${short(result.local)} (as ${short(result.already)}); nothing to connect\n`);
    } else {
        const m = result.merge!;
        process.stdout.write([
            `rebase: ${result.rebase!.map.length} commits written again on ${short(result.rebase!.start)}${result.rebase!.startMade ? ' (made from the project\'s history)' : ''}; old and new ids in ${result.mapFile}`,
            `merge: ${short(m.commit)} in ${CONNECT_REF}, on top of Overleaf's state; ${m.how === 'held' ? `the rewritten ${short(m.heldAt!)} holds Overleaf's state` : m.how === 'three-way' ? `a three-way merge from ${short(m.base!)}` : `Overleaf's version taken for ${m.tookOverleaf.join(', ')}`}`,
            `files the history adds to the project: ${m.own.length ? m.own.join(', ') : 'none'}`,
            `project files it changes: ${m.carries.length ? m.carries.join(', ') : 'none'}`,
            ...(m.deletedOnOverleaf.length ? [`deleted on Overleaf, left out: ${m.deletedOnOverleaf.join(', ')}`] : []),
            `next: node out/sandbox/cli.js replica-land --replica "${folder}" ${CONNECT_REF}`,
        ].join('\n') + '\n');
    }
    return 0;
}

/** replica-bridge: fetch the git bridge's newest commit into the replica's repository and join it (src/gitbridge/anchor.ts). */
async function replicaBridgeCommand(folder: string, values: Record<string, string>, json: boolean): Promise<number> {
    const replica = readReplica(folder);
    const repo = new Repo(folder);
    const name = values.remote ?? 'bridge';
    if (repo.run(['remote', 'get-url', name], { allowFailure: true }).status !== 0) {
        const { url } = addBridgeRemote(repo, { remote: name, projectId: replica.projectId, serverName: replica.serverName, bridgeUrl: values.bridge });
        log(`added the remote ${name}: ${url}`);
    }
    if (values.label !== undefined) {
        const login = readStoredLogin(replica.serverName, values['state-db']);
        const history = new OverleafHistory(login.url, login.identity, replica.projectId, new Pacer(1200, undefined, log));
        const newest = (await history.updates()).updates[0];
        if (!newest) { throw new Error('the project\'s history has no version to label'); }
        const res = await new BaseAPI(login.url).createLabel(login.identity, replica.projectId, values.label, newest.toV);
        if (res.type !== 'success') { throw new Error(`labelling version ${newest.toV} failed: ${res.message}`); }
        log(`labelled version ${newest.toV}: ${values.label}`);
    }
    log(`fetching ${name}; the bridge makes a commit for the project's current state when it has none`);
    repo.run(['fetch', '--quiet', name]);
    const fetched = bridgeBranch(repo, name);
    const result = anchorBridge(repo, `refs/remotes/${name}/${fetched.branch}`, p => !replicaIgnored(`/${p}`), { log });
    const short = (oid: string) => oid.slice(0, 7);
    process.stdout.write(json ? JSON.stringify(result, null, 1) + '\n'
        : result.outcome === 'up-to-date' ? `the branch already contains the bridge's ${short(result.bridge)}\n`
        : result.outcome === 'anchored' ? `joined the bridge's ${short(result.bridge)} with an anchor merge, ${short(result.commit!)}${result.twin ? `; it holds the files of ${short(result.twin)}` : ''}\n`
        : result.outcome === 'newer' ? `the bridge's ${short(result.bridge)} has changes the replica has not recorded yet; nothing joined\n`
        : 'the checked-out branch lacks the replica\'s recorded state; nothing joined\n');
    return result.outcome === 'up-to-date' || result.outcome === 'anchored' ? 0 : 3;
}

/** replica-land: land a commit of the replica's repository through the IDE window, verify it on Overleaf, compile. */
async function replicaLand(folder: string, commit: string | undefined,
                           options: { main?: string, compile: boolean, timeoutS: number, json: boolean, stateDb?: string, push: 'native' | 'bridge' }): Promise<number> {
    const replica = readReplica(folder);
    const login = readStoredLogin(replica.serverName, options.stateDb);
    const client = new OverleafClient(login.url, login.identity);
    const isIgnored = replicaIgnored;
    let report: LandReport;
    try {
        report = await landCommit(new Repo(folder), client, (request, timeoutMs) => requestReplica(folder, request, timeoutMs), {
            commit, folder, projectId: replica.projectId, isIgnored, windowTimeoutMs: options.timeoutS * 1000,
            compile: options.compile, main: options.main, log, push: options.push,
            bridgePush: async (repo) => {
                const remote = 'bridge';
                if (repo.run(['remote', 'get-url', remote], { allowFailure: true }).status !== 0) {
                    log(`added the remote ${remote}: ${addBridgeRemote(repo, { remote, projectId: replica.projectId, serverName: replica.serverName }).url}`);
                }
                repo.run(['fetch', '--quiet', remote]);
                const fetched = bridgeBranch(repo, remote);
                const joined = anchorBridge(repo, `refs/remotes/${remote}/${fetched.branch}`, p => !isIgnored(`/${p}`), { log });
                if (joined.outcome === 'newer' || joined.outcome === 'diverged') {
                    throw new LandError(joined.outcome === 'newer'
                        ? 'the bridge has changes the replica has not recorded yet; let the replica sync, then land again'
                        : 'the checked-out branch lacks the replica\'s recorded state');
                }
                const pushed = await pushToBridge(repo, remote, { check: rangesCheck({ serverName: replica.serverName, projectId: replica.projectId, acceptWarnings: false }), log });
                return { pushed: pushed.pushed, head: pushed.head };
            },
        });
    } catch (error: any) {
        if (error instanceof NoReplicaWindowError) { log(error.message); return 4; }
        if (error instanceof ReplicaTimeoutError) { log(error.message); return 5; }
        if (error instanceof LandError) {
            log(`STOPPED: ${error.message}`);
            error.details.slice(0, 30).forEach(line => log(`  ${line}`));
            if (error.details.length > 30) { log(`  ... and ${error.details.length - 30} more`); }
            return 1;
        }
        throw error;
    }
    if (options.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        return landedCleanly(report) ? 0 : 3;
    }
    const short = (oid?: string) => oid?.slice(0, 7) ?? 'none';
    const lines: string[] = [];
    lines.push(report.pushed
        ? `landed ${short(report.commit)} on top of ${short(report.parent)}; Overleaf's state is ${short(report.overleaf)}${report.overleaf !== report.commit ? ' (with edits made on Overleaf meanwhile)' : ''}`
        : `Overleaf holds the checked-out commit ${short(report.commit)}`);
    const summary = (report.push as any)?.summary as SyncSummary | undefined;
    if (summary) { lines.push(`push: ${describe(summary)}${summary.renamed?.length ? `; renamed ${summary.renamed.map(r => `${r.from} -> ${r.to}`).join(', ')}` : ''}`); }
    if (report.verified !== undefined) { lines.push(`Overleaf holds every file of it (${report.verified} compared)`); }
    if (report.parentCompile) { lines.push(`compiled the parent first: ${report.parentCompile.status} (${report.parentCompile.dir})`); }
    if (report.compile) {
        const check = report.compile.check;
        lines.push(`compile: ${report.compile.status}${report.compile.attempts > 1 ? ` after ${report.compile.attempts} attempts` : ''}${check?.pages ? `, ${check.pages} pages` : ''}; logs in ${report.compile.dir}`);
        if (check) {
            lines.push(check.ok ? 'check: no errors' : 'check: FAILED');
            check.problems.forEach(problem => lines.push(`  ${problem}`));
            check.notes.forEach(note => lines.push(`  note: ${note}`));
            if (check.warnings.length) {
                lines.push('warnings by kind:');
                check.warnings.slice(0, 20).forEach(w => lines.push(`  ${String(w.count).padStart(5)} ${w.kind}`));
            }
        }
    }
    if (report.hook) {
        lines.push(`overleaf.landCheck (${report.hook.command}) exited with ${report.hook.status}${report.hook.output ? ':' : ''}`);
        if (report.hook.output) { lines.push(...report.hook.output.split('\n').map(line => `  ${line}`)); }
    }
    process.stdout.write(lines.join('\n') + '\n');
    return landedCleanly(report) ? 0 : 3;
}

async function main(argv: string[]): Promise<number> {
    const { values, lists, flags, positional } = parseArgs(argv);
    const command = positional[0];
    if (flags.has('help') || command === undefined || command === 'help') {
        process.stdout.write(HELP);
        return command === undefined && !flags.has('help') ? 2 : 0;
    }
    if (GIT_AND_INFO_COMMANDS.includes(command)) {
        return gitAndInfoCommand(command, values, flags, positional);
    }
    if (!['init', 'status', 'compile', 'plan', 'ranges', 'push-check', 'replica-sync', 'replica-status', 'replica-land', 'replica-connect', 'replica-bridge'].includes(command)) { throw new UsageError(`unknown command ${command}`); }
    if (command === 'replica-connect' || command === 'replica-bridge') {
        if (!values.replica) { throw new UsageError('--replica is required'); }
        if (positional.length > 1) { throw new UsageError(`unexpected argument ${positional[1]}`); }
        return command === 'replica-connect'
            ? await replicaConnectCommand(path.resolve(values.replica), values, lists['not-own'], flags.has('json'))
            : await replicaBridgeCommand(path.resolve(values.replica), values, flags.has('json'));
    }
    if (command === 'replica-land') {
        if (!values.replica) { throw new UsageError('--replica is required'); }
        if (positional.length > 2) { throw new UsageError(`unexpected argument ${positional[2]}`); }
        const timeoutS = Number(values.timeout ?? 600);
        if (!(timeoutS > 0)) { throw new UsageError('--timeout takes a number of seconds'); }
        const push = values.push ?? 'native';
        if (push !== 'native' && push !== 'bridge') { throw new UsageError('--push takes native or bridge'); }
        let commit = positional[1];
        if (values.from) {
            commit = fetchCommitFrom(new Repo(path.resolve(values.replica)), path.resolve(values.from), commit ?? 'HEAD');
            log(`took ${commit.slice(0, 7)} from ${path.resolve(values.from)}`);
        }
        return await replicaLand(path.resolve(values.replica), commit, { main: values.main, compile: !flags.has('no-compile'), timeoutS, json: flags.has('json'), stateDb: values['state-db'], push });
    }
    if (positional.length > 1) { throw new UsageError(`unexpected argument ${positional[1]}`); }
    if (command === 'ranges' || command === 'push-check') {
        const { serverName, projectId } = serverAndProject(values);
        const login = readStoredLogin(serverName, values['state-db']);
        const client = new OverleafClient(login.url, login.identity);
        if (command === 'ranges') {
            if (!projectId) { throw new UsageError('ranges needs --project or --replica'); }
            const state = await client.readRanges(projectId);
            process.stdout.write(flags.has('json') ? JSON.stringify(state, null, 2) + '\n' : describeRanges(state));
            return 0;
        }
        if (!values.repo) { throw new UsageError('push-check needs --repo'); }
        const result = await pushCheck(client, { repo: values.repo, from: values.from, to: values.to, project: projectId, userId: values.user ?? login.userId });
        process.stdout.write(flags.has('json') ? JSON.stringify({ summary: result.summary, findings: result.findings }, null, 2) + '\n' : describeFindings(result.findings, result.summary));
        return exitStatusOf(result.findings);
    }
    if (!values.replica) { throw new UsageError('--replica is required'); }
    if (command === 'replica-sync' || command === 'replica-status') {
        const timeoutS = Number(values.timeout ?? 300);
        if (!(timeoutS > 0)) { throw new UsageError('--timeout takes a number of seconds'); }
        return await replicaCommand(command, path.resolve(values.replica), timeoutS, flags.has('json'));
    }

    const replica = readReplica(path.resolve(values.replica));
    const login = readStoredLogin(replica.serverName, values['state-db']);
    const client = new OverleafClient(login.url, login.identity);

    if (command === 'init') {
        const existing = readRecord(replica.folder);
        if (existing) {
            log(`a sandbox is already recorded in ${recordFile(replica.folder)}: "${existing.projectName}", ${sandboxUrl(existing)}`);
            return 0;
        }
        const name = values.name ?? `${replica.projectName} (sandbox)`;
        const { record, checks } = await createSandbox(client, replica, login.userId, name, log);
        process.stdout.write(`created the sandbox "${record.projectName}": ${sandboxUrl(record)} (${checks} safety checks)\n`);
        return 0;
    }

    if (command === 'status') {
        const status = await sandboxStatus(client, replica, login.userId);
        if (!status.record) {
            process.stdout.write(`no sandbox is recorded in ${recordFile(replica.folder)}; create one with: init --replica "${replica.folder}"\n`);
            return 1;
        }
        const lines = [`sandbox: "${status.record.projectName}", ${sandboxUrl(status.record)}, created ${status.record.createdAt}`];
        if (status.copy instanceof Error) {
            lines.push(`could not join the copy: ${status.copy.message}`);
        } else if (status.copy) {
            const s = settingsOf(status.copy);
            lines.push(`copy: compiler ${s.compiler}, image ${s.imageName}, main document ${s.rootDoc}, compile timeout ${status.copy.project.features?.compileTimeout} s, compile group ${status.copy.project.features?.compileGroup}`);
        }
        if (status.shared instanceof Error) {
            lines.push(`could not join the shared project: ${status.shared.message}`);
        } else if (status.shared) {
            const s = settingsOf(status.shared);
            lines.push(`shared project: compiler ${s.compiler}, image ${s.imageName}, main document ${s.rootDoc}`);
        }
        lines.push(status.problems!.length ? `NOT SAFE TO WRITE: ${status.problems!.join('; ')}` : 'safety checks pass: owned by this account, no collaborators, no invites, link sharing off');
        lines.push(status.lock ? `lock held by pid ${status.lock.pid} on ${status.lock.host} since ${status.lock.acquiredAt}: ${status.lock.purpose}` : 'lock: free');
        const runs = recentRuns(replica.folder, 10);
        if (runs.length) {
            lines.push(`latest runs (from ${runLogFile(replica.folder)}):`);
            for (const run of runs) {
                lines.push(run.event === 'start' ? `  ${run.at} pid ${run.pid} started: ${run.purpose} (${run.dir}, ${run.main})`
                    : run.event === 'end' ? `  ${run.at} pid ${run.pid} ended: ${run.status ?? run.error}${run.compileE2EMs ? `, compileE2E ${run.compileE2EMs} ms` : ''}${run.out ? `, results in ${run.out}` : ''}`
                    : `  ${run.at} ${run.event} ${run.projectId ?? ''}`);
            }
        }
        process.stdout.write(lines.join('\n') + '\n');
        return status.problems!.length || status.copy instanceof Error ? 1 : 0;
    }

    if (!values.dir) { throw new UsageError('--dir is required'); }
    if (!values.main) { throw new UsageError('--main is required'); }
    const lockTimeout = values['lock-timeout'] === undefined ? 3600 : Number(values['lock-timeout']);
    if (!Number.isFinite(lockTimeout) || lockTimeout < 0) { throw new UsageError('--lock-timeout takes a number of seconds'); }
    const options: RunOptions = {
        dir: path.resolve(values.dir),
        main: values.main,
        out: values.out,
        mirror: flags.has('mirror'),
        keep: lists.keep,
        ignore: lists.ignore,
        include: lists.include,
        incremental: flags.has('incremental'),
        draft: flags.has('draft'),
        stopOnFirstError: flags.has('stop-on-first-error'),
        pdf: flags.has('pdf'),
        dryRun: command === 'plan',
        lockTimeoutMs: lockTimeout * 1000,
        purpose: values.purpose ?? `compile ${values.main} of ${path.resolve(values.dir)}`,
    };
    if (lists.keep.length && !options.mirror) { throw new UsageError('--keep only applies with --mirror'); }
    try {
        const result = await runCompile(client, replica, login.userId, options, log);
        if (flags.has('json')) {
            process.stdout.write(JSON.stringify(result.summary, null, 2) + '\n');
        } else if (options.dryRun) {
            process.stdout.write('plan only: nothing was written\n');
        } else {
            printSummary(result.summary, result.out);
        }
        return options.dryRun || result.status === 'success' ? 0 : 3;
    } catch (error: any) {
        if (error?.out) { log(`what the run did is in ${path.join(error.out, 'run.json')}`); }
        throw error;
    }
}

if (require.main === module) {
    // stdout carries the summary (or run.json with --json); the extension's API code logs
    // its retries with console.log, and socket.io-client warns about util.isArray
    console.log = console.info = (...args: unknown[]) => console.error(...args);
    const emitWarning = process.emitWarning;
    process.emitWarning = ((warning: any, ...rest: any[]) => {
        if (rest.includes('DEP0044') || rest[0]?.code === 'DEP0044') { return; }
        return (emitWarning as any).call(process, warning, ...rest);
    }) as any;
    // A compile answers only when it is done, which can take longer than undici's
    // default of five minutes for the response headers.
    const { Agent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new Agent({ headersTimeout: 15 * 60 * 1000, bodyTimeout: 15 * 60 * 1000 }));
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
        process.on(signal, () => process.exit(code));
    }
    main(process.argv.slice(2)).then(
        code => process.exit(code),
        (error: any) => {
            if (error instanceof UsageError) {
                process.stderr.write(`${error.message}\n\nRun with --help for the options.\n`);
                process.exit(2);
            }
            const kind = error instanceof SandboxSafetyError ? 'refused' : error instanceof LockTimeoutError ? 'lock' : 'error';
            process.stderr.write(`${kind}: ${error?.message ?? error}\n`);
            process.exit(1);
        });
}
