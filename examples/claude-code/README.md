# Veto for Claude Code

Govern every tool call Claude Code makes — `Read`, `Write`, `Bash`, `Edit`,
`WebFetch`, MCP tools, all of them — with Veto policies. Watch decisions stream
in your terminal as the agent works.

```
12:03:01 allow  Bash({command: 'npm test'})                    3ms
12:03:04 deny   Bash({command: 'rm -rf /tmp/cache'})            1ms  policy:deny-rm-rf
12:03:08 await  Write({file_path: '/Users/me/.ssh/config'})      -   approval-required
12:03:21 allow  Write({file_path: '/Users/me/.ssh/config'})    13s  approved
```

## How it works

1. **`veto_guardd.py`** — long-running daemon. Loads `rules.yaml`, holds a single
   Veto instance, listens on `localhost:8765`. Prints every decision to stderr
   via Veto's stream logger.
2. **`hook.py`** — Claude Code `PreToolUse` hook. Reads each tool call from stdin,
   asks the daemon, returns the decision Claude Code expects on stdout. Tiny
   (~20 lines of `urllib`), no Veto import — adds ~5ms per tool call.
3. **`rules.yaml`** — your policies. Starts with sensible defaults (no `rm -rf`,
   no force-pushes, ask for `sudo`, ask before touching `~/.ssh`, …). Edit freely.

Decision mapping:

| Veto decision      | Claude Code permission | Effect                                 |
| ------------------ | ---------------------- | -------------------------------------- |
| `allow`            | `allow`                | Runs without prompting                 |
| `deny`             | `deny`                 | Blocked; reason shown to Claude        |
| `require_approval` | `ask`                  | Claude Code surfaces its permission UI |

## Quickstart — Docker (recommended for a clean demo)

A single container that ships Claude Code, Veto, the daemon, the hook, and a
seed workspace — split into two tmux panes (live decision stream on the left,
your shell on the right).

```bash
# 1. Drop your token in .env (gitignored)
cp .env.example .env
$EDITOR .env

# 2. Build + run
./run.sh
```

You land in tmux — type `claude` in the right pane and start asking it to do
things. Detach tmux with `Ctrl-b d`; switch panes with `Ctrl-b o`.

`./run.sh shell` skips tmux and drops you straight into bash if you'd rather
not deal with split panes.

## Quickstart — host machine

```bash
# 1. Install the hook into a project (creates .claude/hooks/veto-hook.py
#    and merges hooks.PreToolUse into .claude/settings.json)
./install.sh /path/to/your/project

# 2. Start the daemon (leave running in a dedicated terminal)
python3 veto_guardd.py

# 3. Open Claude Code in that project — every tool call is now governed,
#    every decision streams to the daemon's terminal in real time.
```

The hook **fails open** when the daemon isn't running — Claude Code keeps
working, you just see a `[veto-hook] guard daemon unreachable` line in stderr.
That's intentional: governance shouldn't break the developer's flow if the
daemon happens to crash.

## Configuration

### Daemon flags

```bash
python3 veto_guardd.py --rules path/to/rules.yaml --port 8765 --host 127.0.0.1
```

| Env var            | Default             | Purpose                                                     |
| ------------------ | ------------------- | ----------------------------------------------------------- |
| `VETO_LOG`         | `stream` (auto-set) | Logging mode (`stream`, `stream:verbose`, `info`, `silent`) |
| `VETO_GUARDD_PORT` | `8765`              | Daemon listen port                                          |

### Hook env vars

| Env var               | Default                       | Purpose                            |
| --------------------- | ----------------------------- | ---------------------------------- |
| `VETO_GUARDD_URL`     | `http://127.0.0.1:8765/guard` | Where the hook talks to the daemon |
| `VETO_GUARDD_TIMEOUT` | `5`                           | Seconds before the hook fails open |

## Writing rules

Rules live in `rules.yaml`. Each rule has an `id`, a list of `tools` it applies
to, an `action` (`block`, `require_approval`, or `allow`), and `conditions`
(all must match — AND).

```yaml
- id: ask-prod-deploys
  description: Surface kubectl/gcloud commands targeting prod
  tools: [Bash]
  action: require_approval
  severity: high
  conditions:
    - field: arguments.command
      operator: matches
      value: "(kubectl|gcloud)\\s+.*\\b(prod|production)\\b"
```

**Field paths** — `arguments.<input_field>`. The shape of `tool_input` depends on
the tool: `Bash` → `command`, `Write` → `file_path` + `content`, `WebFetch` →
`url`, `Edit` → `file_path` + `old_string` + `new_string`, etc. See Claude Code's
tool docs for the exact schema per tool.

**Operators** — `equals`, `not_equals`, `contains`, `not_contains`, `starts_with`,
`ends_with`, `matches` (regex, case-insensitive), `greater_than`, `less_than`,
`length_greater_than`, `in`, `not_in`, `within_hours`, `outside_hours`.

When you edit `rules.yaml`, **restart the daemon** (Ctrl+C and re-run) — rules
are loaded at startup, not per-request.

## File layout

```
examples/claude-code/
├── README.md              # this file
├── rules.yaml             # starter policies
├── veto_guardd.py         # daemon
├── hook.py                # PreToolUse hook (deployed to project's .claude/hooks/)
├── settings.example.json  # the snippet install.sh merges into settings.json
├── install.sh             # one-shot installer for a target project
├── Dockerfile             # demo container (Claude Code + Veto + daemon)
├── docker-entrypoint.sh   # starts daemon + tmux split-pane demo
├── run.sh                 # build/run helper for the docker path
├── .env.example           # template for CLAUDE_OAUTH_TOKEN
└── .gitignore             # keeps .env out of git
```
