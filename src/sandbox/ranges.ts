/**
 * The comments and tracked changes of a project's documents, and what a push through
 * Overleaf's git bridge would do to them.
 *
 * The rules follow what pushes were measured to do on 2026-10-31, in a test project, for
 * each kind of edit next to, across and inside comments and tracked changes, with the
 * same edits sent through the realtime API for comparison:
 * - A push that changes a document's text moves, shrinks, empties and splits comments and
 *   tracked changes exactly as the same edit made in the editor or by the extension does.
 *   The bridge places its edits as diff-match-patch with semantic cleanup does.
 * - A push that deletes, renames or moves a document deletes it and creates a new one: its
 *   comments and tracked changes are lost, and the comments' threads stay without a
 *   comment. The editor's rename and move keep them.
 * - With track changes on for the pushing user, the push's edits become tracked changes.
 * - Overleaf stores a pushed file with "\n" line endings; the bridge keeps the pushed
 *   commit as it is, so with "\r\n" the repository and the project differ.
 * - Where the changed text repeats next to a comment, the diff cannot tell which copy
 *   changed, and the comment can end up on another copy, through git and the extension
 *   alike.
 */
import { overleafText } from './plan';
import { semanticDiff, trackChangesOn, TrackChangesState } from '../utils/docUpdate';

export interface CommentRange { id: string; threadId: string; p: number; text: string; userId?: string; }
export interface TrackedChange { id: string; kind: 'insertion' | 'deletion'; p: number; text: string; userId?: string; }

export interface DocRanges {
    /** the document's path in the project, without a leading "/", as in the bridge's repository */
    path: string;
    docId: string;
    text: string;
    comments: CommentRange[];
    changes: TrackedChange[];
}

export interface ProjectRanges {
    projectId: string;
    docs: DocRanges[];
    /** project.trackChangesState */
    trackChanges: TrackChangesState;
    /** the names of the project's owner and members, by user id */
    users: Record<string, string>;
}

/** The comments and tracked changes in the `ranges` that joinDoc returns with encodeRanges. */
export function rangesOf(ranges: any): { comments: CommentRange[], changes: TrackedChange[] } {
    const comments: CommentRange[] = (ranges?.comments ?? []).map((c: any) => ({
        id: c.id, threadId: c.op?.t ?? c.id, p: c.op?.p ?? 0, text: c.op?.c ?? '', userId: c.metadata?.user_id,
    }));
    const changes: TrackedChange[] = (ranges?.changes ?? []).map((c: any) => c.op?.i !== undefined
        ? { id: c.id, kind: 'insertion' as const, p: c.op.p, text: c.op.i, userId: c.metadata?.user_id }
        : { id: c.id, kind: 'deletion' as const, p: c.op?.p ?? 0, text: c.op?.d ?? '', userId: c.metadata?.user_id });
    return { comments, changes };
}

/** One change of a document: the text from `from` to `to` replaced by `inserted`, in the positions of the text before it. */
export interface Edit { from: number; to: number; inserted: string; }

/** The edits Overleaf makes when a push changes a document from `before` to `after`, placed by semanticDiff. */
export function bridgeEdits(before: string, after: string): Edit[] {
    const diffs = semanticDiff(before, after);
    const edits: Edit[] = [];
    let pos = 0;
    let current: Edit | undefined;
    for (const [kind, text] of diffs) {
        if (kind === 0) {
            if (current) { edits.push(current); current = undefined; }
            pos += text.length;
            continue;
        }
        current = current ?? { from: pos, to: pos, inserted: '' };
        if (kind === -1) { current.to += text.length; pos += text.length; } else { current.inserted += text; }
    }
    if (current) { edits.push(current); }
    return edits;
}

