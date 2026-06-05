#!/usr/bin/env bash
set -euo pipefail

DBQ_HOME="${DBQ_HOME:-"$HOME/.dbq"}"
DBQ_BIN_DIR="${DBQ_BIN_DIR:-"$HOME/.local/bin"}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$DBQ_HOME/bin"
mkdir -p "$DBQ_BIN_DIR"

install -m 0755 "$SCRIPT_DIR/bin/dbq" "$DBQ_HOME/bin/dbq"
install -m 0755 "$SCRIPT_DIR/bin/dbq-confirm" "$DBQ_HOME/bin/dbq-confirm"
install -m 0755 "$SCRIPT_DIR/bin/dbq-describe-postgres" "$DBQ_HOME/bin/dbq-describe-postgres"

write_env_file() {
  {
    printf 'export DBQ_HOME=%q\n' "$DBQ_HOME"
    printf 'export DBQ_BIN_DIR=%q\n' "$DBQ_BIN_DIR"
    cat <<'EOF_ENV'
case ":$PATH:" in
  *":$DBQ_BIN_DIR:"*) ;;
  *) export PATH="$DBQ_BIN_DIR:$PATH" ;;
esac
EOF_ENV
  } > "$DBQ_HOME/env"
  chmod 0644 "$DBQ_HOME/env"
}

write_launcher() {
  local name="$1"
  local target="$2"

  cat > "$DBQ_BIN_DIR/$name" <<EOF_LAUNCHER
#!/usr/bin/env bash
export DBQ_HOME="\${DBQ_HOME:-$DBQ_HOME}"
export DBQ_BIN_DIR="\${DBQ_BIN_DIR:-$DBQ_BIN_DIR}"
exec "$target" "\$@"
EOF_LAUNCHER
  chmod 0755 "$DBQ_BIN_DIR/$name"
}

write_env_file
write_launcher "dbq" "$DBQ_HOME/bin/dbq"
write_launcher "dbq-confirm" "$DBQ_HOME/bin/dbq-confirm"
write_launcher "dbq-describe-postgres" "$DBQ_HOME/bin/dbq-describe-postgres"

if [ ! -f "$DBQ_HOME/config.jsonc" ]; then
  install -m 0600 "$SCRIPT_DIR/config.example.jsonc" "$DBQ_HOME/config.jsonc"
fi
install -m 0644 "$SCRIPT_DIR/config.schema.json" "$DBQ_HOME/config.schema.json"

ENV_NOTE="
To make DBQ_HOME, DBQ_BIN_DIR, and PATH available in your shell:

  source \"$DBQ_HOME/env\"
"

cat <<EOF
DBQ installed to $DBQ_HOME
CLI wrappers installed to $DBQ_BIN_DIR
Shell env file written to $DBQ_HOME/env
$ENV_NOTE

Run the local CLI with:

  dbq list
  dbq describe DATABASE_ID
  dbq query DATABASE_ID 'select * from table_name'

Edit your database registry:

  $DBQ_HOME/config.jsonc
  $DBQ_HOME/config.schema.json
EOF
