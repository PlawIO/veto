#!/usr/bin/env bash
# Wire this Veto hook into a Claude Code project.
#
# Usage:
#   ./install.sh                        # install into the current directory
#   ./install.sh /path/to/project       # install into a specific project
#
# What it does:
#   1. Copies hook.py to <project>/.claude/hooks/veto-hook.py and chmods +x
#   2. Merges hooks.PreToolUse into <project>/.claude/settings.json
#      (creates the file if it doesn't exist; preserves anything already there)
#
# Run veto_guardd.py separately in another terminal so you can watch the
# decision stream.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${1:-$(pwd)}"
TARGET="$(cd "$TARGET" && pwd)"

HOOKS_DIR="$TARGET/.claude/hooks"
SETTINGS_PATH="$TARGET/.claude/settings.json"

mkdir -p "$HOOKS_DIR"
cp "$HERE/hook.py" "$HOOKS_DIR/veto-hook.py"
chmod +x "$HOOKS_DIR/veto-hook.py"
echo "✓ installed hook → $HOOKS_DIR/veto-hook.py"

# Merge hook config into settings.json. Use python so we don't add jq as a dep.
python3 - "$SETTINGS_PATH" <<'PY'
import json, os, sys
path = sys.argv[1]
existing = {}
if os.path.exists(path):
    with open(path) as f:
        try:
            existing = json.load(f)
        except json.JSONDecodeError:
            print(f"warn: {path} is not valid JSON; aborting merge", file=sys.stderr)
            sys.exit(1)

hooks = existing.setdefault("hooks", {})
pre = hooks.setdefault("PreToolUse", [])
new_block = {
    "matcher": "",
    "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/veto-hook.py",
        "timeout_ms": 5000,
    }],
}

# Don't double-install if our exact hook command is already present.
def already_installed(blocks):
    for b in blocks:
        for h in b.get("hooks", []):
            cmd = h.get("command", "")
            if "veto-hook.py" in cmd:
                return True
    return False

if already_installed(pre):
    print("✓ hook config already present in settings.json — no changes")
else:
    pre.append(new_block)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(existing, f, indent=2)
        f.write("\n")
    print(f"✓ wired hook into {path}")
PY

cat <<EOF

Done. Next steps:

  1. Start the daemon (in another terminal):
       cd $HERE
       python3 veto_guardd.py

  2. Open Claude Code in $TARGET — every tool call is now governed.

EOF
