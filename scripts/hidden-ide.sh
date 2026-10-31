#!/usr/bin/env bash
# A second Antigravity for tests: on a virtual display, with its own profile and extensions
# folder, on a local replica of an Overleaf project that the user's own IDE does not keep a
# replica of (normally the private copy). Tests then never touch the user's window, the user's
# replica folder or the shared project.
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
#   --project ID        the Overleaf project of the replica; the instance opens its replica folder
#   --folder DIR        without --project: open DIR, with no login copy and no replica, e.g. for
#                       tests that only open local files
#   --project-name N    its name, if the extension's saved login does not list the project
#   --build DIR         build that checkout of this extension (TypeScript, and the PDF viewers when
#                       the checkout has pdf.js downloaded) and install it into the instance;
#                       without it, the instance runs a copy of the installed extension
#   --display :N        the virtual display, default :99; :0 and :1 are refused, and so is any
#                       display in use that this script did not start
#   --cdp PORT          the window's debugging port, default 9341
#   --inspect PORT      the Electron main process's inspector port, default 9342
#   --screen WxH        the virtual screen, default 1600x1000, when the display starts
#   --ide PATH          the Antigravity binary, default the running Antigravity's
# A display or port in use is refused, naming the process that holds it, and every command checks
# that the instance's own process holds the port before it connects, so two instances (for
# example of two agents) never reach each other's window.
#
# All of the instance lives in $HIDDEN_IDE_HOME (default /tmp/hidden-ide-$UID): profile/,
# extensions/, replica/, instance.json and the logs. The replica folder is kept between starts,
# so only the first start downloads the whole project. instance.json, for tools that drive the
# instance: pid (the IDE's main process, which holds both ports; check that with ss before
# connecting), xvfb (the display's process), display (":N"), cdp, inspect, project and replica
# (null in folder mode), folder (what the instance opened), profile and ide.
#
# The login: the IDE's own saved Overleaf login is copied into the instance's profile, with only
# the chosen project in it, readable only by this user, and deleted again by "stop". Nothing in
# this script prints it. Do not run this script under set -x.
set -uo pipefail

home=$(realpath -m "${HIDDEN_IDE_HOME:-/tmp/hidden-ide-$(id -u)}")
state="$home/instance.json"
user_state=${HIDDEN_IDE_USER_STATE:-"$HOME/.config/Antigravity IDE/User/globalStorage/state.vscdb"}
user_extensions=${HIDDEN_IDE_USER_EXTENSIONS:-"$HOME/.antigravity-ide/extensions"}

die() { echo "hidden-ide: $*" >&2; exit 1; }
field() { [ -f "$state" ] && python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print("" if v is None else v)' "$state" "$1"; }
cmdline() { [ -n "${1:-}" ] && { tr '\0' ' ' < "/proc/$1/cmdline"; } 2>/dev/null; }
# Whether instance.json's pid is still this instance's IDE, and its xvfb still the Xvfb that this
# script started on its display. After a reboot either number can belong to another process.
own_ide() { cmdline "$(field pid)" | grep -q -F -- "--user-data-dir=$home/profile "; }
own_xvfb() { [ -n "$(field display)" ] && cmdline "$(field xvfb)" | grep -q -E "^Xvfb $(field display) "; }
running() { own_ide || die "no instance is running"; }
# The process listening on a local TCP port, as "pid N (command)", or nothing.
port_holder() {
    local line pid
    line=$(ss -ltnpH "sport = :$1" 2>/dev/null | head -1)
    [ -n "$line" ] || return 0
    pid=$(printf '%s' "$line" | grep -o -E 'pid=[0-9]+' | head -1 | cut -d= -f2)
    if [ -n "$pid" ]; then echo "pid $pid ($(ps -o args= -p "$pid" 2>/dev/null | cut -c1-120))"; else echo "a process of another user"; fi
}
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
# Fail unless the instance's own main process listens on PORT, so a command never reaches another instance.
own_port() {
    local pid=$(field pid)
    ss -ltnpH "sport = :$1" 2>/dev/null | grep -q "pid=$pid," \
        || die "port $1 is not this instance's (it is held by: $(port_holder "$1"))"
}

# Run JavaScript with a DevTools connection to the page (KIND cdp) or the main process (KIND
# inspect) on PORT. The script gets args, the further arguments, and call(method, params), which
# sends one command and resolves to its reply, or to {timeout, error} after 15 s without one. What
# the script returns is the exit status.
devtools() {  # devtools PORT KIND SCRIPT [ARGS...]
    node - "$@" <<'EOF'
const [port, kind, script, ...args] = process.argv.slice(2);
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = kind === 'inspect' ? list[0] : list.find(t => t.type === 'page');
if (!target) { console.error(`nothing to debug on port ${port}`); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(resolve => {
    ws.onopen = resolve;
    ws.onerror = () => { console.error(`could not connect to ${target.webSocketDebuggerUrl}`); process.exit(1); };
});
let id = 0; const pending = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); pending.get(m.id)?.(m); pending.delete(m.id); };
const call = (method, params = {}) => new Promise(resolve => {
    const timer = setTimeout(() => resolve({ timeout: true, error: { message: `${method}: no answer within 15 s` } }), 15000);
    pending.set(++id, m => { clearTimeout(timer); resolve(m); });
    ws.send(JSON.stringify({ id, method, params }));
});
const AsyncFunction = (async () => {}).constructor;
const status = await new AsyncFunction('call', 'args', script)(call, args);
ws.close();
process.exit(status ?? 0);
EOF
}

