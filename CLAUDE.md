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
  - `npm run test:unit`: it builds out/ as above, runs the tests in out/test with mocha, and
    base.test.js, which is written for node:test, with `node --test`, and fails when either fails.
    Most test files load the extension's modules through their own copy of a 'vscode' stand-in,
    and those copies only work when the tests are compiled into a folder named out.
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
- Never turn on shell tracing (`set -x`) where a session cookie or a token is expanded.
