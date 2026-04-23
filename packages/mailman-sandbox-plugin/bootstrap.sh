#!/bin/bash
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_PLUGIN_DIR="$HOME/plugins/mailman-sandbox"
MARKETPLACE_DIR="$HOME/.agents/plugins"
MARKETPLACE_FILE="$MARKETPLACE_DIR/marketplace.json"

mkdir -p "$HOME/plugins" "$MARKETPLACE_DIR"

if [ "$PLUGIN_ROOT" != "$HOME_PLUGIN_DIR" ]; then
  echo "[mailman-sandbox] expected plugin path: $HOME_PLUGIN_DIR"
  echo "[mailman-sandbox] current path: $PLUGIN_ROOT"
  echo "[mailman-sandbox] clone or move this repository to $HOME_PLUGIN_DIR for marketplace registration."
  exit 1
fi

if [ ! -f "$MARKETPLACE_FILE" ]; then
  cat > "$MARKETPLACE_FILE" <<'EOF'
{
  "name": "company-local",
  "interface": {
    "displayName": "Company Local"
  },
  "plugins": []
}
EOF
fi

python3 - "$MARKETPLACE_FILE" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text())
plugins = data.setdefault("plugins", [])

entry = {
    "name": "mailman-sandbox",
    "source": {
        "source": "local",
        "path": "./plugins/mailman-sandbox"
    },
    "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
    },
    "category": "Productivity"
}

plugins = [p for p in plugins if p.get("name") != "mailman-sandbox"]
plugins.append(entry)
data["plugins"] = plugins
path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
PY

cd "$PLUGIN_ROOT/runtime"
if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "[mailman-sandbox] created runtime/config.json"
fi

if command -v bun >/dev/null 2>&1; then
  bun install
else
  echo "[mailman-sandbox] bun not found. install bun, then run: cd $PLUGIN_ROOT/runtime && bun install"
fi

echo "[mailman-sandbox] bootstrap complete"
echo "[mailman-sandbox] next:"
echo "  1. edit $PLUGIN_ROOT/runtime/config.json"
echo "  2. restart Codex if plugin list does not refresh automatically"
