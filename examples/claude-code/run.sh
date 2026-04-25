#!/usr/bin/env bash
# Build and run the Veto + Claude Code demo container.
#
# Token resolution order:
#   1. CLAUDE_CODE_OAUTH_TOKEN already in your env
#   2. .env file beside this script (gitignored — convenient for local demos)
#   3. CLAUDE_OAUTH_TOKEN as a backward-compat alias
#
# Usage:
#   ./run.sh             # build (if needed) + start interactive demo
#   ./run.sh build       # just rebuild the image
#   ./run.sh shell       # start without tmux, drop straight into bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
IMAGE=veto-claude-demo:latest

# Source .env (if present) so the token can be set there.
if [ -f "$HERE/.env" ]; then
  # shellcheck disable=SC1091
  set -a; source "$HERE/.env"; set +a
fi

# Accept either spelling, but normalize to CLAUDE_CODE_OAUTH_TOKEN.
TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-${CLAUDE_OAUTH_TOKEN:-}}"
if [ -z "$TOKEN" ]; then
  cat >&2 <<EOF
ERROR: no Claude Code OAuth token in environment.

Either:
  export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
  ./run.sh

…or create $HERE/.env (gitignored) with:
  CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...
EOF
  exit 1
fi

cmd="${1:-up}"

case "$cmd" in
  build)
    docker build --pull -t "$IMAGE" -f "$HERE/Dockerfile" "$REPO_ROOT"
    ;;
  up|"")
    if ! docker image inspect "$IMAGE" > /dev/null 2>&1; then
      docker build -t "$IMAGE" -f "$HERE/Dockerfile" "$REPO_ROOT"
    fi
    docker run --rm -it \
      --name veto-claude-demo \
      -e "CLAUDE_CODE_OAUTH_TOKEN=$TOKEN" \
      -e "TERM=xterm-256color" \
      "$IMAGE"
    ;;
  shell)
    if ! docker image inspect "$IMAGE" > /dev/null 2>&1; then
      docker build -t "$IMAGE" -f "$HERE/Dockerfile" "$REPO_ROOT"
    fi
    docker run --rm -it \
      --name veto-claude-demo-shell \
      -e "CLAUDE_CODE_OAUTH_TOKEN=$TOKEN" \
      -e "TERM=xterm-256color" \
      "$IMAGE" bash
    ;;
  *)
    echo "usage: $0 [build|up|shell]" >&2
    exit 1
    ;;
esac
