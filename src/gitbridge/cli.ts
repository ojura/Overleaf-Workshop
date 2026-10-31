#!/usr/bin/env node
/* eslint-disable @typescript-eslint/naming-convention */
import * as fs from 'fs';
import * as path from 'path';
import { minimatch } from 'minimatch';
import { readStoredLogin } from '../sandbox/login';
import { attach, bridgeCommitWithStart, checkResult, ConnectError, rewrite, Side, Start, startFromVersion } from './connect';
import { bridgeBranch, commandCheck, PrePushCheck, pullFromBridge, pushToBridge } from './flow';
import { addBridgeRemote, rangesCheck } from './overleaf';
import { readReplica } from '../sandbox/sandbox';
import { filesMatchVersion, findStartVersion, OverleafHistory, Pacer, updateForVersion } from './history';
import { GitError, Repo } from './plumbing';

const HELP = `Connect a local history with the history of Overleaf's git bridge, then fetch, merge and push.

usage:
  node out/gitbridge/cli.js remote-add [--repo <dir>] [--remote <name>] (--project <id> | --replica <folder>)
  node out/gitbridge/cli.js connect attach  [--repo <dir>] [--remote <name>] [options]
  node out/gitbridge/cli.js connect rewrite [--repo <dir>] [--remote <name>] [options]
  node out/gitbridge/cli.js pull [--repo <dir>] [--remote <name>]
  node out/gitbridge/cli.js push [--repo <dir>] [--remote <name>] [options]

--repo <dir>     the local repository (default: the current folder)
--remote <name>  its remote for the git bridge, e.g. https://git.overleaf.com/<project id>
                 (default: origin). git asks the remote's credential helper for the token.

remote-add: adds --remote (here the default is overleaf) for the project's address on the
git bridge, with the credential helper that git-clone of the private-copy tool gives a
clone: git gets the git token that the extension keeps next to its login, and neither
the address nor the configuration holds it. --project <id>, or --replica <folder> for the
project of a local replica; --server <name> (default www.overleaf.com, or the replica's);
--bridge <url> when the server's git bridge is not known.

connect: once, when the local history started from a copy of the project's files and has
no commit in common with the bridge's. Run git fetch first: connect uses the remote's
fetched branch and does not fetch itself. It writes refs/connect/attach or
refs/connect/rewrite, or with --update <branch> moves that branch there, but only while
it still points at the local history's commit (--local, default HEAD).

  attach   One merge: first parent the bridge's commit, second the local history, which
           keeps its root and its commit ids. Its tree is the bridge's, plus the
           repository's own files, so no project file changes. Files both sides have must
           be equal; --take-bridge takes the bridge's version where they are not.
  rewrite  The local commits written again, once, to branch from the project's state where
           the local history started, with whole trees, then the merge that joins them to
           the bridge's commit. A bridge commit with that state is used when there is one;
           otherwise one is made from the project's history at that version, authored as
           user.name and user.email. Each rewritten commit keeps its author, committer,
           dates and message and gets "Rewritten-from: <old id>"; --map <file> (default
           <git dir>/connect/rewrite-map.txt) lists old and new ids.
           --start-version <n>  the history version the local history started from; by
                                default the version current when its first commit was made,
                                or the nearest one with the same files
           --project <id>       the project, when the remote's address does not name it
           --server <host>      the Overleaf server of the login (default www.overleaf.com)
           --state-db <file>    the IDE's state database with the extension's login
           --pace <ms>          the pause between requests to the project's history (default
                                3000); Overleaf answers faster ones with HTTP 429

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

--json prints connect's and push's results as JSON.

Exit status: 0 done; 1 failed (the message says why) or connect's check found a
difference; 2 wrong arguments.
`;

