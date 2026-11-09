import type { Repo } from '../gitbridge/plumbing';
import { GitIgnoreMatcher } from '../scm/gitIgnore';
import { IgnoreMatcher, isReplicaOwnPath } from '../scm/ignorePatterns';
import type { ReplicaSyncIgnore } from '../scm/replicaControl';

/**
 * The owning window's selection for one comparison. Read the local rules afresh because a
 * landing, or an edit between verification passes, can change them. Older hosts keep the
 * caller's existing selection.
 */
export async function replicaComparisonIgnore(repo: Repo, selection: ReplicaSyncIgnore | undefined,
                                              fallback: (path: string) => boolean): Promise<(path: string) => boolean> {
    if (selection === undefined) { return fallback; }
    const patterns = new IgnoreMatcher();
    const configured = (path: string) => patterns.matches(selection.patterns, path);
    let gitignore: GitIgnoreMatcher | undefined;
    if (selection.respectGitignore) {
        const ignoreCase = repo.run(['config', '--type=bool', '--get', 'core.ignorecase'], { allowFailure: true });
        if (ignoreCase.status !== 0 && ignoreCase.status !== 1) { throw new Error(ignoreCase.stderr); }
        gitignore = new GitIgnoreMatcher(repo.dir, ignoreCase.stdout.toString('utf8').trim() === 'true', configured);
        await gitignore.refresh();
    }
    return path => isReplicaOwnPath(path) || configured(path) || !!gitignore?.matches(path);
}
