# openclaw-veto

Veto guardrails for OpenClaw agents.

`openclaw-veto` intercepts every OpenClaw tool call, validates it through Veto, and either allows it, blocks it, or routes it into a human approval flow.

## Install

```bash
openclaw plugins install openclaw-veto
```

## Setup

Initialize Veto in your project so the plugin can load `veto/veto.config.yaml` and your rules:

```bash
cd your-project
veto init
```

That creates the local Veto config directory:

```
veto/
  veto.config.yaml
  rules/
```

## Configure approval mode

By default, `openclaw-veto` uses OpenClaw's native approval UX.

Add plugin configuration to your `openclaw.json`:

```json
{
  "plugins": {
    "veto": {
      "approvalMode": "openclaw-native"
    }
  }
}
```

Supported modes:

- `openclaw-native`: Veto returns `require_approval`, and OpenClaw handles the approval prompt with its built-in UX. This works with local YAML rules.
- `veto-cloud`: Veto polls Veto Cloud until the approval is resolved. Use this when you want approvals to appear in the Veto dashboard and trigger cloud workflows like notifications or webhooks.

`veto-cloud` requires Veto Cloud mode to be configured. Set `VETO_API_KEY` in the environment or configure `cloud.apiKey` in `veto/veto.config.yaml`. If Veto is only running with local YAML rules and no cloud API key, approval paths must use `openclaw-native`.

Example:

```json
{
  "plugins": {
    "veto": {
      "approvalMode": "veto-cloud"
    }
  }
}
```

## Example rules

### File access

```yaml
rules:
  - id: block-sensitive-files
    name: Block sensitive file reads
    enabled: true
    severity: critical
    action: block
    tools: [read_file]
    conditions:
      - field: arguments.path
        operator: matches
        value: "(^|/)(\\.env|id_rsa|id_ed25519)$"
    message: Reading secrets is not allowed
```

### Shell commands

```yaml
rules:
  - id: require-approval-for-destructive-shell
    name: Require approval for destructive shell commands
    enabled: true
    severity: high
    action: require_approval
    tools: [bash, shell]
    conditions:
      - field: arguments.command
        operator: matches
        value: "\\b(rm -rf|sudo rm|shutdown|reboot)\\b"
    message: Destructive shell commands require approval
```

### External APIs

```yaml
rules:
  - id: block-unapproved-webhooks
    name: Block outbound requests to unapproved domains
    enabled: true
    severity: high
    action: block
    tools: [http_request, fetch]
    conditions:
      - field: arguments.url
        operator: not_matches
        value: "^https://(api\\.)?(example\\.com|stripe\\.com|slack\\.com)/"
    message: Outbound API calls must target approved domains
```

## What the plugin does

- validates every `before_tool_call` through `veto.guard()`
- blocks denied calls before execution
- supports OpenClaw-native and Veto Cloud approval flows
- records post-execution tool activity for audit visibility

## Docs

For the full rule format, policy packs, cloud approvals, and deployment guidance, see https://docs.veto.so.