const VALUE_FLAGS = new Set(['repo', 'remote', 'local', 'start-version', 'project', 'replica', 'server', 'bridge', 'state-db', 'map', 'update', 'not-own', 'check', 'attempts', 'pace']);
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
    const [command, mode] = positional;

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
    if (command !== 'connect' || (mode !== 'attach' && mode !== 'rewrite')) { throw new UsageError(`unknown command ${positional.join(' ')}`); }

    const bridge = bridgeBranch(repo, remote);
    const local = repo.mustCommit(values.local ?? 'HEAD');
    const side: Side = { bridge: bridge.head, local };
    const notOwnMatch = (p: string) => notOwn.some(g => minimatch(p, g, { dot: true }));

    if (mode === 'attach') {
        const result = attach(repo, side, { takeBridge: flags.has('take-bridge'), notOwn: notOwnMatch });
        const check = checkResult(repo, side, result.commit);
        const ref = moveOrRecord(repo, result.commit, 'refs/connect/attach', local, values.update);
        const lines = [
            `attach: merge ${short(result.commit)}, parents ${short(bridge.head)} (the bridge's ${bridge.branch}) and ${short(local)} (the local history), now in ${ref}`,
            `the repository's own files, which travel into the project: ${result.own.length ? result.own.join(', ') : 'none'}`,
        ];
        if (result.deletedOnOverleaf.length) { lines.push(`deleted on Overleaf, left out: ${result.deletedOnOverleaf.join(', ')}`); }
        if (result.tookBridge.length) { lines.push(`the bridge's version taken for: ${result.tookBridge.join(', ')}`); }
        lines.push(check.equal ? 'check: the tree is the bridge\'s tree plus the repository\'s own files' : `check: the tree differs from the bridge's plus the own files in ${check.differing.join(', ')}`);
        process.stdout.write(flags.has('json') ? JSON.stringify({ ...result, ref, check }, null, 1) + '\n' : lines.join('\n') + '\n');
        return check.equal ? 0 : 1;
    }

    // rewrite
    let start: Start;
    const existing = values['start-version'] ? undefined : bridgeCommitWithStart(repo, side);
    if (existing) {
        log(`the bridge's commit ${short(existing)} has the local history's first state; the rewrite branches from it`);
        start = { kind: 'commit', commit: existing };
    } else {
        const projectId = values.project ?? projectIdOf(repo.text(['remote', 'get-url', remote]));
        if (!projectId) { throw new UsageError(`the remote ${remote}'s address names no project; give --project`); }
        const login = readStoredLogin(values.server ?? 'www.overleaf.com', values['state-db']);
        const pace = values.pace ? Number(values.pace) : 3000;
        if (!Number.isFinite(pace) || pace < 0) { throw new UsageError('--pace needs milliseconds'); }
        const history = new OverleafHistory(login.url, login.identity, projectId, new Pacer(pace, undefined, log));
        const roots = repo.text(['rev-list', '--max-parents=0', local]).split('\n').filter(Boolean);
        if (roots.length !== 1) { throw new ConnectError(`the local history has ${roots.length} first commits; rewrite needs exactly one`); }
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
    const result = rewrite(repo, side, start);
    const mapFile = values.map ?? path.join(repo.gitDir(), 'connect', 'rewrite-map.txt');
    fs.mkdirSync(path.dirname(mapFile), { recursive: true });
    fs.writeFileSync(mapFile, result.map.map(([o, n]) => `${o} ${n}`).join('\n') + '\n');
    repo.updateRef('refs/connect/rewrite-start', result.start);
    const check = checkResult(repo, side, result.commit);
    const ref = moveOrRecord(repo, result.commit, 'refs/connect/rewrite', local, values.update);
    const lines = [
        `rewrite: start ${short(result.start)}${result.startMade ? ' (made from the history)' : ' (a bridge commit)'}, ${result.map.length} commits rewritten, the last ${short(result.last)}; merge ${short(result.commit)} with the bridge's ${short(bridge.head)}, now in ${ref}`,
        `old and new ids: ${mapFile}`,
        `the repository's own files, which travel into the project: ${result.own.length ? result.own.join(', ') : 'none'}`,
        check.equal ? 'check: the tree is the bridge\'s tree plus the repository\'s own files' : `check: the tree differs from the bridge's plus the own files in ${check.differing.join(', ')}`,
    ];
    process.stdout.write(flags.has('json') ? JSON.stringify({ ...result, mapFile, ref, check }, null, 1) + '\n' : lines.join('\n') + '\n');
    return check.equal ? 0 : 1;
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

