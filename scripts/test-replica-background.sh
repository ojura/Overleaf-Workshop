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
# Exit status 0 when the replica synced in every state, 1 when it did not, 64 on bad usage, and 128
# + the signal's number after SIGINT, SIGTERM or SIGHUP. However it ends, it removes the probe
# files that it wrote and has not deleted yet, waits until the extension logs their deletion, and
# thaws the page or shows the window when it froze or hid them.
set -uo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
ide="$repo/scripts/hidden-ide.sh"
cli="$repo/out/sandbox/cli.js"
states="shown frozen hidden"; minutes=6.5; limit=60
while [ $# -gt 0 ]; do
    case "$1" in
        --states) states=$2; shift 2 ;;
        --hidden-minutes) minutes=$2; shift 2 ;;
        --timeout) limit=$2; shift 2 ;;
        *) echo "usage: $0 [--states \"shown frozen hidden\"] [--hidden-minutes M] [--timeout S]" >&2; exit 64 ;;
    esac
done
for state in $states; do
    case "$state" in shown|frozen|hidden) ;; *) echo "unknown state $state; the states are shown, frozen and hidden" >&2; exit 64 ;; esac
done
# the instance's record, read by hidden-ide.sh, which names the instance's folder by HIDDEN_IDE_HOME
replica=$("$ide" field replica) && project=$("$ide" field project) && profile=$("$ide" field profile) || exit 64
[ -n "$replica" ] && [ -n "$project" ] || { echo "the test instance does not have a replica; start it with --project" >&2; exit 64; }
[ -f "$cli" ] || { echo "build this checkout first: $cli is missing" >&2; exit 64; }

now() { date +%s%N; }  # nanoseconds
elapsed() { local ms=$(( ($(now) - $1) / 1000000 )); printf '%d.%02d' $((ms / 1000)) $((ms % 1000 / 10)); }
# The upload and the deletion of a probe are read from the extension's Local Replica log, by its
# wording (finding 22). The control socket's "recorded" request, a typed op that streams what the
# sync does as it happens, replaces this when the socket's protocol is redesigned in the next wave.
replica_log() { ls -t "$profile"/logs/*/window1/exthost/output_logging_*/*Local*Replica*.log 2>/dev/null | head -1; }
"$ide" window state > /dev/null || exit 64
[ -n "$(replica_log)" ] || { echo "the test instance has not written a Local Replica log yet" >&2; exit 64; }
# wait_log PATTERN FROM_LINE: the seconds until the replica's log has PATTERN after FROM_LINE; exit status 1 when it does not within the limit
wait_log() {
    local start log
    start=$(now); log=$(replica_log)
    while :; do
        if tail -n +"$(($2 + 1))" "$log" | grep -q -F "$1"; then elapsed "$start"; return 0; fi
        [ $(( $(now) - start )) -lt $(( limit * 1000000000 )) ] || return 1
        sleep 0.1
    done
}
# on_overleaf PATH: exit status 0 when project-info lists the document, 1 when it does not, and 2,
# with project-info's error on stderr, when project-info itself fails (a login or the network)
on_overleaf() {
    local info
    info=$(node "$cli" project-info --project "$project" --json 2>"$work/project-info.err") \
        || { grep -v -E 'Deprecation|trace-dep' "$work/project-info.err" | head -3 >&2; return 2; }
    printf '%s' "$info" | python3 -I -c 'import json, signal, sys; signal.signal(signal.SIGINT, signal.SIG_DFL); sys.exit(0 if any(d.get("path") == sys.argv[1] for d in json.load(sys.stdin).get("documents", [])) else 1)' "$1"
}

