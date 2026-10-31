#!/bin/sh
# Build this checkout and install it over the Overleaf Workshop extension of Antigravity and
# of the VS Code variants found in the home folder, e.g. again after an extension update.
#
# The first install over a given extension folder copies the files it replaces to
# .local-install/backup-<extension folder>/ in this checkout; restore them from there to undo.
# An installed version that differs from the one this checkout builds is left alone: rebase
# the patches onto that release first, so the install does not undo what the update changed.
#
# The build goes to a temporary folder, not to this checkout's out/: the command-line tools run
# from out/ (node out/sandbox/cli.js), and removing it would break a run in progress. Bring
# out/ up to date separately, while no tool runs.
#
#   scripts/install-local-build.sh            build and install
#   scripts/install-local-build.sh --check    only say what would be installed where
# Exit status 1 when it installed into no extension folder (with --check: when it would install
# into none), for example after an update of the installed extension to another version.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"
check=no
[ "${1:-}" = "--check" ] && check=yes

built_version=$(node -p "require('./package.json').version")
if [ "$check" = no ]; then
    build=$(mktemp -d "${TMPDIR:-/tmp}/overleaf-workshop-build.XXXXXX")
    trap 'rm -rf "$build"' EXIT
    # sh (dash) leaves without its EXIT trap when a signal ends it; these leave through exit
    trap 'exit 130' INT
    trap 'exit 143' TERM
    node node_modules/typescript/bin/tsc -p ./ --outDir "$build/out"
    node scripts/build-pdf-viewer.mjs
fi

found=0
installed=0
for ext in "$HOME"/.antigravity-ide/extensions/iamhyc.overleaf-workshop-* \
           "$HOME"/.vscode/extensions/iamhyc.overleaf-workshop-* \
           "$HOME"/.vscode-oss/extensions/iamhyc.overleaf-workshop-* \
           "$HOME"/.cursor/extensions/iamhyc.overleaf-workshop-*; do
    [ -f "$ext/package.json" ] || continue
    found=1
    installed_version=$(node -p "require(process.argv[1]).version" "$ext/package.json")
    if [ "$installed_version" != "$built_version" ]; then
        echo "skip $ext: installed $installed_version, this checkout builds $built_version"
        continue
    fi
    if [ "$check" = yes ]; then
        echo "would install into $ext"
        installed=$((installed + 1))
        continue
    fi
    backup="$repo/.local-install/backup-$(basename "$ext")"
    if [ ! -d "$backup" ]; then
        mkdir -p "$backup"
        cp -a "$ext/out" "$ext/package.json" "$ext/package.nls.json" "$backup/"
        echo "kept the installed files in $backup"
    fi
    rsync -a --exclude '*.map' --exclude 'test/' "$build/out/" "$ext/out/"
    # the PDF viewers (setting overleaf-workshop.pdfViewer.engine) and the pdf.js release they run
    # on; the released extension's own viewer files stay, for the backup above to work with
    mkdir -p "$ext/views/pdf-viewer"
    rsync -a --delete views/pdf-viewer/dist/ "$ext/views/pdf-viewer/dist/"
    if [ -d views/pdf-viewer/vendor/pdfjs-5.1.91 ]; then
        mkdir -p "$ext/views/pdf-viewer/vendor"
        rsync -a --delete --exclude '*.map' views/pdf-viewer/vendor/pdfjs-5.1.91/ "$ext/views/pdf-viewer/vendor/pdfjs-5.1.91/"
    fi
    # package.json from this checkout, keeping the installer's metadata
    node -e '
        const fs = require("fs");
        const [installedPath, builtPath] = process.argv.slice(1);
        const installed = JSON.parse(fs.readFileSync(installedPath, "utf8"));
        const built = JSON.parse(fs.readFileSync(builtPath, "utf8"));
        if (installed.__metadata) { built.__metadata = installed.__metadata; }
        fs.writeFileSync(installedPath, JSON.stringify(built, null, "\t") + "\n");
    ' "$ext/package.json" package.json
    cp package.nls.json "$ext/package.nls.json"
    # The IDE starts from a cache of the installed extensions and their manifests, which this
    # install does not update. Its next window would start with the old manifest, notice the
    # change a few seconds later and ask for another reload ("Extensions have been modified on
    # disk"). Without the cache the IDE reads the installed manifests and writes a new cache.
    case "$ext" in
        "$HOME"/.antigravity-ide/*) data="$HOME/.config/Antigravity IDE" ;;
        "$HOME"/.vscode/*) data="$HOME/.config/Code" ;;
        "$HOME"/.vscode-oss/*) data="$HOME/.config/VSCodium" ;;
        "$HOME"/.cursor/*) data="$HOME/.config/Cursor" ;;
        *) data="" ;;
    esac
    if [ -n "$data" ]; then
        for cache in "$data"/CachedProfilesData/*/extensions.user.cache; do
            if [ -f "$cache" ]; then
                rm -f "$cache"
                echo "removed the IDE's extension cache $cache"
            fi
        done
    fi
    echo "installed $(git rev-parse --short HEAD) into $ext; reload the window to use it"
    installed=$((installed + 1))
done
if [ "$found" = 0 ]; then
    echo "no Overleaf Workshop extension found" >&2
    exit 1
fi
if [ "$installed" = 0 ]; then
    if [ "$check" = yes ]; then echo "would install nothing: no installed Overleaf Workshop has version $built_version" >&2
    else echo "installed nothing: no installed Overleaf Workshop has version $built_version" >&2; fi
    exit 1
fi
