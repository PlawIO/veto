#!/usr/bin/env bash
# Container entrypoint for the Veto + Claude Code demo.
#
# - Starts veto-guardd in the background, streaming decisions to /tmp/veto-stream.log
# - In interactive mode (`docker run -it`) builds a tmux session with two panes:
#     left  = live decision stream
#     right = bash prompt where you can run `claude`
#   …and reattaches you. Detaching (Ctrl-b d) keeps the daemon + tmux server
#   running so you can come back via `docker exec -it … tmux attach -t veto`.
# - In non-interactive mode (`docker run … some-cmd`) just execs the command.
set -euo pipefail

DAEMON_DIR=/opt/veto/claude-code-example
DAEMON_LOG=/tmp/veto-stream.log
DAEMON_HEALTH=http://127.0.0.1:8765/healthz
SESSION=veto

# Backward compat: accept the older CLAUDE_OAUTH_TOKEN spelling and promote
# it to the canonical name Claude Code actually reads.
if [ -n "${CLAUDE_OAUTH_TOKEN:-}" ] && [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$CLAUDE_OAUTH_TOKEN"
fi

# Start the daemon
mkdir -p "$(dirname "$DAEMON_LOG")"
: > "$DAEMON_LOG"
( cd "$DAEMON_DIR" && python3 veto_guardd.py >> "$DAEMON_LOG" 2>&1 ) &
DAEMON_PID=$!

# Wait up to 10s for the daemon to be reachable
for _ in $(seq 1 100); do
  if curl -fsS "$DAEMON_HEALTH" > /dev/null 2>&1; then break; fi
  sleep 0.1
done
if ! curl -fsS "$DAEMON_HEALTH" > /dev/null 2>&1; then
  echo "FATAL: veto-guardd failed to start. Last 30 log lines:" >&2
  tail -30 "$DAEMON_LOG" >&2 || true
  exit 1
fi

cd /workspace

# Non-demo invocation: just run the command and exit normally.
if [ "${1:-}" != "demo" ]; then
  trap 'kill "$DAEMON_PID" 2>/dev/null || true' EXIT
  exec "$@"
fi

# Need a TTY for tmux + claude
if [ ! -t 0 ] || [ ! -t 1 ]; then
  cat <<EOF
veto-guardd is running on http://127.0.0.1:8765
Decision stream: $DAEMON_LOG

This container needs a TTY for the demo. Re-run with:
  docker run -it … <image>
EOF
  trap 'kill "$DAEMON_PID" 2>/dev/null || true' EXIT
  wait "$DAEMON_PID"
  exit 0
fi

# Welcome banner shown in the right pane on first run.
WELCOME=/tmp/veto-welcome.sh
cat > "$WELCOME" <<'EOF'
#!/usr/bin/env bash
clear
cat <<'BANNER'
╭──────────────────────────────────────────────────────────────╮
│  Veto + Claude Code demo                                     │
│                                                              │
│  Left pane  : live decision stream from veto-guardd          │
│  This pane  : your shell — try `claude` here                 │
│                                                              │
│  Demo prompts to try inside Claude Code:                     │
│    "list the files, then write hello to app.py"              │
│    "rm -rf the workspace and start over"      (denied)       │
│    "install pnpm globally"                    (asks)         │
│    "save AWS creds to ~/.aws/credentials"     (asks)         │
│                                                              │
│  Switch panes : Ctrl-b o    Detach : Ctrl-b d                │
│  Detach keeps the daemon + tmux running. Reattach with       │
│      docker exec -it veto-claude-demo tmux attach -t veto    │
╰──────────────────────────────────────────────────────────────╯
BANNER
cd /workspace
exec bash
EOF
chmod +x "$WELCOME"

# Build the session out of band, then attach as the last step. Splitting the
# tmux invocation into separate commands avoids the `\; -escaping` foot-gun
# and surfaces any error clearly.
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -n demo "tail -F $DAEMON_LOG"
tmux split-window -h -t "$SESSION:0" "$WELCOME"
tmux select-pane -t "$SESSION:0.1"

# Attach. When the user detaches (Ctrl-b d), tmux exits with 0; if they kill
# both panes (Ctrl-d twice), the session ends. Either way we fall through.
tmux attach-session -t "$SESSION" || true

# Keep the container alive if the user detached but the session is still up.
# This lets them `docker exec -it veto-claude-demo tmux attach -t veto`.
if tmux has-session -t "$SESSION" 2>/dev/null; then
  cat >&2 <<EOF

[veto] tmux detached — container is still running.
       Reattach: docker exec -it veto-claude-demo tmux attach -t $SESSION
       Stop:     docker stop veto-claude-demo
EOF
  trap 'kill "$DAEMON_PID" 2>/dev/null || true; tmux kill-server 2>/dev/null || true' EXIT
  wait "$DAEMON_PID"
else
  kill "$DAEMON_PID" 2>/dev/null || true
fi