# What the run must undo, however it ends: the probe files that it wrote into the replica and has not
# deleted yet, and a page that it froze or a window that it hid.
work=$(mktemp -d "${TMPDIR:-/tmp}/test-replica-background.XXXXXX")
probes=()
frozen_by_run=no
hidden_by_run=no
undo() {
    local status=$? probe sync
    trap - EXIT INT TERM HUP
    for probe in "${probes[@]}"; do
        # whether the probe reached Overleaf depends on when the run ended, so a sync settles it and
        # project-info tells
        rm -f "$replica/$probe"
        sync=$(node "$cli" replica-sync --replica "$replica" --timeout "$limit" 2>&1) \
            || echo "replica-sync after the removal failed: $(printf '%s' "$sync" | grep -v -E 'Deprecation|trace-dep' | head -1)"
        on_overleaf "$probe"
        case $? in
            0) echo "removed the probe $probe from the replica, and Overleaf still lists it after a sync: delete it there" ;;
            1) echo "removed the probe $probe; Overleaf does not list it" ;;
            *) echo "removed the probe $probe from the replica; whether Overleaf lists it is not known (project-info failed, above)" ;;
        esac
    done
    if [ "$frozen_by_run" = yes ]; then "$ide" thaw > /dev/null && echo "thawed the page" || echo "could not thaw the page"; fi
    if [ "$hidden_by_run" = yes ]; then "$ide" window show > /dev/null && echo "showed the window" || echo "could not show the window"; fi
    [ -n "${pause:-}" ] && kill "$pause" 2> /dev/null
    rm -rf "$work"
    exit "$status"
}
trap undo EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

failed=0
check_state() {  # check_state NAME: one round of probe, sync, check and deletion
    local name=$1 probe="hidden-ide-probe-$1.tex" lines took start sync
    lines=$(wc -l < "$(replica_log)")
    probes+=("$probe")
    printf '%% probe of scripts/test-replica-background.sh, state %s, %s\n' "$name" "$(date -Is)" > "$replica/$probe"
    if took=$(wait_log "/$probe: uploaded" "$lines"); then echo "  upload logged after $took s"; else echo "  FAIL: the upload was not logged within $limit s"; failed=1; fi
    start=$(now)
    if sync=$(node "$cli" replica-sync --replica "$replica" --timeout "$limit" 2>&1); then
        echo "  replica-sync answered in $(elapsed "$start") s"
    else
        echo "  FAIL: replica-sync after $(elapsed "$start") s: $(printf '%s' "$sync" | grep -v -E 'Deprecation|trace-dep' | head -1)"; failed=1
    fi
    on_overleaf "$probe"
    case $? in
        0) echo "  on Overleaf: yes" ;;
        1) echo "  FAIL: project-info does not list $probe"; failed=1 ;;
        *) echo "  FAIL: project-info failed (above), so whether $probe is on Overleaf is not known"; failed=1 ;;
    esac
    lines=$(wc -l < "$(replica_log)")
    rm -f "$replica/$probe"
    probes=()
    if took=$(wait_log "/$probe: deleted on Overleaf" "$lines"); then echo "  deletion logged after $took s"; else echo "  FAIL: the deletion was not logged within $limit s"; failed=1; fi
}

for state in $states; do
    case "$state" in
        shown)
            "$ide" window show > /dev/null || { echo "FAIL: could not show the window; the remaining states do not run"; exit 1; }
            echo "shown: $("$ide" probe)"
            check_state shown ;;
        frozen)
            frozen_by_run=yes
            "$ide" freeze > /dev/null || { echo "FAIL: could not freeze the page; the remaining states do not run"; exit 1; }
            # probe asks the page: a frozen page does not run tasks
            probe=$("$ide" probe) || { echo "FAIL: probe failed after freeze"; exit 1; }
            echo "frozen: $probe"
            node -e 'process.exit(JSON.parse(process.argv[1]).frozen === true ? 0 : 1)' "$probe" || { echo "FAIL: the page still runs tasks after freeze"; exit 1; }
            check_state frozen
            "$ide" thaw > /dev/null || { echo "FAIL: could not thaw the page (see above); the remaining states do not run"; exit 1; }
            frozen_by_run=no
            echo "thawed: $("$ide" probe)" ;;
        hidden)
            hidden_by_run=yes
            "$ide" window hide > /dev/null || { echo "FAIL: could not hide the window; the remaining states do not run"; exit 1; }
            # the hidden time is the state's definition; wait lets a signal reach the trap at once
            sleep "$(awk -v m="$minutes" 'BEGIN { print 60 * m }')" & pause=$!
            wait "$pause"
            echo "hidden for $minutes min: $("$ide" probe)"
            check_state hidden
            "$ide" window show > /dev/null || { echo "FAIL: could not show the window again"; exit 1; }
            hidden_by_run=no ;;
    esac
done
[ $failed = 0 ] && echo "the replica synced in every state" || echo "the replica did not sync in every state"
exit $failed
