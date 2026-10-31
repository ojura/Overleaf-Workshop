/**
 * How a local replica takes Overleaf's changes in and sends its own out: the settings
 * overleaf-workshop.localReplica.fetchMode and overleaf-workshop.localReplica.pushMode
 * (docs/replica-workflows.md).
 *
 * fetch modes; in each, the replica reads Overleaf's state over the editor's connection and
 * records it as commits in its git repository:
 *   native  only that
 *   mixed   and the git bridge's newest commit, joined with the replica's, when git cannot
 *           merge Overleaf's state into the branch or a document has conflicts, and on
 *           request (node out/sandbox/cli.js replica-bridge)
 *   bridge  and the git bridge's newest commit for every new state the replica records
 * push modes:
 *   native  local changes are uploaded over the editor's connection, also as files change
 *   bridge  local changes stay local until git pushes them through the git bridge
 *           (replica-land --push bridge, or git push)
 *
 * An unknown value falls back to native, with a notice. This module does not import
 * 'vscode', so that it can be tested in plain Node.
 */
export const FETCH_MODES = ['native', 'mixed', 'bridge'] as const;
export const PUSH_MODES = ['native', 'bridge'] as const;
export type FetchMode = typeof FETCH_MODES[number];
export type PushMode = typeof PUSH_MODES[number];

export interface ReplicaModes { fetch: FetchMode; push: PushMode; }

/**
 * The modes in effect for the configured values (undefined when not set), and a notice for
 * each unknown value, which then gives way to native.
 */
export function replicaModes(configured: { fetch?: unknown, push?: unknown }): { modes: ReplicaModes, notices: string[] } {
    const notices: string[] = [];
    function pick<M extends string>(setting: string, value: unknown, all: readonly M[]): M {
        const fallback = 'native' as M;
        if (value === undefined || value === null || value === '') { return fallback; }
        if (!all.includes(value as M)) {
            notices.push(`the setting ${setting} is "${String(value)}", which is not one of ${all.join(', ')}; native is used`);
            return fallback;
        }
        return value as M;
    }
    return {
        modes: {
            fetch: pick('overleaf-workshop.localReplica.fetchMode', configured.fetch, FETCH_MODES),
            push: pick('overleaf-workshop.localReplica.pushMode', configured.push, PUSH_MODES),
        },
        notices,
    };
}