/** The places where a pure deletion or insertion could equally have gone: a diff cannot tell them apart. */
export function slideRegion(text: string, edit: Edit): { from: number, to: number } {
    const deleted = edit.to - edit.from;
    if (deleted > 0 && edit.inserted.length === 0) {
        let from = edit.from, to = edit.to;
        while (from > 0 && text[from - 1] === text[to - 1]) { from--; to--; }
        const left = from;
        from = edit.from; to = edit.to;
        while (to < text.length && text[from] === text[to]) { from++; to++; }
        return { from: left, to };
    }
    if (deleted === 0 && edit.inserted.length > 0) {
        let s = edit.inserted, pos = edit.from;
        while (pos > 0 && text[pos - 1] === s[s.length - 1]) { s = s[s.length - 1] + s.slice(0, -1); pos--; }
        const left = pos;
        s = edit.inserted; pos = edit.from;
        while (pos < text.length && text[pos] === s[0]) { s = s.slice(1) + s[0]; pos++; }
        return { from: left, to: pos };
    }
    return { from: edit.from, to: edit.to };
}

/** Whether the edit could equally have gone somewhere else. */
function slides(text: string, edit: Edit): boolean {
    const r = slideRegion(text, edit);
    return r.from !== edit.from || r.to !== edit.to;
}

/**
 * What the edits do to the text from `start` to `end` of a comment or tracked insertion:
 * how much of it they delete, whether pushed text lands inside it, and its text afterwards.
 * Pushed text lands inside only when it goes in strictly between the range's ends and the
 * range keeps text after it; text that goes in at either end, or after a deletion that
 * reaches the end, stays outside (measured: an insertion at either end and a replacement
 * across the start left the comment as it was, apart from the deleted part).
 */
function effectOn(text: string, edits: Edit[], start: number, end: number) {
    let deleted = 0, insertedInside = false, result = '', pos = start;
    for (const e of edits) {
        if (e.from >= end) { break; }
        const overlaps = e.to > start;
        const inside = e.inserted.length > 0 && e.from > start && e.to < end;
        if (!overlaps && !inside) { continue; }
        const from = Math.max(e.from, start), to = Math.min(e.to, end);
        if (from > pos) { result += text.slice(pos, from); }
        deleted += Math.max(0, to - from);
        if (inside) { insertedInside = true; result += e.inserted; }
        pos = Math.max(pos, to);
    }
    result += text.slice(pos, end);
    return { deleted, insertedInside, result };
}

export type Severity = 'refuse' | 'warn' | 'info';
export interface Finding { severity: Severity; path: string; message: string; }

