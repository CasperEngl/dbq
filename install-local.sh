#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

bun run build

VERSION="$(bun -p "require('./package.json').version")"
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

"$SCRIPT_DIR/dist/dbq-v$VERSION-$PLATFORM-$ARCH/install.sh"
