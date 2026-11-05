# Working in this repository

This is a fork of the VS Code extension Overleaf Workshop; the work happens on the branch
`feat/sandbox-compile`. docs/replica-workflows.md describes the local replica, its git repository
and the command-line tools in out/sandbox/cli.js, and `node out/sandbox/cli.js --help` lists their
commands. Steps that belong to one machine (its IDE, its projects, installing into the user's
window) are in CLAUDE.local.md, which git leaves out.

## Changing the code

- Before starting a task, inspect `git worktree list --porcelain` and the existing lane handoffs.
  Git's registered worktrees are the central lane inventory. Continue an existing lane when it
  already owns the task instead of creating an unregistered copy or a second competing checkout.
- Work on each task in its own named-branch worktree (`git worktree add -b work/<task> <path>`),
  commit there, and land on the branch with `git merge --ff-only <commit>` in the main checkout,
  which other sessions use at the same time. Handoffs name the branch, worktree, owner, validation
  result and remaining work in the transcript.
- After landing, confirm the worktree's HEAD is an ancestor of main, its tracked and untracked
  changes are clean, and no agent or process still uses it. Remove it with `git worktree remove`
  as part of completing the lane. Preserve and reconcile unmerged commits or dirty work before
  calling the workstream complete; do not force removal to hide unfinished work. Inspect the
  registered worktree list again at handoff so abandoned lanes remain visible.
- The command-line tools run from the main checkout's out/. After a landing, build out/ again
  while no tool runs.
- Set up a new checkout with `npm ci --ignore-scripts`, then `npm run postinstall` and
  `npm ci --ignore-scripts --prefix views/chat-view`. `--ignore-scripts` keeps the dependencies'
  install scripts from running, and it skips the project's own postinstall as well, which applies
  the socket.io-client patch and downloads pdf.js's release and the LaTeX language files into
  data/vendor. The chat view has packages of its own, which the release workflow installs in a
  second step (.github/workflows/vsce-package.yml). `npm run compile` then builds the extension,
  the PDF viewers and the chat view.
- Build, test and lint:
  - `node node_modules/typescript/bin/tsc -p ./`
  - `npm run test:unit`: it builds out/ as above, runs the tests in out/test with mocha, and with
    `node --test` base.test.js, which is written for node:test, and the scripts' tests
    (scripts/**/*.test.mjs); it fails when either runner fails.
    The test files load the extension's modules against a stand-in for 'vscode' through one loader,
    src/test/standIn.ts, which leaves require.cache as it found it, so the tests run from any
    compiled folder and in any order.
  - `npx eslint src --ext ts`
- PDF changes also run `npm run test:pdf-viewer`. This includes the maintained Safari lifecycle
  and recorder fixtures. [docs/safari-validation.md](docs/safari-validation.md) preserves the
  physical iPhone setup, both short scenarios, real gesture observation and the full 600-second
  workload. Use that runbook for mobile validation and keep the device owner attached through
  result review. A shorter or interrupted capture does not satisfy its endurance gate.
- A new test fails on the code before the fix and passes with it; report both runs. Tests wait for
  the events or awaited calls they need, not for sleeps or polling with a time limit, and close
  everything they open on every path.

## The standard for the code

- Each fact, rule, constant, message and piece of state is defined once, and everything else
  derives from it. When Overleaf, git or the operating system reports a value, the code uses that
  answer instead of computing it again.
- Failures are detected from state and events: a process exits, a socket closes, a request answers
  with a status, a file event arrives. A time limit is a last resort for a party that may never
  answer, and the code says so where it uses one. Everything that is opened is closed on every
  path, failures included.
- The code does not depend on a folder's name, timing, test order, the text of a message, a
  process found by pattern, or a server's internal formats when an explicit value exists.
- A claim in a comment, a commit message or a report is checked before it is stated, or labelled
  as unchecked.
- Comments, messages and docs use plain words and no em or en dashes, and describe the current
  behavior and its reasons.

## Testing against Overleaf

- Experiments never write into a shared project or into a live local replica. Use a private copy
  of the project (`node out/sandbox/cli.js init`) and a test instance of the IDE
  (scripts/hidden-ide.sh).
- A test instance in project mode holds a lock on its project, and a second start for the same
  project refuses, naming the instance that holds the lock. That instance can be another agent's:
  stop it only if you started it.
- Never print a secret's value: a session cookie, a CSRF token, or an API, git or messaging token.
  That rules out shell tracing (`set -x`, `bash -x`) in a command that expands one, dumps of an
  environment with its values (`env`, `printenv`, `/proc/<pid>/environ`), echoes through
  `${VAR-...}` or `${VAR:-...}`, which print the value whenever the variable is set, and the
  command line of a process that takes a token as an option (`ps -o args`, `pgrep -a`,
  `/proc/<pid>/cmdline`): Antigravity's agent hub, `agy --hub`, has its CSRF token there, and a
  line cut short can still end inside the token. Record variable names, a secret's length, or a
  process's pid and name. What a command prints stays in the agent's transcript, and the only
  remedy is to invalidate the secret.