/** One file that a push adds, changes, deletes, or renames or moves. */
export interface PushedFile {
    status: 'A' | 'M' | 'D' | 'R';
    path: string;
    /** for R: where the file was */
    oldPath?: string;
    /** the content where the push starts (M, D, R) and where it ends (A, M, R) */
    before?: Uint8Array;
    after?: Uint8Array;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const quote = (s: string) => JSON.stringify(s.length > 60 ? s.slice(0, 57) + '...' : s);
const lineOf = (text: string, p: number) => text.slice(0, p).split('\n').length;
const folderOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

function inventory(doc: DocRanges) {
    const parts = [];
    if (doc.comments.length) { parts.push(plural(doc.comments.length, 'comment', 'comments')); }
    const ins = doc.changes.filter(c => c.kind === 'insertion').length, del = doc.changes.length - ins;
    if (ins) { parts.push(plural(ins, 'tracked insertion', 'tracked insertions')); }
    if (del) { parts.push(plural(del, 'tracked deletion', 'tracked deletions')); }
    return parts.join(', ');
}

/**
 * What a push of `files` would do to the comments and tracked changes in `state`, which
 * must be read from Overleaf now. `userId` is the account that pushes.
 */
export function assessPush(state: ProjectRanges, files: PushedFile[], userId?: string): Finding[] {
    const findings: Finding[] = [];
    const docs = new Map(state.docs.map(d => [d.path, d]));
    const who = (id?: string) => (id && state.users[id]) || 'someone';
    let changesText = false;
    for (const file of files) {
        const oldPath = file.status === 'R' ? file.oldPath! : file.path;
        const doc = docs.get(oldPath);
        const hasRanges = !!doc && (doc.comments.length > 0 || doc.changes.length > 0);
        if (file.after && file.status !== 'D' && file.after.includes(0x0d) && overleafText(file.after) !== undefined) {
            findings.push({ severity: 'warn', path: file.path, message: 'has "\\r\\n" line endings: Overleaf stores the document with "\\n", while the bridge keeps the commit as it is, so the repository and the project then differ for this file' });
        }
        if (file.status === 'D' || file.status === 'R') {
            if (hasRanges) {
                const how = file.status === 'D' ? 'deletes it'
                    : folderOf(file.path) !== folderOf(oldPath) ? `moves it to ${file.path}` : `renames it to ${file.path}`;
                findings.push({ severity: 'refuse', path: oldPath, message: `${how}: Overleaf deletes the document${file.status === 'R' ? ' and creates a new one' : ''}, so its ${inventory(doc!)} are lost, and the threads of its comments stay without a comment${file.status === 'R' ? '. The editor\'s rename and move keep them' : ''}` });
            }
            if (file.status === 'R') { changesText = true; }
            continue;
        }
        if (file.status === 'A') { changesText = true; continue; }
        if (!doc) { continue; } // a binary file, or a path the project does not have
        const newText = overleafText(file.after!);
        if (newText === undefined) {
            if (hasRanges) { findings.push({ severity: 'refuse', path: file.path, message: `becomes a binary file: Overleaf replaces the document with a file, so its ${inventory(doc)} are lost (not measured; treated like a deletion)` }); }
            continue;
        }
        const startText = file.before ? overleafText(file.before) : undefined;
        if (startText !== undefined && startText !== doc.text) {
            findings.push({ severity: 'refuse', path: file.path, message: 'Overleaf\'s text differs from the commit the push starts from: the document was edited on Overleaf after your last fetch. The bridge refuses the push until you fetch, and a fetch makes a commit of the project\'s current state on Overleaf; check again after it' });
            continue;
        }
        if (newText === doc.text) { continue; }
        changesText = true;
        if (!hasRanges) { continue; }
        const edits = bridgeEdits(doc.text, newText);
        for (const c of doc.comments) {
            const end = c.p + c.text.length;
            const e = effectOn(doc.text, edits, c.p, end);
            const where = `comment by ${who(c.userId)} on ${quote(c.text)} (line ${lineOf(doc.text, c.p)})`;
            if (e.deleted > 0 || e.insertedInside) {
                const what = e.deleted === c.text.length && !e.insertedInside ? 'is emptied: it stays, covering no text'
                    : !e.insertedInside ? `shrinks to ${quote(e.result)}` : `then covers ${quote(e.result)}`;
                const repeated = edits.some(x => x.from < end && x.to > c.p && slides(doc.text, x));
                findings.push({ severity: 'warn', path: file.path, message: `${where} ${what}${repeated ? '. The changed text repeats here, so the diff can change another copy than the one edited' : ''}` });
                continue;
            }
            const slid = edits.find(x => slides(doc.text, x) && slideRegion(doc.text, x).from < end && slideRegion(doc.text, x).to > c.p);
            if (slid) {
                findings.push({ severity: 'warn', path: file.path, message: `${where}: the push changes repeated text next to it, and a diff cannot tell which copy changed, so the comment can end up on another copy` });
            }
        }
        for (const t of doc.changes) {
            const where = `tracked ${t.kind} by ${who(t.userId)} of ${quote(t.text)} (line ${lineOf(doc.text, t.p)})`;
            if (t.kind === 'deletion') {
                if (edits.some(x => x.from <= t.p && x.to >= t.p && (x.to > x.from || x.inserted))) {
                    findings.push({ severity: 'info', path: file.path, message: `${where} stays, next to the changed text` });
                }
                continue;
            }
            const end = t.p + t.text.length;
            const e = effectOn(doc.text, edits, t.p, end);
            if (e.deleted > 0 || e.insertedInside) {
                const what = e.deleted === t.text.length && !e.insertedInside ? 'is lost: its text is deleted'
                    : e.insertedInside ? 'is split in two around the pushed text, which is not part of it' : `shrinks to ${quote(e.result)}`;
                findings.push({ severity: 'warn', path: file.path, message: `${where} ${what}` });
            }
        }
    }
    if (changesText && trackChangesOn(state.trackChanges).isOnFor(userId)) {
        findings.push({ severity: 'warn', path: '', message: `track changes is on for ${who(userId)}: Overleaf records the push's edits as tracked changes, which someone has to accept` });
    }
    const order: Record<Severity, number> = { refuse: 0, warn: 1, info: 2 };
    return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}
