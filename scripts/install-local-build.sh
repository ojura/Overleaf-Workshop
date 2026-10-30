#!/bin/sh
# Build this checkout and install it over the Overleaf Workshop extension of Antigravity and
# of the VS Code variants found in the home folder, e.g. again after an extension update.
#
# The first install over a given extension folder copies the files it replaces to
# .local-install/backup-<extension folder>/ in this checkout; restore them from there to undo.
# An installed version that differs from the one this checkout builds is left alone: rebase
# the patches onto that release first, so the install does not undo what the update changed.
#
#   scripts/install-local-build.sh            build and install
#   scripts/install-local-build.sh --check    only say what would be installed where
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
cd "$repo"
check=no
[ "${1:-}" = "--check" ] && check=yes

built_version=$(node -p "require('./package.json').version")
if [ "$check" = no ]; then
    rm -rf out
    node node_modules/typescript/bin/tsc -p ./
fi

found=0
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
        continue
    fi
    backup="$repo/.local-install/backup-$(basename "$ext")"
    if [ ! -d "$backup" ]; then
        mkdir -p "$backup"
        cp -a "$ext/out" "$ext/package.json" "$ext/package.nls.json" "$backup/"
        echo "kept the installed files in $backup"
    fi
    rsync -a --exclude '*.map' --exclude 'test/' out/ "$ext/out/"
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
    echo "installed $(git rev-parse --short HEAD) into $ext; reload the window to use it"
done
[ "$found" = 1 ] || echo "no Overleaf Workshop extension found"
