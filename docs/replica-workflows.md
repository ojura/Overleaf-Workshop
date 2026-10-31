# Local replica workflows: local git as the merge backend

A design for the user's decision. The settings `overleaf-workshop.localReplica.fetchMode`
(`native`, `mixed`, `bridge`) and `overleaf-workshop.localReplica.pushMode` (`native`,
`bridge`) exist and default to `native`; only `native` is implemented, and another value falls
back to it with a notice (src/scm/replicaModes.ts). This document describes what the other
modes would do, and the change that all of them rest on: a git repository as the only merge
backend of a local replica, in place of the extension's own three-way merge
(src/utils/threeWayMerge.ts, used by src/scm/replicaSync.ts).

## What was measured

On overleaf.com, 2026-10-31, in test projects of the user's account.

**Every request to the git bridge for a project makes it create a commit** for the project's
current state when it has none. In a test project, an edit in the editor was followed by:

| Request | Commit made, dated at the request |
|---|---|
| `git ls-remote` (smart `info/refs?service=git-upload-pack`) | yes |
| `info/refs` without a service (git's old "dumb" protocol) | yes |
| `GET HEAD` | yes |
| `info/refs?service=git-receive-pack` (a push's first request) | yes |

So there is no read of the bridge that leaves it as it is. The bridge's source
(github.com/overleaf/overleaf, `services/git-bridge`) shows why:
`WLRepositoryResolver.open` calls `Bridge.getUpdatedRepo` for every git request, before git
sees anything. The bridge keeps the last version it synced in its own SQLite database
(`DBStore.getLatestVersionForProject`), and no endpoint exposes it: `/status` answers "ok",
`/health_check`, `/diags` and `/metrics` are global, and the LFS handler refuses every request.

**What a sync commits** (`SnapshotApiFacade.getSnapshotInfosAfterVersion`): when the project's
latest version is newer than the bridge's last synced version, one commit for every labelled
version newer than that, and one for the latest version, in version order. A commit's author
is the version's user and its author date the version's time; its committer is `node`, dated
at the sync; its message is "Update on Overleaf.", or the label's comment for a labelled
version. Because the committer date is the moment of the sync, a commit made locally can never
have the bridge's id.

**A fetch leaves no trace in the project's history**: no history entry and no label. The
bridge's sync only reads from the web application (`getDoc`, `getSavedVers`, `getForVersion`);
the web application's side of those requests is in Overleaf's private modules, not in the
public repository.

**A push through the bridge is one history entry per push**, whatever the number of commits:
three commits by three authors in one push became one version, and a second push the next
version. The entry has `origin: {"kind": "git-bridge"}` and the pushing account as its user;
the web interface shows it as "You (via Git)". The commit messages, the commits' authors and
the commit ids appear nowhere in Overleaf's history, in the API or the web interface. Two pushes
a few seconds apart appear as one entry in the history list, as edits do.

**What the history can tell about the bridge**, then: right after a push through the bridge
(an entry with origin git-bridge), the bridge's newest commit is the pushed commit and holds
that version's state. For edits after that, the bridge has a commit only if someone asked it
since, which the history does not show. A label on a version newer than the bridge's last sync
guarantees a commit for exactly that version at the next sync, whoever causes it, with the
label's comment as its message.

## The model

A local replica keeps a git repository whose work tree is the replica folder: `.git` at the
folder's root. Dot folders are never uploaded (`DEFAULT_IGNORE_PATTERNS` has `**/.*`), so the
repository stays local. In it:

- `refs/remotes/overleaf/<branch>`: Overleaf's states as the replica saw them, one commit per
  state, made locally (native fetch) or fetched from the bridge (bridge fetch);
- `refs/remotes/bridge/<branch>`: the bridge's commits, when a mode uses the bridge;
- the user's branch, with the user's commits, which git merges with Overleaf's states.

Every merge is git's: a fast-forward when one side has nothing new, otherwise a three-way
merge with the real merge base. Conflicts are git's conflicts.

### Native fetch: local commits for Overleaf's states

When Overleaf's state changes (the editor's connection reports it, or a full sync finds it),
the replica downloads the changes as today, and commits the new state on
`refs/remotes/overleaf/<branch>`:

- tree: the previous Overleaf state with the downloaded changes, every file of the project;
- author: the user of the newest history update since the previous state, and author date
  that update's end, as the bridge does; other users of those updates as `Co-authored-by`;
- committer: the local user (`user.name`, `user.email`), dated now;
- message: "Overleaf versions <a> to <b>", with the changed paths;
- trailers: `Overleaf-Project: <id>` and `Overleaf-Version: <b>`.

Then git merges it into the user's branch.

### Native push

A commit on the user's branch that Overleaf lacks is uploaded through the editor's connection,
as files are today: the paths it changed, in one batch, waiting for Overleaf's acknowledgements.
When nobody edited meanwhile, Overleaf then holds exactly the commit's tree, so
`refs/remotes/overleaf/<branch>` moves to that commit itself, with the Overleaf version in a note
(`refs/notes/overleaf`); no extra commit is needed. When someone edited meanwhile, the next
native fetch makes a commit for the combined state on top of the pushed commit, and git merges
it as usual.

This makes the commit the unit of upload. Today, with `syncOnFileChange`, every write is
uploaded as it happens; the user decides whether that stays possible (for example, a commit
made automatically for each upload) or whether uploads happen only at commits.

### Bridge fetch, and how a bridge commit takes the place of a local one

`git fetch` from the bridge into `refs/remotes/bridge/<branch>`. A bridge commit and a local
commit for the same state are found by their trees (and by the version: the bridge commit's
author date against the `Overleaf-Version` trailer). For each pair, an anchor merge joins the
two lines: parents the user's branch and the bridge commit, tree unchanged. Nothing is
rewritten, and from then on the bridge's commit is an ancestor of the user's branch, so a push
through the bridge is a fast-forward. A bridge commit without a local twin (a state the replica
never saw, such as a push by someone else) is merged like any change from Overleaf.

### Mixed fetch

Native by default. The bridge is asked only when its commit is worth having:

- before a push through the bridge, which requires the bridge's newest commit;
- when a three-way merge conflicts, so that the conflict is between real, shareable commits;
- on demand.

To make such a commit hold a chosen state rather than whatever the project is at the moment of
the request, the replica can label the version first: the next sync then commits that version
with the label's comment as its message. Labels are visible to all collaborators in the
history's Labels tab; that is a decision for the user.

### Bridge push

`git push` of the user's branch after merging the bridge's newest commit, with the push check of
comments and tracked changes before it (src/sandbox/gitPush.ts). Each push becomes one
Overleaf version, shown as "via Git" under the pushing account. A refused push (someone edited
after the fetch) is fetched, merged and pushed again, as `node out/gitbridge/cli.js push` does.

### Conflicts

A conflicted merge leaves the files with git's conflict markers and their paths unmerged in the
index. An unmerged path is never uploaded, as today's conflict guard does for files with
markers; the SCM view lists them; resolving them is editing the files and committing, with git
or with the extension's commands. A binary file in conflict keeps Overleaf's version next to the
local one, as today.

### The saved sync state

Today `.overleaf/sync` keeps, for every file, the content both sides had at its last sync (its
base) and the size and modification time of the local file then. With the git backend, the base
is the file in `refs/remotes/overleaf/<branch>`, and git's index does the stat caching. On the
first start with the backend, the saved bases become the first commit of
`refs/remotes/overleaf/<branch>`, the local folder's differences show as uncommitted changes,
and `.overleaf/sync` is no longer read.

## Where a development repository fits

A repository like `~/src/30-godina-LARICS-a-index` holds the book's text files, `tests/` and
`layout/`, without the images. With the git backend the replica's own repository holds the whole
project, so either:

1. the replica's repository becomes the book's repository, and work happens in the replica
   folder, committed and then pushed; or
2. the development repository stays, as a clone of the replica's repository with a sparse
   checkout that leaves the images out, and pushes its commits to it.

Files that belong to the repository but not to the project, such as `tests/`, are kept out of
uploads by the replica's ignore patterns, or travel into the project as the user decides.

## Connecting an existing history (implemented)

For a local history that started from a copy of the project's files, two commands of
`node out/gitbridge/cli.js`, in this order:

1. `rebase` (optional): the local commits written again, once, so that they branch from the
   project's state where the history started: the bridge's commit with that state when there
   is one, otherwise a commit made from the project's history at that version, authored as the
   user. Each keeps its author, dates and message and gets `Rewritten-from: <old id>`.
2. `merge` (always): one merge with the bridge's newest commit. When a local commit holds the
   bridge commit's state, the tree is the bridge's with the later local changes; otherwise a
   three-way merge from the rebase's start. Without the rebase, the history keeps its own root.

After that, the routine flow (`pull`, `push`) only fast-forwards and merges.

## To decide

1. Whether the git backend replaces the extension's merge, as described.
2. Upload at commits only, or also as files change (with commits made for each upload).
3. Where the repository lives for the book: the replica folder's own, or the development
   repository as a sparse clone of it.
4. Whether `tests/` and similar files travel into the project.
5. For mixed mode: whether the replica labels the versions it wants as bridge commits, which
   collaborators see in the history's Labels tab.
