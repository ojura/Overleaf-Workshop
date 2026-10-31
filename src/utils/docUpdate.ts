/**
 * How a document's change becomes the ops of an update. The extension's writes and the
 * private-copy tool's push check both use it.
 * This module does not import 'vscode', so that it runs in plain Node.
 */
import * as DiffMatchPatch from 'diff-match-patch';

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
