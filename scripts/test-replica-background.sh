#!/usr/bin/env bash
# Checks that a local replica keeps syncing while its IDE window is in the background. It runs
# against a test instance that scripts/hidden-ide.sh started with --project (never the user's
# window), and writes probe files only into that instance's replica, whose project should be a
# test project such as the private copy.
#
#   scripts/test-replica-background.sh [--states "shown frozen hidden"] [--hidden-minutes M] [--timeout S]
#
# For each state of the window it writes a probe file into the replica, waits until the
# extension logs the upload, asks the window for a sync (replica-sync), checks with project-info
# that the probe is on Overleaf, then deletes it and waits until the extension logs the deletion:
#   shown    the window shown and drawing
#   frozen   the page frozen through the debugging port (Page.setWebLifecycleState), thawed after
#   hidden   the window hidden through the main process for M minutes (default 6.5: past the five
#            minutes after which Chromium throttles a hidden page's timers), shown after
# Exit status 0 when the replica synced in every state, 1 when it did not, 64 on bad usage.
set -uo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
ide="$repo/scripts/hidden-ide.sh"
cli="$repo/out/sandbox/cli.js"
[ -n "${HIDDEN_IDE_HOME:-}" ] || { echo "set HIDDEN_IDE_HOME to the folder of the test instance (scripts/hidden-ide.sh); it has no default" >&2; exit 64; }
home=$(realpath -m -- "$HIDDEN_IDE_HOME")
states="shown frozen hidden"; minutes=6.5; limit=60
while [ $# -gt 0 ]; do
    case "$1" in
        --states) states=$2; shift 2 ;;
        --hidden-minutes) minutes=$2; shift 2 ;;
        --timeout) limit=$2; shift 2 ;;
        *) echo "usage: $0 [--states \"shown frozen hidden\"] [--hidden-minutes M] [--timeout S]" >&2; exit 64 ;;
    esac
done
field() { python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print("" if v is None else v)' "$home/instance.json" "$1"; }
[ -f "$home/instance.json" ] || { echo "no test instance in $home; start one with scripts/hidden-ide.sh start --project ID" >&2; exit 64; }
replica=$(field replica); project=$(field project); profile=$(field profile)
[ -n "$replica" ] && [ -n "$project" ] || { echo "the test instance has no replica; start it with --project" >&2; exit 64; }
[ -f "$cli" ] || { echo "build this checkout first: $cli is missing" >&2; exit 64; }

now() { date +%s.%N; }
elapsed() { python3 -I -c 'import sys; print(f"{float(sys.argv[2]) - float(sys.argv[1]):.2f}")' "$1" "$(now)"; }
replica_log() { ls -t "$profile"/logs/*/window1/exthost/output_logging_*/*Local*Replica*.log 2>/dev/null | head -1; }
"$ide" window state > /dev/null || exit 64
[ -n "$(replica_log)" ] || { echo "the test instance has not written a Local Replica log yet" >&2; exit 64; }
# wait_log PATTERN FROM_LINE: the seconds until the replica's log has PATTERN after FROM_LINE, or nothing
wait_log() {
    local start log
    start=$(now); log=$(replica_log)
    while :; do
        if tail -n +"$(($2 + 1))" "$log" | grep -q -F "$1"; then elapsed "$start"; return 0; fi
        python3 -I -c 'import sys; sys.exit(0 if float(sys.argv[2]) - float(sys.argv[1]) < float(sys.argv[3]) else 1)' "$start" "$(now)" "$limit" || return 1
        sleep 0.1
    done
}
on_overleaf() {  # on_overleaf PATH: whether project-info lists the document
    node "$cli" project-info --project "$project" --json 2>/dev/null \
        | python3 -I -c 'import json,sys; sys.exit(0 if any(d.get("path") == sys.argv[1] for d in json.load(sys.stdin).get("documents", [])) else 1)' "$1"
}

failed=0
check_state() {  # check_state NAME: one round of probe, sync, check and deletion
    local name=$1 probe="hidden-ide-probe-$1.tex" lines took start sync
    lines=$(wc -l < "$(replica_log)")
    printf '%% probe of scripts/test-replica-background.sh, state %s, %s\n' "$name" "$(date -Is)" > "$replica/$probe"
    if took=$(wait_log "/$probe: uploaded" "$lines"); then echo "  upload logged after $took s"; else echo "  FAIL: the upload was not logged within $limit s"; failed=1; fi
    start=$(now)
    if sync=$(node "$cli" replica-sync --replica "$replica" --timeout "$limit" 2>&1); then
        echo "  replica-sync answered in $(elapsed "$start") s"
    else
        echo "  FAIL: replica-sync after $(elapsed "$start") s: $(printf '%s' "$sync" | grep -v -E 'Deprecation|trace-dep' | head -1)"; failed=1
    fi
    if on_overleaf "$probe"; then echo "  on Overleaf: yes"; else echo "  FAIL: project-info does not list $probe"; failed=1; fi
    lines=$(wc -l < "$(replica_log)")
    rm -f "$replica/$probe"
    if took=$(wait_log "/$probe: deleted on Overleaf" "$lines"); then echo "  deletion logged after $took s"; else echo "  FAIL: the deletion was not logged within $limit s"; failed=1; fi
}

for state in $states; do
    case "$state" in
        shown)
            "$ide" window show > /dev/null
            echo "shown: $("$ide" probe)"
            check_state shown ;;
        frozen)
            "$ide" freeze > /dev/null || { echo "FAIL: could not freeze the page"; failed=1; continue; }
            echo "frozen: $("$ide" probe 2>&1 | head -1) (no answer means frozen)"
            check_state frozen
            "$ide" thaw > /dev/null
            echo "thawed: $("$ide" probe)" ;;
        hidden)
            "$ide" window hide > /dev/null
            start=$(date +%s)
            until python3 -I -c 'import sys,time; sys.exit(0 if time.time() - float(sys.argv[1]) >= 60 * float(sys.argv[2]) else 1)' "$start" "$minutes"; do sleep 5; done
            echo "hidden for $minutes min: $("$ide" probe)"
            check_state hidden
            "$ide" window show > /dev/null ;;
        *) echo "unknown state $state" >&2; exit 64 ;;
    esac
done
[ $failed = 0 ] && echo "the replica synced in every state" || echo "the replica did not sync in every state"
exit $failed