# Print the value of a JavaScript expression in the page (cdp) or the main process (inspect) as
# JSON, or {"error": ...}; exit status 1 on an error, 2 when there is no answer within 15 s.
evaluate() {  # evaluate PORT KIND EXPRESSION
    devtools "$1" "$2" '
        const answer = await call("Runtime.evaluate", { expression: args[0], awaitPromise: true, returnByValue: true });
        const details = answer.result?.exceptionDetails;
        const failure = answer.error?.message ?? (details && (details.exception?.description ?? details.text));
        if (failure) { console.log(JSON.stringify({ error: failure })); return answer.timeout ? 2 : 1; }
        console.log(JSON.stringify(answer.result.result.value));' "$3"
}

# Run JavaScript statements in the IDE's main process, with w set to its window, and print what they return.
main_process() {  # main_process STATEMENTS
    own_port "$(field inspect)"
    evaluate "$(field inspect)" inspect "(async () => {
        // the main process is an ES module, and the inspector's context has neither require nor import()
        const electron = typeof require === 'function' ? require('electron')
            : process.mainModule ? process.mainModule.require('electron')
            : process.getBuiltinModule('module').createRequire(process.execPath)('electron');
        const w = electron.BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
        if (!w) { return 'no window'; }
        $1
    })()"
}
window_state='{ visible: w.isVisible(), minimized: w.isMinimized(), focused: w.isFocused(), bounds: w.getBounds() }'

# Send one DevTools command to the instance's page.
page_command() {  # page_command METHOD PARAMS_JSON
    own_port "$(field cdp)"
    devtools "$(field cdp)" cdp '
        const answer = await call(args[0], JSON.parse(args[1]));
        if (answer.error) { console.error(`${args[0]}: ${answer.error.message}`); return 1; }
        console.log(`${args[0]}: done`);' "$1" "$2"
}

stop_xvfb() {
    local xvfb=$(field xvfb)
    kill -TERM "$xvfb" 2>/dev/null
    for _ in $(seq 1 20); do [ -d "/proc/$xvfb" ] || break; sleep 0.25; done
}

start() {
    local project="" project_name="" folder="" build="" display=":99" cdp=9341 inspect=9342 screen="1600x1000" ide=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --project) project=$2; shift 2 ;;
            --project-name) project_name=$2; shift 2 ;;
            --folder) folder=$2; shift 2 ;;
            --build) build=$2; shift 2 ;;
            --display) display=$2; shift 2 ;;
            --cdp) cdp=$2; shift 2 ;;
            --inspect) inspect=$2; shift 2 ;;
            --screen) screen=$2; shift 2 ;;
            --ide) ide=$2; shift 2 ;;
            *) die "unknown option $1" ;;
        esac
    done
    own_ide && die "an instance is already running (pid $(field pid)); stop it first"
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
    [[ "$cdp" =~ ^[0-9]+$ && "$inspect" =~ ^[0-9]+$ && "$cdp" != "$inspect" ]] || die "--cdp and --inspect need two different port numbers"
    for port in "$cdp" "$inspect"; do
        [ -z "$(port_holder "$port")" ] || die "refusing port $port: it is in use by $(port_holder "$port")"
    done
    if [ -z "$ide" ]; then
        for pid in $(pgrep -x antigravity-ide 2>/dev/null); do
            ide=$(readlink -f "/proc/$pid/exe" 2>/dev/null) && [ -x "$ide" ] && break
        done
    fi
    [ -n "$ide" ] && [ -x "$ide" ] || die "no Antigravity binary found; pass --ide PATH"
    if [ -n "$project" ] && [ ! -f "$user_state" ]; then die "no saved login at $user_state"; fi
    local source_ext
    source_ext=$(ls -d "$user_extensions"/iamhyc.overleaf-workshop-* 2>/dev/null | head -1)
    [ -n "$source_ext" ] || die "no installed Overleaf Workshop in $user_extensions"

    umask 077
    mkdir -p "$home/profile/User/globalStorage" "$home/extensions"
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
    existing.setdefault("enableCompileNPreview", False)
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
    # the IDE, in a process group of its own
    env -u WAYLAND_DISPLAY -u GNOME_TERMINAL_SCREEN XDG_SESSION_TYPE=x11 DISPLAY="$display" setsid "$ide" \
        --ozone-platform=x11 --disable-gpu --remote-debugging-port="$cdp" --inspect="$inspect" \
        --user-data-dir="$home/profile" --extensions-dir="$home/extensions" \
        --disable-workspace-trust --skip-welcome --skip-release-notes --new-window "$folder" \
        > "$home/ide.log" 2>&1 < /dev/null &
    local pid=$!
    # pid is the IDE's main process, which holds both ports; tools check that before connecting
    python3 -I - "$state" "$pid" "$xvfb" "$display" "$cdp" "$inspect" "$project" "$folder" "$home/profile" "$ide" <<'EOF'
