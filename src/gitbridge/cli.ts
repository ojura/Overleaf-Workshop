#!/usr/bin/env node
/* eslint-disable @typescript-eslint/naming-convention */
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { readStoredLogin } from '../sandbox/login';
import { bridgeCommitWithStart, ConnectError, merge, rebase, Side, Start, startFromVersion } from './connect';
import { bridgeBranch, commandCheck, PrePushCheck, pullFromBridge, pushToBridge } from './flow';
import { addBridgeRemote, rangesCheck } from './overleaf';
import { readReplica } from '../sandbox/sandbox';
import { filesMatchVersion, findStartVersion, OverleafHistory, Pacer, updateForVersion } from './history';
import { GitError, Repo } from './plumbing';
import { connectReplica, CONNECT_REF } from './replicaConnect';

const HELP = `Connect a local history with the history of Overleaf's git bridge, then fetch, merge and push.

usage:
  node out/gitbridge/cli.js remote-add [--repo <dir>] [--remote <name>] (--project <id> | --replica <folder>)
  node out/gitbridge/cli.js rebase  [--repo <dir>] [--remote <name>] [options]
  node out/gitbridge/cli.js merge   [--repo <dir>] [--remote <name>] [options]
  node out/gitbridge/cli.js pull [--repo <dir>] [--remote <name>]
  node out/gitbridge/cli.js push [--repo <dir>] [--remote <name>] [options]
  node out/gitbridge/cli.js replica-connect --replica <folder> --history <repo> [--ref <branch>] [options]

--repo <dir>     the local repository (default: the current folder)
--remote <name>  its remote for the git bridge, e.g. https://git.overleaf.com/<project id>
                 (default: origin). git asks the remote's credential helper for the token.

remote-add: adds --remote (here the default is overleaf) for the project's address on the
git bridge, with the credential helper that git-clone of the private-copy tool gives a
clone: git gets the git token that the extension keeps next to its login, and neither
the address nor the configuration holds it. --project <id>, or --replica <folder> for the
project of a local replica; --server <name> (default www.overleaf.com, or the replica's);
--bridge <url> when the server's git bridge is not known.

Connecting, once, a local history that started from a copy of the project's files and has
no commit in common with the bridge's: two steps, in this order. Run git fetch first; both
use the remote's fetched branch and do not fetch themselves.

  rebase   (optional) The local commits written again so that they branch from the
           project's state where the local history started, with whole trees. The start is
           the bridge's commit with that state when there is one; otherwise one is made from
           the project's history at that version, authored as user.name and user.email. Each
           rewritten commit keeps its author, committer, dates and message and gets
           "Rewritten-from: <old id>"; --map <file> (default <git dir>/gitbridge/rebase-map.txt)
           lists old and new ids. The result is in refs/gitbridge/rebase, the start in
           refs/gitbridge/rebase-start.
           --start-version <n>  the history version the local history started from; by
                                default the version current when its first commit was made,
                                or the nearest one with the same files
           --project <id>       the project, when the remote's address does not name it
           --server <host>      the Overleaf server of the login (default www.overleaf.com)
           --state-db <file>    the IDE's state database with the extension's login
           --pace <ms>          the pause between requests to the project's history (default
                                3000); Overleaf answers faster ones with HTTP 429
  merge    (always) One merge, first parent the bridge's commit, second the local history's
           newest commit (--local, default HEAD; after rebase without --update, give
           --local refs/gitbridge/rebase), so that a push is a fast-forward. When a local
           commit holds the bridge commit's state, the tree is the bridge's, with the changes
           of the later local commits and the repository's own files; a file deleted on
           Overleaf and left unchanged locally is deleted. Otherwise a three-way merge from
           the start (--start, default refs/gitbridge/rebase-start when the local history
           contains it), or from git's merge base; for unrelated histories only with
           --take-bridge, which takes the bridge's version where the two differ. The start's
           tree also tells the project's files from the repository's own. Without the
           rebase, the local history keeps its root and its commit ids. The result is in
           refs/gitbridge/merge.

  Both write their result into their ref; --update <branch> also moves that branch there,
  but only while it still points at the local history's commit (--local, default HEAD).

  The repository's own files are the paths of the local history's newest commit that the
  bridge's newest commit lacks, except those of its first commit (the copy of the project
  it started from: a path from there that the bridge lacks was deleted on Overleaf). They
  travel with the commits into the project. --not-own <glob> (repeatable) leaves paths out.

pull: fetch, and merge the bridge's commit into the checked-out branch when Overleaf changed.
push: fetch; merge when Overleaf changed; check; push as a fast-forward; when the bridge
      refuses it because the project changed after the fetch, again from the fetch
      (--attempts, default 3). The check before each push is push-check's: it reads the
      comments and tracked changes on Overleaf and stops a push that would lose or move
      them ("refuse"), and one with warnings unless --accept-warnings. It joins the project
      as the editor does, so others see you online meanwhile; --no-ranges-check skips it.
      --check <command> runs after it, with BRIDGE_FROM (the bridge's commit), BRIDGE_TO
      (the commit to push) and BRIDGE_REPO set, and stops the push by exiting with a
      non-zero status. --project <id> when the remote's address does not name the
      project; --server <name> (default www.overleaf.com).

replica-connect: connects a development history with a local replica's own repository
         (the replica folder's .git, which records Overleaf's states on
         refs/remotes/overleaf/main). It fetches --ref (default master) of --history, which
         it only reads, writes its commits again on top of the project's state where it
         started (as rebase does, from the history of the replica's project), and merges
         them with Overleaf's state as the replica recorded it (as merge does). The result
         is in refs/gitbridge/connect, a commit on top of the replica's checked-out commit;
         land it with node out/sandbox/cli.js replica-land --replica <folder>
         refs/gitbridge/connect, which uploads the files the history adds to the project.
         The replica must be in sync: its checked-out commit is Overleaf's state. Running
         it again gives the same rewritten commits; once the replica's branch contains
         them, it says so. --start-version, --not-own, --pace and --state-db as for rebase.

--json prints rebase's, merge's, push's and replica-connect's results as JSON.

Exit status: 0 done; 1 failed (the message says why); 2 wrong arguments.
`;

