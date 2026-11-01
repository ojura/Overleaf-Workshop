# Working in this repository

This is a fork of the VS Code extension Overleaf Workshop; the work happens on the branch
`feat/sandbox-compile`. docs/replica-workflows.md describes the local replica, its git repository
and the command-line tools in out/sandbox/cli.js, and `node out/sandbox/cli.js --help` lists their
commands. Steps that belong to one machine (its IDE, its projects, installing into the user's
window) are in CLAUDE.local.md, which git leaves out.

## Changing the code

- Work on each task in its own worktree (`git worktree add`), commit there, and land on the branch
  with `git merge --ff-only <commit>` in the main checkout, which other sessions use at the same
  time.
- The command-line tools run from the main checkout's out/. After a landing, build out/ again
  while no tool runs.
- Build, test and lint:
  - `node node_modules/typescript/bin/tsc -p ./`
  - `npm run test:unit`: it builds out/ as above, runs the tests in out/test with mocha, and with
    `node --test` base.test.js, which is written for node:test, and the scripts' tests
    (scripts/**/*.test.mjs); it fails when either runner fails.
    The test files load the extension's modules against a stand-in for 'vscode' through one loader,
    src/test/standIn.ts, which leaves require.cache as it found it, so the tests run from any
    compiled folder and in any order.
  - `npx eslint src --ext ts`
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
