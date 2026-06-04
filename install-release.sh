#!/usr/bin/env bash
set -euo pipefail

REPO="${DBQ_REPO:-CasperEngl/dbq}"
DBQ_HOME="${DBQ_HOME:-"$HOME/.dbq"}"
DBQ_BIN_DIR="${DBQ_BIN_DIR:-"$HOME/.local/bin"}"
VERSION="${DBQ_VERSION:-latest}"

case "$(uname -s)" in
  Darwin) PLATFORM="darwin" ;;
  *)
    echo "DBQ release installer currently supports macOS only." >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  *)
    echo "DBQ release installer currently supports Apple Silicon only." >&2
    exit 1
    ;;
esac

if [ "$VERSION" = "latest" ]; then
  API_URL="https://api.github.com/repos/$REPO/releases/latest"
else
  API_URL="https://api.github.com/repos/$REPO/releases/tags/$VERSION"
fi

ASSET_URL="$(
  curl -fsSL "$API_URL" |
    sed -nE 's/.*"browser_download_url": "([^"]*dbq-v[^"]*-'"$PLATFORM"'-'"$ARCH"'\.tar\.gz)".*/\1/p' |
    head -n 1
)"

if [ -z "$ASSET_URL" ]; then
  echo "Could not find a DBQ $PLATFORM-$ARCH release asset for $VERSION." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

curl -fsSL "$ASSET_URL" -o "$TMP_DIR/dbq.tar.gz"
tar -xzf "$TMP_DIR/dbq.tar.gz" -C "$TMP_DIR"

PACKAGE_DIR="$(find "$TMP_DIR" -maxdepth 1 -type d -name 'dbq-v*' | head -n 1)"

if [ -z "$PACKAGE_DIR" ]; then
  echo "Release archive did not contain a DBQ package directory." >&2
  exit 1
fi

DBQ_HOME="$DBQ_HOME" DBQ_BIN_DIR="$DBQ_BIN_DIR" "$PACKAGE_DIR/install.sh"
