/**
 * How a local replica takes Overleaf's changes in and sends its own out: the settings
 * overleaf-workshop.localReplica.fetchMode and overleaf-workshop.localReplica.pushMode.
 *
 * fetch modes:
 *   native  Overleaf's state read over the editor's connection, as the extension has always done
 *   mixed   native, and the git bridge's commits at chosen moments, such as a three-way merge
 *   bridge  the git bridge's commits only
 * push modes:
 *   native  uploads over the editor's connection, as the extension has always done
 *   bridge  git push through the git bridge
 *
 * Only native is implemented so far. A mode that is not falls back to native, with a notice;
 * docs/replica-workflows.md describes the design of the others. This module does not import
 * 'vscode', so that it can be tested in plain Node.
 */
export const FETCH_MODES = ['native', 'mixed', 'bridge'] as const;
export const PUSH_MODES = ['native', 'bridge'] as const;
export type FetchMode = typeof FETCH_MODES[number];
export type PushMode = typeof PUSH_MODES[number];

export const IMPLEMENTED_FETCH_MODES: readonly FetchMode[] = ['native'];
export const IMPLEMENTED_PUSH_MODES: readonly PushMode[] = ['native'];

export interface ReplicaModes { fetch: FetchMode; push: PushMode; }

/**
 * The modes in effect for the configured values (undefined when not set), and a notice for
 * each value that is unknown or not implemented, which then gives way to native.
 */
export function replicaModes(configured: { fetch?: unknown, push?: unknown }): { modes: ReplicaModes, notices: string[] } {
    const notices: string[] = [];
    function pick<M extends string>(setting: string, value: unknown, all: readonly M[], implemented: readonly M[]): M {
        const fallback = 'native' as M;
        if (value === undefined || value === null || value === '') { return fallback; }
        if (!all.includes(value as M)) {
            notices.push(`the setting ${setting} is "${String(value)}", which is not one of ${all.join(', ')}; native is used`);
            return fallback;
        }
        if (!implemented.includes(value as M)) {
            notices.push(`the setting ${setting} is "${String(value)}", which is not available yet; native is used`);
            return fallback;
        }
        return value as M;
    }
    return {
        modes: {
            fetch: pick('overleaf-workshop.localReplica.fetchMode', configured.fetch, FETCH_MODES, IMPLEMENTED_FETCH_MODES),
            push: pick('overleaf-workshop.localReplica.pushMode', configured.push, PUSH_MODES, IMPLEMENTED_PUSH_MODES),
        },
        notices,
    };
}
