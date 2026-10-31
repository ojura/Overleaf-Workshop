#!/bin/sh
# The test instance of the IDE: scripts/hidden-ide.mjs holds the commands, and
# "scripts/hidden-ide.sh help" prints their usage.
exec node "$(dirname "$0")/hidden-ide.mjs" "$@"
