#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(bun -e 'console.log((await import("./package.json")).default.version)' 2>/dev/null || node -p 'require("./package.json").version')"
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
PACKAGE_NAME="dbq-v${VERSION}-${PLATFORM}-${ARCH}"
PACKAGE_DIR="$ROOT_DIR/dist/package"

cd "$ROOT_DIR"

rm -rf "$ROOT_DIR/dist"
mkdir -p "$PACKAGE_DIR/bin"

bun build --compile --outfile "$PACKAGE_DIR/bin/dbq" "$ROOT_DIR/src/index.ts"
swiftc "$ROOT_DIR/bin/confirm-query.swift" -o "$PACKAGE_DIR/bin/dbq-confirm"
install -m 0755 "$ROOT_DIR/bin/dbq-describe-postgres" "$PACKAGE_DIR/bin/dbq-describe-postgres"

install -m 0755 "$ROOT_DIR/install.sh" "$PACKAGE_DIR/install.sh"
install -m 0644 "$ROOT_DIR/config.example.toml" "$PACKAGE_DIR/config.example.toml"
install -m 0644 "$ROOT_DIR/README.md" "$PACKAGE_DIR/README.md"

(
  cd "$ROOT_DIR/dist"
  mv package "$PACKAGE_NAME"
  tar -czf "${PACKAGE_NAME}.tar.gz" "$PACKAGE_NAME"
)

echo "$ROOT_DIR/dist/${PACKAGE_NAME}.tar.gz"