const VALUE_FLAGS = new Set(['repo', 'remote', 'local', 'start-version', 'project', 'replica', 'server', 'bridge', 'state-db', 'map', 'update', 'not-own', 'check', 'attempts', 'pace', 'start', 'history', 'ref']);
const BOOLEAN_FLAGS = new Set(['take-bridge', 'no-ranges-check', 'accept-warnings', 'json', 'help']);

class UsageError extends Error {}

function parseArgs(argv: string[]) {
    const values: Record<string, string> = {};
    const notOwn: string[] = [];
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
            if (key === 'not-own') { notOwn.push(value); } else { values[key] = value; }
        } else {
            throw new UsageError(`unknown option --${key}`);
        }
    }
    return { values, notOwn, flags, positional };
}

const log = (message: string) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${message}\n`);
const short = (oid: string) => oid.slice(0, 7);

/** The project id in a git-bridge address such as https://git.overleaf.com/<id>. */
export function projectIdOf(url: string): string | undefined {
    return /\/([0-9a-f]{24})(?:\.git)?\/?$/.exec(url)?.[1];
}

/**
 * Record the result in `ref`; with `update`, also move that branch to it, but only while the
 * branch still points at the local history's commit. A checked-out branch moves with
 * git reset --keep, so the work tree follows; that needs a work tree without changes.
 */
function moveOrRecord(repo: Repo, result: string, ref: string, local: string, update?: string): string {
    repo.updateRef(ref, result);
    if (!update) { return ref; }
    const branch = `refs/heads/${update}`;
    if (repo.commit(branch) !== local) { throw new ConnectError(`${branch} no longer points at ${short(local)}; it stays where it is, and ${ref} holds the result`); }
    const checkedOut = repo.run(['symbolic-ref', '--quiet', 'HEAD'], { allowFailure: true }).stdout.toString('utf8').trim();
    if (checkedOut === branch) {
        if (repo.text(['status', '--porcelain', '--untracked-files=no'])) { throw new ConnectError(`the work tree has changes; ${branch} stays where it is, and ${ref} holds the result`); }
        repo.run(['reset', '--quiet', '--keep', result]);
    } else {
        repo.updateRef(branch, result, local);
    }
    return `${ref} and ${branch}`;
}

async function main(argv: string[]): Promise<number> {
    const { values, notOwn, flags, positional } = parseArgs(argv);
    if (flags.has('help') || positional.length === 0) {
        process.stdout.write(HELP);
        return flags.has('help') ? 0 : 2;
    }
    const repo = new Repo(path.resolve(values.repo ?? '.'));
    const remote = values.remote ?? 'origin';
    const [command] = positional;

    if (command === 'pull') {
        const { bridge, merge } = pullFromBridge(repo, remote);
        process.stdout.write(`fetched ${bridge.branch} at ${short(bridge.head)}: ${merge}\n`);
        return 0;
    }
    if (command === 'remote-add') {
        const name = values.remote ?? 'overleaf';
        const replica = values.replica ? readReplica(path.resolve(values.replica)) : undefined;
        const projectId = values.project ?? replica?.projectId;
        if (!projectId) { throw new UsageError('remote-add needs --project <id> or --replica <folder>'); }
        const { url } = addBridgeRemote(repo, { remote: name, projectId, serverName: values.server ?? replica?.serverName ?? 'www.overleaf.com', bridgeUrl: values.bridge });
        process.stdout.write(`added the remote ${name}: ${url}; git fetch ${name} gets the token from the extension's login\n`);
        return 0;
    }
    if (command === 'push') {
        const attempts = values.attempts ? Number(values.attempts) : 3;
        if (!Number.isInteger(attempts) || attempts < 1) { throw new UsageError('--attempts needs a whole number from 1'); }
        const checks: PrePushCheck[] = [];
        if (!flags.has('no-ranges-check')) {
            const projectId = values.project ?? projectIdOf(repo.text(['remote', 'get-url', remote]));
            if (!projectId) { throw new UsageError(`the remote ${remote}'s address names no project; give --project, or --no-ranges-check`); }
            checks.push(rangesCheck({ serverName: values.server ?? 'www.overleaf.com', projectId, acceptWarnings: flags.has('accept-warnings') }));
        }
        if (values.check) { checks.push(commandCheck(values.check)); }
        const check: PrePushCheck | undefined = checks.length === 0 ? undefined : async (r, from, to) => {
            const messages: string[] = [];
            for (const c of checks) {
                const answer = await c(r, from, to);
                if (answer.message) { messages.push(answer.message); }
                if (!answer.ok) { return { ok: false, message: messages.join('\n') }; }
            }
            return { ok: true, message: messages.join('\n') || undefined };
        };
        const report = await pushToBridge(repo, remote, { check, attempts, log });
        process.stdout.write(flags.has('json') ? JSON.stringify(report, null, 1) + '\n'
            : `${report.pushed ? `pushed ${short(report.head)}` : `nothing to push; the bridge holds ${short(report.head)}`} after ${report.attempts.length} attempt${report.attempts.length > 1 ? 's' : ''}\n`);
        return 0;
    }
    if (command === 'replica-connect') {
        if (!values.replica || !values.history) { throw new UsageError('replica-connect needs --replica and --history'); }
        const folder = path.resolve(values.replica);
        const replica = readReplica(folder);
        const login = readStoredLogin(replica.serverName, values['state-db']);
        const pace = values.pace ? Number(values.pace) : 3000;
        if (!Number.isFinite(pace) || pace < 0) { throw new UsageError('--pace needs milliseconds'); }
        let startVersion: number | undefined;
        if (values['start-version'] !== undefined) {
            startVersion = Number(values['start-version']);
            if (!Number.isInteger(startVersion) || startVersion < 0) { throw new UsageError('--start-version needs a version number'); }
        }
        const result = await connectReplica(new Repo(folder), {
            historyRepo: path.resolve(values.history), ref: values.ref ?? 'master', startVersion, log,
            history: new OverleafHistory(login.url, login.identity, replica.projectId, new Pacer(pace, undefined, log)),
            notOwn: notOwn.length ? (p: string) => notOwn.some(g => minimatch(p, g, { dot: true })) : undefined,
        });
        if (flags.has('json')) {
            process.stdout.write(JSON.stringify(result, null, 1) + '\n');
        } else if (result.already) {
            process.stdout.write(`the replica's branch already contains ${short(result.local)} (as ${short(result.already)}); nothing to connect\n`);
        } else {
            const m = result.merge!;
            process.stdout.write([
                `rebase: ${result.rebase!.map.length} commits written again on ${short(result.rebase!.start)}${result.rebase!.startMade ? ' (made from the project\'s history)' : ''}; old and new ids in ${result.mapFile}`,
                `merge: ${short(m.commit)} in ${CONNECT_REF}, on top of Overleaf's state; ${m.how === 'held' ? `the rewritten ${short(m.heldAt!)} holds Overleaf's state` : m.how === 'three-way' ? `a three-way merge from ${short(m.base!)}` : `the bridge's version taken for ${m.tookBridge.join(', ')}`}`,
                `files the history adds to the project: ${m.own.length ? m.own.join(', ') : 'none'}`,
                `project files whose content it changes: ${m.carries.length ? m.carries.join(', ') : 'none'}`,
                ...(m.deletedOnOverleaf.length ? [`deleted on Overleaf, left out: ${m.deletedOnOverleaf.join(', ')}`] : []),
                `next: node out/sandbox/cli.js replica-land --replica "${folder}" ${CONNECT_REF}`,
            ].join('\n') + '\n');
        }
        return 0;
    }
    if (command !== 'rebase' && command !== 'merge') { throw new UsageError(`unknown command ${positional.join(' ')}`); }

    const bridge = bridgeBranch(repo, remote);
    const local = repo.mustCommit(values.local ?? 'HEAD');
    const side: Side = { bridge: bridge.head, local };
    const notOwnMatch = (p: string) => notOwn.some(g => minimatch(p, g, { dot: true }));

    if (command === 'merge') {
        let start = values.start ? repo.mustCommit(values.start) : undefined;
        if (!start) {
            const rebased = repo.commit('refs/gitbridge/rebase-start');
            if (rebased && repo.isAncestor(rebased, local)) { start = rebased; }
        }
        const result = merge(repo, side, { takeBridge: flags.has('take-bridge'), notOwn: notOwnMatch, start });
        const ref = moveOrRecord(repo, result.commit, 'refs/gitbridge/merge', local, values.update);
        const lines = [
            `merge: ${short(result.commit)}, parents ${short(bridge.head)} (the bridge's ${bridge.branch}) and ${short(local)} (the local history), now in ${ref}`,
            result.how === 'held' ? `the local commit ${short(result.heldAt!)} holds the bridge commit's state; the tree is the bridge's, with the changes made after it`
                : result.how === 'three-way' ? `no local commit holds the bridge commit's state: a three-way merge from ${short(result.base!)}`
                : `the histories are unrelated and no local commit holds the bridge commit's state: the bridge's version was taken for ${result.tookBridge.join(', ')}`,
            `the repository's own files, which travel into the project: ${result.own.length ? result.own.join(', ') : 'none'}`,
            `the project files a push carries to Overleaf: ${result.carries.length ? result.carries.join(', ') : 'none'}`,
        ];
        if (result.deletedOnOverleaf.length) { lines.push(`deleted on Overleaf, left out: ${result.deletedOnOverleaf.join(', ')}`); }
        process.stdout.write(flags.has('json') ? JSON.stringify({ ...result, ref }, null, 1) + '\n' : lines.join('\n') + '\n');
        return 0;
    }

    // rebase
    let start: Start;
    const existing = values['start-version'] ? undefined : bridgeCommitWithStart(repo, side);
    if (existing) {
        log(`the bridge's commit ${short(existing)} has the local history's first state; the rebase starts from it`);
        start = { kind: 'commit', commit: existing };
    } else {
        const projectId = values.project ?? projectIdOf(repo.text(['remote', 'get-url', remote]));
        if (!projectId) { throw new UsageError(`the remote ${remote}'s address names no project; give --project`); }
        const login = readStoredLogin(values.server ?? 'www.overleaf.com', values['state-db']);
        const pace = values.pace ? Number(values.pace) : 3000;
        if (!Number.isFinite(pace) || pace < 0) { throw new UsageError('--pace needs milliseconds'); }
        const history = new OverleafHistory(login.url, login.identity, projectId, new Pacer(pace, undefined, log));
        const roots = repo.text(['rev-list', '--max-parents=0', local]).split('\n').filter(Boolean);
        if (roots.length !== 1) { throw new ConnectError(`the local history has ${roots.length} first commits; rebase needs exactly one`); }
        const files = new Map([...repo.flatTree(roots[0])].map(([p, e]) => [p, repo.run(['cat-file', 'blob', e.oid]).stdout]));
        let update;
        if (values['start-version']) {
            const v = Number(values['start-version']);
            if (!Number.isInteger(v) || v < 0) { throw new UsageError('--start-version needs a version number'); }
            update = await updateForVersion(history, v);
            const { match, differing } = await filesMatchVersion(history, v, files, log);
            if (!match) { throw new ConnectError(`the local history's first commit differs from the project at version ${v} in ${differing.length} files`, differing); }
        } else {
            const seconds = Number(repo.commitInfo(roots[0]).committerDate.split(' ')[0]);
            update = await findStartVersion(history, files, seconds, log);
        }
        log(`the local history started from version ${update.toV} (${new Date(update.endTs).toISOString()}); no bridge commit has that state, so one is made from the history`);
        start = await startFromVersion(repo, side, history, update, log);
    }
    const result = rebase(repo, local, start);
    const mapFile = values.map ?? path.join(repo.gitDir(), 'gitbridge', 'rebase-map.txt');
    fs.mkdirSync(path.dirname(mapFile), { recursive: true });
    fs.writeFileSync(mapFile, result.map.map(([o, n]) => `${o} ${n}`).join('\n') + '\n');
    repo.updateRef('refs/gitbridge/rebase-start', result.start);
    const ref = moveOrRecord(repo, result.commit, 'refs/gitbridge/rebase', local, values.update);
    const lines = [
        `rebase: start ${short(result.start)}${result.startMade ? ' (made from the history)' : ' (a bridge commit)'}, ${result.map.length} commits rewritten, the newest ${short(result.commit)}, now in ${ref}`,
        `old and new ids: ${mapFile}`,
        `next: merge${values.update ? '' : ' --local refs/gitbridge/rebase'}, which joins it with the bridge's ${short(bridge.head)}`,
    ];
    process.stdout.write(flags.has('json') ? JSON.stringify({ ...result, mapFile, ref }, null, 1) + '\n' : lines.join('\n') + '\n');
    return 0;
}

if (require.main === module) {
    // the API client reports its retries on stdout; keep stdout for the results
    console.log = (...args: unknown[]) => process.stderr.write(args.map(String).join(' ') + '\n');
    main(process.argv.slice(2)).then(code => process.exit(code), error => {
        if (error instanceof UsageError) { process.stderr.write(`${error.message}\n\n${HELP}`); process.exit(2); }
        process.stderr.write(`error: ${error.message}\n`);
        if (error instanceof ConnectError && error.paths.length) { process.stderr.write(error.paths.map(p => `  ${p}\n`).join('')); }
        if (!(error instanceof ConnectError) && !(error instanceof GitError) && process.env.GITBRIDGE_DEBUG) { process.stderr.write(`${error.stack}\n`); }
        process.exit(1);
    });
}

