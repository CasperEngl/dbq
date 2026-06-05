#!/usr/bin/env bash
set -euo pipefail

DBQ_HOME="${DBQ_HOME:-"$HOME/.dbq"}"
DBQ_BIN_DIR="${DBQ_BIN_DIR:-"$HOME/.local/bin"}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$DBQ_HOME/bin"
mkdir -p "$DBQ_BIN_DIR"

install -m 0755 "$SCRIPT_DIR/bin/dbq" "$DBQ_HOME/bin/dbq"
install -m 0755 "$SCRIPT_DIR/bin/dbq-confirm" "$DBQ_HOME/bin/dbq-confirm"

ln -sf "$DBQ_HOME/bin/dbq" "$DBQ_BIN_DIR/dbq"
ln -sf "$DBQ_HOME/bin/dbq-confirm" "$DBQ_BIN_DIR/dbq-confirm"

if [ ! -f "$DBQ_HOME/config.toml" ]; then
  install -m 0600 "$SCRIPT_DIR/config.example.toml" "$DBQ_HOME/config.toml"
fi

PATH_NOTE=""
case ":$PATH:" in
  *":$DBQ_BIN_DIR:"*) ;;
  *)
    PATH_NOTE="
Add DBQ to your PATH:

  export PATH=\"$DBQ_BIN_DIR:\$PATH\"
"
    ;;
esac

cat <<EOF
DBQ installed to $DBQ_HOME
CLI links installed to $DBQ_BIN_DIR

Run the local CLI with:

  dbq list
  dbq describe DATABASE_ID
  dbq query DATABASE_ID 'select * from table_name'

Edit your database registry:

  $DBQ_HOME/config.toml
$PATH_NOTE
EOF
