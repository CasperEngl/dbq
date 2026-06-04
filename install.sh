#!/usr/bin/env bash
set -euo pipefail

DBQ_HOME="${DBQ_HOME:-"$HOME/.dbq"}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$DBQ_HOME/bin"

install -m 0755 "$SCRIPT_DIR/bin/dbq-mcp" "$DBQ_HOME/bin/dbq-mcp"
install -m 0755 "$SCRIPT_DIR/bin/DBQ" "$DBQ_HOME/bin/DBQ"

if [ ! -f "$DBQ_HOME/config.toml" ]; then
  install -m 0600 "$SCRIPT_DIR/config.example.toml" "$DBQ_HOME/config.toml"
fi

cat <<EOF
DBQ installed to $DBQ_HOME

Add this stdio MCP source to your client:

  command: $DBQ_HOME/bin/dbq-mcp
  args: []

Edit your database registry:

  $DBQ_HOME/config.toml
EOF
