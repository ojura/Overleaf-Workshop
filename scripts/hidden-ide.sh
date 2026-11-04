#!/usr/bin/env bash
# A second Antigravity for tests: on a virtual display, with its own profile and extensions
# folder, on a local replica of an Overleaf project that the user listed as a test project and
# that the user's own IDE does not keep a replica of, or on a local folder. It runs outside the
# caller's desktop session (see "The instance's environment" below).
#
#   scripts/hidden-ide.sh start [options]     start the virtual display and the IDE
#   scripts/hidden-ide.sh stop                stop the IDE and the display, delete the login copy
#   scripts/hidden-ide.sh status              the instance's ports, folders and process
#   scripts/hidden-ide.sh window ACTION       hide, show, focus, state, "size WIDTH HEIGHT",
#                                             minimize or restore, through the main process;
#                                             the virtual display has no window manager, so
#                                             minimize does not take effect there, and hide is
#                                             what puts the window in the background
#   scripts/hidden-ide.sh probe               the window's page: visible? focused? drawing?
#   scripts/hidden-ide.sh freeze | thaw       freeze the page, or make it active again; thaw
#                                             also hides and shows a shown window, so that the
#                                             page is visible and draws again
#   scripts/hidden-ide.sh screenshot FILE.png [WIDTH HEIGHT]
#                                             the window's page as an image, laid out at
#                                             WIDTH x HEIGHT if given (on the virtual
#                                             display, "window size" changes Electron's
#                                             bounds but not the page's size)
#
# Options for start (give --project or --folder):
#   --project ID        the Overleaf project of the replica; the instance opens its replica folder.
#                       It must be listed in the user's test projects (below)
#   --folder DIR        without --project: open DIR, with no login copy and no replica, e.g. for
#                       tests that only open local files
#   --project-name N    its name, if the extension's saved login does not list the project
#   --build DIR         build that checkout of this extension (TypeScript, and the PDF viewers when
#                       the checkout has pdf.js downloaded) and install it into the instance;
#                       without it, the instance runs a copy of the installed extension
#   --display :N        the virtual display, default :99; :0 and :1 are refused, and so is any
#                       display in use that this script did not start
#   --screen WxH        the virtual screen, default 1600x1000, when the display starts
#   --ide PATH          the Antigravity binary, default the running Antigravity's
# A display in use is refused, naming the process that holds it. The IDE picks the ports of its
# two DevTools endpoints itself, one for the window and one for its main process's inspector, and
# start records the endpoints; each holds an id that only this IDE accepts. Every command connects
# to those endpoints only, and checks that the process that answers is the instance's IDE, so that
# two instances (for example of two agents) never reach each other's window.
#
# All of the instance lives in $HIDDEN_IDE_HOME, a folder that each agent or person picks for an
# instance of its own, for example below its own scratch folder, and names in every command. It has
# no default, so that two agents never share an instance, and a stop in one agent's folder cannot
# end another agent's tests. start makes the folder for this user only, and refuses a folder that
# another user owns or that others can enter. It holds profile/, extensions/, replica/, home/ and
# run/ (below), instance.json and the logs. The replica folder is kept between starts, so only the
# first start downloads the whole project. instance.json, for
# tools that drive the instance (scripts/lib/test-instance.mjs reads it): group (the process group
# of the instance's session bus and IDE), pid (the IDE's main process), xvfb (the display's
# process), display (":N"), devtools and inspector (the endpoints of the window's browser and of
# the main process), project and replica (null in folder mode), folder (what the instance opened),
# profile and ide.
#
# The instance's environment: the IDE gets PATH and LANG from the caller and nothing else of the
# caller's environment, so neither the session bus, the keyring, the SSH agent nor the caller's
# tokens. HOME is home/ and the XDG folders are in it, so Antigravity's own data (~/.gemini,
# ~/.antigravity-ide) is the instance's; XDG_RUNTIME_DIR is run/, where the replica's control
# socket is. The IDE runs under dbus-run-session, on a session bus of its own on which no service
# starts on demand: a file dialog, a notification or a keyring prompt cannot reach the user's
# desktop. Chromium keeps the secrets it encrypts in the profile (--password-store=basic) instead
# of the user's keyring.
#
# The test projects: the user lists in ${XDG_CONFIG_HOME:-~/.config}/overleaf-workshop/test-projects,
# once, the Overleaf projects made for tests, one project id per line ("#" starts a comment).
# start refuses every other project, so that a mistyped or misremembered id cannot make an
# instance sync, write to or delete files of a project that other people edit.
#
# The login: the IDE's own saved Overleaf login is copied into the instance's profile, with only
# the chosen project in it, readable only by this user, and deleted again by "stop". Nothing in
# this script prints it. Do not run this script under set -x.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
home=""
if [ -n "${HIDDEN_IDE_HOME:-}" ]; then home=$(realpath -m -- "$HIDDEN_IDE_HOME"); fi
state="$home/instance.json"
user_state=${HIDDEN_IDE_USER_STATE:-"$HOME/.config/Antigravity IDE/User/globalStorage/state.vscdb"}
user_extensions=${HIDDEN_IDE_USER_EXTENSIONS:-"$HOME/.antigravity-ide/extensions"}
test_projects="${XDG_CONFIG_HOME:-$HOME/.config}/overleaf-workshop/test-projects"

