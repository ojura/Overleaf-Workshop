# Local replica workflows: git as the merge backend

A local replica keeps a git repository in its folder, and git is the only merge backend of its
sync. This document describes the repository, how the sync records Overleaf's states in it and
merges them with the user's commits, how a commit lands on Overleaf, how conflicts show, how an
existing development history joins the repository, the settings
`overleaf-workshop.localReplica.fetchMode` and `pushMode`, and what was measured about
Overleaf's git bridge. The code is in src/scm/replicaGit.ts, src/scm/replicaSync.ts,
src/sandbox/land.ts and src/gitbridge/.

## The repository

The replica folder is the work tree of a repository of its own, with `.git` at the folder's
root. The sync never uploads dot files and folders (`DEFAULT_IGNORE_PATTERNS` has `**/.*`), so
the repository stays local. It holds every project file, images included. In it:

- `refs/remotes/overleaf/main`: Overleaf's states as the replica saw them, one commit per state;
- `refs/notes/overleaf`: the Overleaf version of a commit that became Overleaf's state by a
  push, which has no `Overleaf-Version` trailer of its own;
- the checked-out branch (`main` when the replica creates the repository): the user's
  commits, into which git merges Overleaf's states;
- `refs/remotes/bridge/<branch>`: the git bridge's commits, in the fetch modes that use it.

The sync's own state is in `.git/overleaf/state.json`: for every file, the content both sides
had after its last sync (its base, a git blob), and the local file's size and modification
time then. `.git/info/exclude` gets a block with the replica's ignore patterns, so that
`git status` lists neither `.overleaf` nor the products of a local build. replica-land keeps
its compiles in `.git/overleaf/compiles/<commit>/` and lists its landings in
`.git/overleaf/landings.log`.

The first start of a replica with this backend makes the repository. When the folder has the
sync state of an earlier version of the extension (`.overleaf/sync`), its bases become the first
commit, "Overleaf's state at the replica's last sync", and local files that differ from them
show as uncommitted changes, which the following sync uploads; `.overleaf/sync` is not read
again. When a binary file's local copy no longer holds its saved base, the file is synced as
if seen for the first time. A new replica's first sync becomes the first commit, "Overleaf's state at
version N".

## How the sync records Overleaf's states

The sync compares each file on both sides with its base, as before: it downloads what changed
on Overleaf, uploads what changed locally, and merges a document that changed on both sides with
`git merge-file`. Once it has been idle for ten seconds, or when a tool asks for a sync, it
records the bases as Overleaf's state:

- when the bases hold the checked-out commit's files, Overleaf holds that commit:
  `refs/remotes/overleaf/main` moves to the commit itself, and a note gives the Overleaf version;
- when they hold files that neither the checked-out commit nor the last recorded state has, a
  commit for the new state goes on `refs/remotes/overleaf/main`. Changes made on Overleaf are
  authored by the user of the newest history update since the last record, at that update's
  end, with the other users of those updates as `Co-authored-by`, and the message "Overleaf
  version N" or "Overleaf versions A to B" with the changed paths. Uploads from the folder are
  a commit of their own on top, "Uploaded from the local folder", by the repository's user
  (`user.name` and `user.email`, else the Overleaf account). Both have the trailers
  `Overleaf-Project` and `Overleaf-Version`, and the repository's user as committer;
- while a push is uploading a commit, and only that commit's files have changed, nothing is
  recorded until the upload is complete.

The parent of a new state is the checked-out commit when that commit's changes are all on
Overleaf (a push, then edits made on Overleaf), otherwise the last recorded state. git then
merges the state into the checked-out branch: a fast-forward when the branch has nothing of its
own, else a merge commit, "Merge the changes made on Overleaf". The sync has already written
the files, so only the branch and the index move; a path staged with other content stays as
it is. When the branch and the state conflict, or have no commit in common, the branch stays
where it is and the log says so.

Files the sync leaves out (its ignore patterns) are not Overleaf's: a commit of Overleaf's state
keeps them as its parent has them, and keeps each file's mode (an executable script stays
executable).

Uploads still happen as files change: each upload batch becomes a commit, and the branch follows
it. A file written by another program, an editor's atomic save or a git checkout is seen by the
replica's folder watcher (src/scm/localFolderWatcher.ts), which on Linux watches every folder on
its own; Node's recursive watching there stops reporting a file once it was replaced.

## Landing a commit

```
node out/sandbox/cli.js replica-land --replica <folder> [<commit>] [--push native|bridge]
```

A commit that descends from the checked-out one lands in these steps:

1. the IDE window that keeps the replica in sync syncs it, and Overleaf's state must be the
   checked-out commit;
2. Overleaf must hold that commit file for file: documents by their text as the editor reads
   them, binary files by the hash Overleaf reports;
