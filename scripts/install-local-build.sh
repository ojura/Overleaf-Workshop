#!/bin/sh
# Build this checkout and install it over the IDEs' Overleaf Workshop: see scripts/install-local-build.mjs.
exec node "$(dirname "$0")/install-local-build.mjs" "$@"