die() { echo "hidden-ide: $*" >&2; exit 1; }
need_home() { [ -n "$home" ] || die "set HIDDEN_IDE_HOME to the folder of your own test instance, for example below your own scratch folder; it has no default, so that two agents never share an instance"; }
field() { [ -f "$state" ] && python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print("" if v is None else v)' "$state" "$1"; }
cmdline() { [ -n "${1:-}" ] && { tr '\0' ' ' < "/proc/$1/cmdline"; } 2>/dev/null; }
# Whether instance.json's pid is still this instance's IDE, and its xvfb still the Xvfb that this
# script started on its display. After a reboot either number can belong to another process.
own_ide() { cmdline "$(field pid)" | grep -q -F -- "--user-data-dir=$home/profile "; }
# Whether instance.json's group is still the process group that start made for this instance: its
# leader runs dbus-run-session with this instance's bus configuration.
own_group() { cmdline "$(field group)" | grep -q -F -- "--config-file=$home/session-bus.conf "; }
own_xvfb() { [ -n "$(field display)" ] && cmdline "$(field xvfb)" | grep -q -E "^Xvfb $(field display) "; }
running() { need_home; own_ide || die "no instance is running in $home"; }
# The X server of display N, as "pid N (command)", from its socket or else its lock file.
display_holder() {
    local pid
    pid=$(ss -lxpH 2>/dev/null | grep -F "/tmp/.X11-unix/X$1 " | grep -o -E 'pid=[0-9]+' | head -1 | cut -d= -f2)
    [ -n "$pid" ] || pid=$(tr -dc '0-9' < "/tmp/.X$1-lock" 2>/dev/null)
    if [ -n "$pid" ] && [ -d "/proc/$pid" ]; then
        echo "pid $pid ($(ps -o args= -p "$pid" 2>/dev/null | cut -c1-120))"
    else
        echo "no process runs it; /tmp/.X11-unix/X$1 or /tmp/.X$1-lock is left over from an X server that ended"
    fi
}
# Fail unless PROJECT is listed in the user's test projects, a file that belongs to the user and
# that only the user can write.
check_test_project() {
    local info owner mode
    [ -f "$test_projects" ] || die "refusing project $1: $test_projects does not exist; the user lists there, once, the Overleaf projects made for tests, one project id per line (\"#\" starts a comment)"
    info=$(stat -c '%u %a' -- "$test_projects") || die "refusing project $1: could not read the owner and mode of $test_projects"
    read -r owner mode <<< "$info"
    [ "$owner" = "$(id -u)" ] && (( (8#$mode & 8#022) == 0 )) \
        || die "refusing project $1: $test_projects must belong to this user, and only the user may write it"
    awk -v id="$1" '{ sub(/#.*/, ""); for (i = 1; i <= NF; i++) if ($i == id) found = 1 } END { exit !found }' "$test_projects" \
        || die "refusing project $1: it is not listed in $test_projects, the user's list of Overleaf projects made for tests"
}
# The DevTools work, in hidden-ide.mjs: it connects only to the endpoints that start recorded in
# instance.json, and checks that the instance's IDE answers there.
ide_devtools() { node "$here/hidden-ide.mjs" "$1" "$home" "${@:2}"; }
# Print what STATEMENTS return in the IDE's main process, with w set to its window, as JSON.
main_process() { ide_devtools evaluate main "$1"; }
# Send one DevTools command (METHOD PARAMS_JSON) to the instance's page.
page_command() { ide_devtools page-command "$1" "$2"; }
window_state='{ visible: w.isVisible(), minimized: w.isMinimized(), focused: w.isFocused(), bounds: w.getBounds() }'

stop_xvfb() {
    local xvfb=$(field xvfb)
    kill -TERM "$xvfb" 2>/dev/null
    for _ in $(seq 1 20); do [ -d "/proc/$xvfb" ] || break; sleep 0.25; done
}

start() {
    need_home
    local project="" project_name="" folder="" build="" display=":99" screen="1600x1000" ide=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --project) project=$2; shift 2 ;;
            --project-name) project_name=$2; shift 2 ;;
            --folder) folder=$2; shift 2 ;;
            --build) build=$2; shift 2 ;;
            --display) display=$2; shift 2 ;;
            --screen) screen=$2; shift 2 ;;
            --ide) ide=$2; shift 2 ;;
            *) die "unknown option $1" ;;
        esac
    done
    { own_ide || own_group; } && die "an instance is already running (process group $(field group)); stop it first"
    if [ -n "$build" ]; then
        [ -d "$build" ] || die "no checkout $build"
        build=$(cd "$build" && pwd)
    fi
    if [ -n "$folder" ]; then
        [ -z "$project" ] || die "give --project or --folder, not both"
        [ -d "$folder" ] || die "no folder $folder"
        folder=$(cd "$folder" && pwd)
    else
        [ -n "$project" ] || project=$(field project)
        [ -n "$project" ] || die "--project ID or --folder DIR is required"
        [[ "$project" =~ ^[0-9a-f]{24}$ ]] || die "not a project id: $project"
        check_test_project "$project"
        folder="$home/replica"
    fi
    [[ "$display" =~ ^:([0-9]+)$ ]] || die "not a display: $display"
    local number=${BASH_REMATCH[1]}
    [ "$number" -le 1 ] && die "refusing display $display: :0 and :1 belong to desktop sessions"
    # this instance's Xvfb from an earlier start: kept on the same display, stopped on another
    local xvfb=""
    if own_xvfb; then
        if [ "$(field display)" = "$display" ]; then xvfb=$(field xvfb); else stop_xvfb; fi
    fi
    if [ -z "$xvfb" ] && { [ -e "/tmp/.X11-unix/X$number" ] || [ -e "/tmp/.X$number-lock" ]; }; then
        die "refusing display $display: it is in use ($(display_holder "$number"))"
    fi
    if [ -z "$ide" ]; then
        for pid in $(pgrep -x antigravity-ide 2>/dev/null); do
            ide=$(readlink -f "/proc/$pid/exe" 2>/dev/null) && [ -x "$ide" ] && break
        done
    fi
    [ -n "$ide" ] && [ -x "$ide" ] || die "no Antigravity binary found; pass --ide PATH"
    command -v dbus-run-session > /dev/null || die "dbus-run-session is missing; it gives the instance a session bus of its own"
    if [ -n "$project" ] && [ ! -f "$user_state" ]; then die "no saved login at $user_state"; fi
    local source_ext
    source_ext=$(ls -d "$user_extensions"/iamhyc.overleaf-workshop-* 2>/dev/null | head -1)
    [ -n "$source_ext" ] || die "no installed Overleaf Workshop in $user_extensions"

    umask 077
    # The folder holds the login copy and the control sockets: it belongs to this user, and others
    # cannot enter it.
    if [ -e "$home" ]; then
        local info owner mode
        info=$(stat -c '%u %a %F' -- "$home") || die "could not read the owner and mode of $home"
        read -r owner mode _ <<< "$info"
        [ -d "$home" ] && [ "$owner" = "$(id -u)" ] && (( (8#$mode & 8#077) == 0 )) \
            || die "refusing $home: the instance's folder must be a folder of this user's that others cannot enter (mode 700)"
    fi
    mkdir -p "$home/profile/User/globalStorage" "$home/extensions" "$home/home" "$home/run"
    if [ -n "$project" ]; then mkdir -p "$home/replica/.overleaf"; fi
    # the extensions: a copy of the installed Overleaf Workshop (and LaTeX Workshop, for .tex files)
    rsync -a --delete "$source_ext" "$home/extensions/" || die "could not copy $source_ext"
    for other in "$user_extensions"/james-yu.latex-workshop-*; do
        [ -d "$other" ] && rsync -a --delete "$other" "$home/extensions/"
    done
    local ext="$home/extensions/$(basename "$source_ext")"
    if [ -n "$build" ]; then
        local out
        out=$(mktemp -d "${TMPDIR:-/tmp}/hidden-ide-build.XXXXXX") || die "could not make a folder for the build"
        (cd "$build" && node node_modules/typescript/bin/tsc -p ./ --outDir "$out/out") || { rm -rf "$out"; die "the build of $build failed"; }
        rsync -a --delete --exclude '*.map' --exclude 'test/' "$out/out/" "$ext/out/"
        cp "$build/package.json" "$build/package.nls.json" "$ext/" 2>/dev/null
        # the PDF viewers, built from the checkout's sources, and its download of pdf.js's viewer app
        if [ -f "$build/scripts/build-pdf-viewer.mjs" ]; then
            # the output folder comes first: the build script runs its own build into the
            # checkout when process.argv[1] is the script itself
            if (cd "$build" && node --input-type=module -e '
                    const { pathToFileURL } = await import("node:url");
                    const { buildViewers } = await import(pathToFileURL(process.argv[2]).href);
                    console.log(`built the PDF viewers: ${(await buildViewers(process.argv[1])).join(", ")}`);' \
                    "$out/viewers" "$build/scripts/build-pdf-viewer.mjs"); then
                rsync -a "$out/viewers/" "$ext/views/pdf-viewer/dist/"
                for release in "$build"/views/pdf-viewer/vendor/pdfjs-*/; do
                    [ -d "$release" ] && rsync -a "$release" "$ext/views/pdf-viewer/vendor/$(basename "$release")/"
                done
            else
                echo "hidden-ide: the PDF viewers of $build did not build (see above); the instance keeps the viewers of the installed extension" >&2
            fi
        fi
        rm -rf "$out"
        echo "installed the build of $build ($(git -C "$build" rev-parse --short HEAD 2>/dev/null)); the chat view is the installed extension's"
    fi
    # The IDE starts with the extension manifests it saved at the last start, compares them with
    # the extensions folder afterwards, and asks for a reload when they differ, as they do after a
    # new build. Without the saved scan it reads the folder at startup.
    find "$home/profile/CachedProfilesData" -name extensions.user.cache -delete 2>/dev/null
    # the instance's settings: no updates, no telemetry, no trust prompt
    cat > "$home/profile/User/settings.json" <<'EOF'
{
  "overleaf-workshop.localReplica.syncOnFileChange.enabled": true,
  "security.workspace.trust.enabled": false,
  "update.mode": "none",
  "extensions.autoUpdate": false,
  "extensions.autoCheckUpdates": false,
  "telemetry.telemetryLevel": "off",
  "workbench.startupEditor": "none"
}
EOF
    # the instance's saved state, made new at each start: Antigravity's onboarding marked done, so
    # that the window opens on the workbench; with --project also the login copy, with only the
    # chosen project and its replica in this instance's folder
    for suffix in "" "-journal" ".backup"; do rm -f "$home/profile/User/globalStorage/state.vscdb$suffix"; done
    python3 -I - "$user_state" "$home/profile/User/globalStorage/state.vscdb" "$home/replica" "$project" "$project_name" <<'EOF' || exit 1
import json, os, sqlite3, sys, urllib.parse
src, dst, replica, project, name = sys.argv[1:6]
items = {"antigravityOnboarding": "true"}
if project:
    con = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    row = con.execute("SELECT value FROM ItemTable WHERE key = ?", ("iamhyc.overleaf-workshop",)).fetchone()
    if row is None:
        sys.exit("hidden-ide: the IDE has no saved Overleaf Workshop state")
    state = json.loads(row[0])
    servers = state.get("overleaf-servers", {})
    server_name, server = next(((k, v) for k, v in servers.items() if v.get("login")), (None, None))
    if server is None:
        sys.exit("hidden-ide: the IDE has no saved Overleaf login")
    login = dict(server["login"])
    known = {p.get("id"): p for p in login.get("projects", [])}
    mine = os.path.realpath(replica)
    for p in login.get("projects", []):
        for record in (p.get("scm") or {}).values():
            base = record.get("baseUri", "")
            if p.get("id") == project and os.path.realpath(base) != mine:
                sys.exit(f"hidden-ide: refusing project {project}: the user's IDE keeps a local replica of it in {base}")
    name = name or known.get(project, {}).get("name")
    if not name:
        sys.exit(f"hidden-ide: the saved login does not list project {project}; pass --project-name")
    login["projects"] = [{"id": project, "name": name, "archived": False, "trashed": False, "accessLevel": "owner",
                          "source": "owner", "joined": True, "userId": login["userId"],
                          "scm": {"file://" + urllib.parse.quote(replica): {"enabled": True, "label": "Local Replica", "baseUri": replica, "settings": {}}}}]
    items["iamhyc.overleaf-workshop"] = json.dumps({"overleaf-servers": {server_name: {"name": server["name"], "url": server["url"], "login": login}}})
out = sqlite3.connect(dst)
out.execute("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)")
out.executemany("INSERT INTO ItemTable VALUES (?, ?)", items.items())
out.commit()
if project:
    uri = "overleaf-workshop://{}/{}?{}".format(server_name, urllib.parse.quote(name),
                                                 urllib.parse.quote(f"user={login['userId']}&project={project}"))
    settings = os.path.join(replica, ".overleaf", "settings.json")
    existing = {}
    if os.path.exists(settings):
        existing = json.load(open(settings))
    existing.update({"uri": uri, "serverName": server_name, "projectName": name})
    json.dump(existing, open(settings, "w"), indent=4)
    print(f"replica of {name} ({project}) in {replica}")
EOF
    [ -n "$project" ] || echo "no login copy and no replica: the instance opens $folder"
    # the virtual display
    if [ -z "$xvfb" ]; then
        setsid Xvfb "$display" -screen 0 "${screen}x24" -nolisten tcp > "$home/xvfb.log" 2>&1 < /dev/null &
        xvfb=$!
        for _ in $(seq 1 50); do [ -e "/tmp/.X11-unix/X$number" ] && break; sleep 0.1; done
        [ -e "/tmp/.X11-unix/X$number" ] || die "Xvfb did not start on $display (see $home/xvfb.log)"
    fi
    # The instance's session bus: only this user may connect, and without service folders no
    # service starts on demand.
    cat > "$home/session-bus.conf" <<EOF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:dir=$home/run</listen>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
EOF
    # The IDE, under its own session bus, in a process group of its own that dbus-run-session
    # leads, with the environment described at the top. It picks the ports of its DevTools
    # endpoints itself (port 0): the window's browser names its endpoint in DevToolsActivePort in
    # the profile, and the file that an earlier start left there must not be taken for the new one.
    rm -f "$home/profile/DevToolsActivePort"
    setsid env -i PATH="$PATH" LANG="${LANG:-C.UTF-8}" HOME="$home/home" \
        XDG_CONFIG_HOME="$home/home/.config" XDG_DATA_HOME="$home/home/.local/share" \
        XDG_STATE_HOME="$home/home/.local/state" XDG_CACHE_HOME="$home/home/.cache" \
        XDG_RUNTIME_DIR="$home/run" DISPLAY="$display" XDG_SESSION_TYPE=x11 \
        dbus-run-session --config-file="$home/session-bus.conf" -- "$ide" \
        --ozone-platform=x11 --disable-gpu --password-store=basic --remote-debugging-port=0 --inspect=0 \
        --user-data-dir="$home/profile" --extensions-dir="$home/extensions" \
        --disable-workspace-trust --skip-welcome --skip-release-notes --new-window "$folder" \
        > "$home/ide.log" 2>&1 < /dev/null &
    local group=$!
    # recorded at once, so that stop finds the instance also when the wait below fails
    python3 -I - "$state" "$group" "$xvfb" "$display" "$project" "$folder" "$home/profile" "$ide" <<'EOF'
import json, sys
state, group, xvfb, display, project, folder, profile, ide = sys.argv[1:]
with open(state, "w") as out:
    json.dump({"group": int(group), "xvfb": int(xvfb), "display": display,
               "project": project or None, "replica": folder if project else None, "folder": folder,
               "profile": profile, "ide": ide}, out, indent=2)
    out.write("\n")
EOF
    # Wait until the window is open and both endpoints answer as the IDE of this process group,
    # which records the IDE's pid and the endpoints in instance.json, or until the IDE's session
    # ends, whichever comes first.
    # (node itself in the background, so that $! is its pid and the kill below reaches it)
    node "$here/hidden-ide.mjs" ready "$home" "$group" &
    local ready=$! first status
    wait -n -p first "$group" "$ready"
    status=$?
    if [ "$first" = "$group" ]; then
        kill "$ready" 2>/dev/null
        die "the IDE exited with status $status (see $home/ide.log)"
    fi
    [ "$status" = 0 ] || die "the IDE's window did not open (see the message above and $home/ide.log); stop the instance"
    echo "started: pid $(field pid) on $display, folder $folder"
}

stop() {
    need_home
    if own_group; then
        local group=$(field group)
        # the whole process group: dbus-run-session, the session bus and the IDE with its processes
        kill -TERM -- "-$group" 2>/dev/null
        for _ in $(seq 1 30); do kill -0 -- "-$group" 2>/dev/null || break; sleep 0.5; done
        kill -0 -- "-$group" 2>/dev/null && echo "the instance's process group $group still runs 15 s after SIGTERM; not killing it further"
    fi
    own_xvfb && stop_xvfb
    for suffix in "" "-journal" ".backup"; do
        rm -f "$home/profile/User/globalStorage/state.vscdb$suffix"
    done
    echo "stopped; deleted the instance's saved state (state.vscdb, which holds the login copy in --project mode)"
}

case "${1:-}" in
    start) shift; start "$@" ;;
    stop) stop ;;
    status)
        need_home
        [ -f "$state" ] || die "no instance in $home"
        cat "$state"; own_ide && echo "running" || echo "not running" ;;
    window)
        running
        case "${2:-state}" in
            hide|show|minimize|restore|focus) main_process "w.${2}(); return $window_state;" ;;
            size)
                [[ "${3:-}" =~ ^[0-9]+$ && "${4:-}" =~ ^[0-9]+$ ]] || die "usage: window size WIDTH HEIGHT"
                main_process "w.setSize($3, $4); return $window_state;" ;;
            state) main_process "return $window_state;" ;;
            *) die "unknown window action $2" ;;
        esac ;;
    probe)
        running
        ide_devtools evaluate page "(async () => {
            const frame = await Promise.race([new Promise(r => requestAnimationFrame(() => r('drawing'))), new Promise(r => setTimeout(() => r('no frame within 2 s'), 2000))]);
            return { visibility: document.visibilityState, focus: document.hasFocus(), frame };
        })()" ;;
    screenshot)
        running
        [ -n "${2:-}" ] || die "usage: screenshot FILE.png [WIDTH HEIGHT]"
        ide_devtools screenshot "$2" "${3:-}" "${4:-}" ;;
    freeze) running; page_command Page.setWebLifecycleState '{"state":"frozen"}' ;;
    thaw)
        running
        page_command Page.setWebLifecycleState '{"state":"active"}' || exit 1
        # Chromium marks a page hidden when DevTools freezes it, and does not mark it shown again
        # when DevTools makes it active (PageHandler::SetWebLifecycleState in Chromium's
        # content/browser/devtools/protocol/page_handler.cc), so a thawed page would report
        # visibility "hidden" and draw no frames. Hiding and showing a shown window marks it shown.
        if [ "$(main_process 'return w.isVisible();')" = true ]; then
            main_process 'w.hide(); w.show(); return w.isVisible();' > /dev/null && echo "hid and showed the window, so that the page draws again"
        fi ;;
    *) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 64 ;;
esac