3. the window pushes the commit (the control socket's land request): it fast-forwards the
   branch, uploads what the commit changed and waits for Overleaf's acknowledgements. A file
   renamed or moved in the commit is renamed or moved on Overleaf, so the document keeps its
   comments and its history there (the document keeps its id);
4. Overleaf must hold the commit, checked as in step 2, for up to three minutes;
5. one compile of the project, repeated while Overleaf answers that another compile runs; its
   logs are checked for error lines, a missing PDF, latexmk's error summary, a failed automatic
   index and an index that was not built or sorted;
6. the command in `git config overleaf.landCheck` runs with `OVERLEAF_COMPILE`,
   `OVERLEAF_PARENT_COMPILE` (the parent's compile, made first when missing), `OVERLEAF_COMMIT`
   and `OVERLEAF_PARENT`, e.g. a project's own check of where the pages of its contents fall.

Without a commit, it checks and compiles the checked-out commit. With `--push bridge`, step 3 is
git's push through the bridge (see below).

## Conflicts

A document changed on both sides in overlapping places gets git's conflict markers
(`<<<<<<< Local`, `=======`, `>>>>>>> Remote`), and its path is unmerged in the index, with the
base, the local version and Overleaf's version as stages 1, 2 and 3. Overleaf's version is
recorded as Overleaf's state. An unmerged path is never uploaded. It is resolved as any git
conflict: edit the file and stage it (`git add`), or commit it; the replica watches the index
and uploads the resolution at once. Changes Overleaf makes meanwhile go into the file, markers
and all.

A file that a git operation of the user's (a merge, a rebase) left unmerged is left alone:
neither uploaded nor downloaded into until it is resolved.

A binary file changed on both sides keeps Overleaf's version in place and the local one in
`.overleaf/conflicts/`.

## A development history in the replica's repository

```
node out/gitbridge/cli.js replica-connect --replica <folder> --history <repo> [--ref master]
node out/sandbox/cli.js replica-land --replica <folder> refs/gitbridge/connect
```

replica-connect joins a development history that started from a copy of the project's files,
such as the book's repository of text files, tests and layout tools, with the replica's
repository. It fetches the branch from the development repository, which it only reads, writes
its commits again on top of the project's state where the history started (a recorded state with
those files, or one made from the project's history at that version), each with a
`Rewritten-from` trailer, and merges them with Overleaf's state as the replica recorded it. The
merge, in `refs/gitbridge/connect`, descends from the replica's checked-out commit; replica-land
lands it, which uploads the files the history adds to the project. Running replica-connect again
gives the same rewritten commits, and once the branch contains them it says so.

After that the replica's repository is the book's repository: work happens in the replica
folder, or in a clone of its repository (a sparse checkout without the images works), and
commits land with replica-land. `tests/` and `layout/` travel into the project.

## Fetch and push modes

The settings `overleaf-workshop.localReplica.fetchMode` (`native`, `mixed`, `bridge`) and
`pushMode` (`native`, `bridge`) default to `native` and take effect when the window reloads.

In every fetch mode the replica reads Overleaf's state over the editor's connection and records
it as described above. The bridge's commits cannot be the replica's: a bridge commit's committer
date is the second of the request that made the bridge sync (see below), so a commit made
locally never has the bridge's id. A bridge commit joins the replica's history by an anchor
merge (src/gitbridge/anchor.ts), with the checked-out commit and the bridge's commit as parents
and the tree unchanged. That needs a commit of the replica's with the bridge commit's files, or
a bridge commit older than the replica's newest recorded state (Overleaf's history is a line,
so that state contains its changes). A bridge commit with changes the replica has not recorded
yet waits for the next fetch. From then on the bridge's commit is in the branch's history, so a
push through the bridge is a fast-forward.

- `native`: only the replica's own commits.
- `mixed`: the bridge is fetched when git cannot merge Overleaf's state into the branch, when a
  document has conflicts, and on request:
  `node out/gitbridge/cli.js replica-bridge --replica <folder> [--label <comment>]`. With
  `--label`, the project's current version is labelled first, so that the bridge's commit holds
  exactly that version, with the comment as its message; collaborators see the label in the
  history's Labels tab, so it happens only on request.
- `bridge`: the bridge is fetched after every new state the replica records. Each request that
  finds a changed project takes the bridge tens of seconds on the book (see below).

The window runs replica-bridge in a process of its own. The remote `bridge` gets the project's
address on the bridge and the credential helper of `node out/sandbox/cli.js git-credential`,
which hands git the token the extension keeps; neither the address nor the configuration holds
the token.

`pushMode`:

- `native`: local changes are uploaded over the editor's connection, as files change and by
  replica-land.
- `bridge`: the sync does not upload; local changes stay local (a sync lists them as waiting for
  a push), and Overleaf's changes are still merged into the local files. A commit goes to
  Overleaf with `replica-land --push bridge` (the branch fast-forwards, the bridge's commit
  joins by an anchor merge, and git pushes after the check of comments and tracked changes of
  `push-check`) or with `git push bridge`. Overleaf shows each push as one version "via Git",
  and every file of the commit goes into the project, also the ones the replica's ignore
  patterns leave out.

## What was measured

On overleaf.com, 2026-10-31, in test projects of the user's account. The bridge's source is
github.com/overleaf/overleaf at e039ad26c5bf5422eb57b89fc7e57c75055e631d (2026-09-17),
`services/git-bridge`, with JGit 7.5.0; paths below are relative to
`services/git-bridge/src/main/java/uk/ac/ic/wlgitbridge/`.

**Every request to the git bridge for a project makes it create a commit** for the project's
current state when it has none. In a test project, an edit in the editor was followed by:

| Request | Commit made, dated at the request |
|---|---|
| `git ls-remote` (smart `info/refs?service=git-upload-pack`) | yes |
| `info/refs` without a service (git's old "dumb" protocol) | yes |
| `GET HEAD` | yes |
| `info/refs?service=git-receive-pack` (a push's first request) | yes |

So there is no read of the bridge that leaves it as it is. `WLRepositoryResolver.open` calls
`Bridge.getUpdatedRepo` for every git request, before git sees anything
(`git/handler/WLRepositoryResolver.java:85`, `bridge/Bridge.java:319-328`). The bridge keeps the
last version it synced in its own SQLite database (`DBStore.getLatestVersionForProject`), and no
endpoint exposes it: `/status` answers "ok", `/health_check`, `/diags` and `/metrics` are global,
and the LFS handler refuses every request.

**What a sync commits** (`bridge/snapshot/SnapshotApiFacade.java:68-90`, `Bridge.java:648-684`):
when the project's latest version is newer than the bridge's last synced version, one commit for
every labelled version newer than that, and one for the latest version, in version order. A
commit holds exactly the version's files, every mode 100644. Its author is the version's user
and its author date the version's time in whole seconds; its committer is JGit's default,
"node <node@git-bridge-prod-0>", dated at the moment the bridge writes the commit
(`bridge/repo/GitProjectRepo.java:238-245`); its message is "Update on Overleaf." without a
newline, or the label's comment for a labelled version.

**A bridge commit's id cannot be known before the request that makes it.** Everything else in
it follows from the project and its history, but its committer date is the second at which the
bridge writes it, during the request, and its parent is the bridge's newest commit at that
moment, which any request can move. Trying one committer date per second of a request's
duration rebuilt each of four bridge commits of a test project byte for byte, after the fact.

**What a sync costs.** Requests to the bridge for a project with the book's files (1,163 files,
930 MB), timed from outside: 97 s for the bridge's first sync of the project, 41 s and 49 s after
small edits, 2 s when nothing had changed. For each new version, the bridge reads every file of
its previous commit into memory (`Bridge.java:653-654`,
`git/util/RepositoryObjectTreeWalker.java:57-82`), checks that commit out
(`GitProjectRepo.java:224`), deletes every file and writes every file of the new version
(`data/filestore/GitDirectoryContents.java:50-55`), passes the whole tree through `git status`
and `git add` (`GitProjectRepo.java:230-236`), commits, and deletes every file again
(`GitProjectRepo.java:249`). Its work follows the project's size, not the change's; binary files
it has seen before are taken from its own repository, not downloaded again
(`bridge/resource/UrlResourceCache.java:46-68`).

**A fetch leaves no trace in the project's history**: no history entry and no label. The
bridge's sync only reads from the web application (`getDoc`, `getSavedVers`, `getForVersion`);
the web application's side of those requests is in Overleaf's private modules, not in the
public repository.

**A push through the bridge is one history entry per push**, whatever the number of commits:
three commits by three authors in one push became one version, and a second push the next
version. The entry has `origin: {"kind": "git-bridge"}` and the pushing account as its user;
the web interface shows it as "You (via Git)". The commit messages, the commits' authors and
the commit ids appear nowhere in Overleaf's history, in the API or the web interface. Two pushes
a few seconds apart appear as one entry in the history list, as edits do. The bridge keeps the
pushed commits' ids.

**What the history can tell about the bridge**, then: right after a push through the bridge
(an entry with origin git-bridge), the bridge's newest commit is the pushed commit and holds
that version's state. For edits after that, the bridge has a commit only if someone asked it
since, which the history does not show. A label on a version newer than the bridge's last sync
guarantees a commit for exactly that version at the next sync, whoever causes it, with the
label's comment as its message.
