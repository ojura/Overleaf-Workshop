/**
 * The commands `ranges` and `push-check`: what comments and tracked changes a project has
 * on Overleaf now, and what a pending git push would do to them. Both only read.
 */
import * as path from 'path';
import { OverleafClient } from './client';
import { bridgeProjectId, pushedFiles, resolveCommit } from './gitPush';
import { assessPush, Finding, ProjectRanges } from './ranges';
import { trackChangesOn } from '../utils/docUpdate';

export const RANGES_HELP = `ranges      Lists the comments and tracked changes of every document of the
            project on Overleaf now, and for whom track changes is on.
              --project <id>, or --replica <folder> for the shared project
push-check  Says what pushing the clone's pending commits through Overleaf's git
            bridge would do to the comments and tracked changes on Overleaf now.
              --repo <folder>   a clone from the git bridge
              --from <rev>      where the push starts; default @{upstream}, the
                                bridge's commit at your last fetch
              --to <rev>        what the push sends; default HEAD
              --project <id>    default: the id in the clone's remote URL
              --user <id>       the account that pushes; default the login's
            It refuses a push that deletes, renames or moves a document with
            comments or tracked changes (Overleaf then deletes the document and
            loses them; the editor's rename and move keep them), and a push that
            starts from text Overleaf no longer has. It warns where the push
            changes text a comment or tracked insertion covers (the same as that
            edit in the editor), where repeated text next to a comment makes the
            edit's place ambiguous, where track changes is on for the pushing
            account (the push becomes tracked changes), and about "\\r\\n" line
            endings. It runs no fetch: a fetch makes a commit on Overleaf.
            Exit status: 0 nothing at risk, 3 warnings, 4 refused.
`;

const lineOf = (text: string, p: number) => text.slice(0, p).split('\n').length;
const quote = (s: string) => JSON.stringify(s.length > 70 ? s.slice(0, 67) + '...' : s);
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export function describeRanges(state: ProjectRanges): string {
    const lines: string[] = [];
    const who = (id?: string) => (id && state.users[id]) || id || 'someone';
    const tc = trackChangesOn(state.trackChanges);
    const tcOn = tc.everyone ? 'everyone' : tc.users.map(who).join(', ');
    lines.push(`project ${state.projectId}: track changes ${tcOn ? `is on for ${tcOn}` : 'is off for everyone'}`);
    let comments = 0, changes = 0, withRanges = 0;
    for (const doc of state.docs) {
        if (!doc.comments.length && !doc.changes.length) { continue; }
        withRanges++;
        comments += doc.comments.length;
        changes += doc.changes.length;
        lines.push(`${doc.path}: ${count(doc.comments.length, 'comment')}, ${count(doc.changes.length, 'tracked change')}`);
        for (const c of doc.comments) {
            lines.push(`  comment by ${who(c.userId)}, line ${lineOf(doc.text, c.p)}, on ${quote(c.text)} (thread ${c.threadId})`);
        }
        for (const t of doc.changes) {
            lines.push(`  tracked ${t.kind} by ${who(t.userId)}, line ${lineOf(doc.text, t.p)}: ${quote(t.text)}`);
        }
    }
    lines.push(`${count(comments, 'comment')} and ${count(changes, 'tracked change')} in ${withRanges} of ${count(state.docs.length, 'document')}`);
    return lines.join('\n') + '\n';
}

export function describeFindings(findings: Finding[], summary: string): string {
    const lines = [summary];
    for (const f of findings) {
        lines.push(`${f.severity.toUpperCase().padEnd(6)} ${f.path ? f.path + ': ' : ''}${f.message}`);
    }
    const refused = findings.some(f => f.severity === 'refuse'), warned = findings.some(f => f.severity === 'warn');
    lines.push(refused ? 'result: refused, the push would lose comments or tracked changes, or Overleaf has changed since the push\'s start (exit 4)'
        : warned ? 'result: warnings; read them before pushing (exit 3)' : 'result: nothing at risk (exit 0)');
    return lines.join('\n') + '\n';
}

export function exitStatusOf(findings: Finding[]): number {
    return findings.some(f => f.severity === 'refuse') ? 4 : findings.some(f => f.severity === 'warn') ? 3 : 0;
}

export async function pushCheck(client: OverleafClient, options: { repo: string, from?: string, to?: string, project?: string, userId: string }) {
    const repo = path.resolve(options.repo);
    const projectId = options.project ?? bridgeProjectId(repo);
    if (!projectId) { throw new Error(`the remote of ${repo} is not a git bridge URL; name the project with --project`); }
    const from = resolveCommit(repo, options.from ?? '@{upstream}');
    const to = resolveCommit(repo, options.to ?? 'HEAD');
    const files = pushedFiles(repo, from, to);
    const state = await client.readRanges(projectId);
    const findings = assessPush(state, files, options.userId);
    const summary = `push-check: ${files.length} files changed from ${from.slice(0, 7)} to ${to.slice(0, 7)}; project ${projectId}; pushing as ${state.users[options.userId] ?? options.userId}${trackChangesOn(state.trackChanges).isOnFor(options.userId) ? ' (track changes on)' : ''}`;
    return { findings, summary, state, files };
}