import json, sys
state, pid, xvfb, display, cdp, inspect, project, folder, profile, ide = sys.argv[1:]
with open(state, "w") as out:
    json.dump({"pid": int(pid), "xvfb": int(xvfb), "display": display, "cdp": int(cdp), "inspect": int(inspect),
               "project": project or None, "replica": folder if project else None, "folder": folder,
               "profile": profile, "ide": ide}, out, indent=2)
    out.write("\n")
EOF
    for _ in $(seq 1 120); do
        curl -s "http://127.0.0.1:$cdp/json/list" 2>/dev/null | grep -q '"type": "page"' && break
        own_ide || die "the IDE exited (see $home/ide.log)"
        sleep 0.5
    done
    curl -s "http://127.0.0.1:$cdp/json/list" | grep -q '"type": "page"' || die "the IDE's window did not open within 60 s (see $home/ide.log)"
    for port in "$cdp" "$inspect"; do
        ss -ltnpH "sport = :$port" 2>/dev/null | grep -q "pid=$pid," \
            || die "the IDE (pid $pid) does not hold port $port: $(port_holder "$port"); see $home/ide.log, then stop the instance"
    done
    echo "started: pid $pid on $display, window debugging port $cdp, main process inspector port $inspect, folder $folder"
}

stop() {
    if own_ide; then
        local pid=$(field pid)
        # the whole process group when the IDE leads one (start runs it under setsid), else the IDE alone
        if [ "$(ps -o pgid= -p "$pid" | tr -d ' ')" = "$pid" ]; then kill -TERM -- "-$pid" 2>/dev/null; else kill -TERM "$pid" 2>/dev/null; fi
        for _ in $(seq 1 30); do own_ide || break; sleep 0.5; done
        own_ide && echo "the IDE (pid $pid) is still running 15 s after SIGTERM; not killing it further"
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
        own_port "$(field cdp)"
        evaluate "$(field cdp)" cdp "(async () => {
            const frame = await Promise.race([new Promise(r => requestAnimationFrame(() => r('drawing'))), new Promise(r => setTimeout(() => r('no frame within 2 s'), 2000))]);
            return { visibility: document.visibilityState, focus: document.hasFocus(), frame };
        })()" ;;
    screenshot)
        running
        [ -n "${2:-}" ] || die "usage: screenshot FILE.png [WIDTH HEIGHT]"
        own_port "$(field cdp)"
        # The page's size is set in the same DevTools session as the capture: the override ends with the session.
        devtools "$(field cdp)" cdp '
            const [file, width, height] = args;
            if (width && height) {
                const set = await call("Emulation.setDeviceMetricsOverride", { width: Number(width), height: Number(height), deviceScaleFactor: 1, mobile: false });
                if (set.error) { console.error(set.error.message); return 1; }
                await new Promise(r => setTimeout(r, 800)); // let the workbench lay itself out at the new size
            }
            const answer = await call("Page.captureScreenshot", { format: "png" });
            if (width && height) { await call("Emulation.clearDeviceMetricsOverride"); }
            if (answer.error) { console.error(`screenshot: ${answer.error.message}`); return 1; }
            (await import("node:fs")).writeFileSync(file, Buffer.from(answer.result.data, "base64"));
            console.log(`saved ${file}`);' "$2" "${3:-}" "${4:-}" ;;
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
