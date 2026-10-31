/**
 * How a document's change becomes the ops of an update, and whether the update is
 * tracked. The extension's writes and the private-copy tool's push check both use it.
 * This module does not import 'vscode', so that it runs in plain Node.
 */
import * as DiffMatchPatch from 'diff-match-patch';
import { randomBytes } from 'crypto';

/**
 * The diff from `before` to `after`, placed as Overleaf places edits: diff-match-patch with
 * semantic cleanup. Overleaf's git bridge applies a push this way: where this diff and the
 * plain one disagreed, the bridge's tracked deletion landed where this one says (measured
 * 2026-10-31: deleting a line put it at the start of the next line, while the plain diff,
 * which the extension used before, put it two characters into that line).
 */
export function semanticDiff(before: string, after: string): DiffMatchPatch.Diff[] {
    const dmp = new DiffMatchPatch();
    const diffs = dmp.diff_main(before, after);
    dmp.diff_cleanupSemantic(diffs);
    return diffs;
}

/** An op of an update: insert `i` or delete `d` at `p`, after the ops before it are applied. */
export interface TextOp { p: number; i?: string; d?: string; }

/** The ops that turn `before` into `after`, applied one after the other, as the editor sends them. */
export function opsFor(before: string, after: string): TextOp[] {
    const ops: TextOp[] = [];
    let pos = 0;
    for (const [kind, text] of semanticDiff(before, after)) {
        if (kind === 0) {
            pos += text.length;
        } else if (kind === 1) {
            ops.push({ p: pos, i: text });
            pos += text.length;
        } else {
            ops.push({ p: pos, d: text });
        }
    }
    return ops;
}

/** A project's trackChangesState: on or off for everyone, or on for the users it lists. */
export type TrackChangesState = boolean | { [userId: string]: boolean };

/**
 * For whom track changes is on in a project's trackChangesState: true is everyone; false,
 * or no state, is nobody; an object lists the ids it is on for: user ids, and "__guests__"
 * for people with the link who are not logged in. The one reading of trackChangesState:
 * the extension's updates, push-check and project-info all use it.
 */
export function trackChangesOn(state: unknown): { everyone: boolean, users: string[], isOnFor(userId?: string): boolean } {
    const everyone = state === true;
    const users = !everyone && state && typeof state === 'object'
        ? Object.entries(state).filter(([, on]) => on).map(([id]) => id) : [];
    return { everyone, users, isOnFor: (userId?: string) => everyone || (!!userId && users.includes(userId)) };
}

/**
 * The seed from which Overleaf numbers the tracked changes of one update: the first 18
 * hexadecimal digits of an ObjectId, its timestamp in seconds and random digits. Overleaf
 * appends a 6-digit counter. The editor makes a new one for each update.
 */
export function trackedChangesSeed(): string {
    return Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') + randomBytes(5).toString('hex');
}

/**
 * The meta of an update that `userId` makes: as in the editor's updates, a seed when track
 * changes is on for the user, which makes Overleaf record the update as tracked changes,
 * and nothing otherwise. overleaf.com refuses an update whose meta has other keys.
 */
export function updateMeta(state: TrackChangesState | undefined, userId?: string): { tc: string } | undefined {
    return trackChangesOn(state).isOnFor(userId) ? { tc: trackedChangesSeed() } : undefined;
}
