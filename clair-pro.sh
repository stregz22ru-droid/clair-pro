#!/usr/bin/env bash
# CLAIR PRO launcher (Linux/Mac). Thin wrapper over launcher.js.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/launcher.js" "$@"
