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

- `openclaw-native`: Veto returns `require_approval`, and OpenClaw handles the approval prompt with its built-in UX.
- `veto-cloud`: Veto polls Veto Cloud until the approval is resolved. Use this when you want approvals to appear in the Veto dashboard and trigger cloud workflows like notifications or webhooks.

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
    description: Block reads of SSH keys and environment files
    tools: [read_file]
    severity: deny
    when:
      path:
        matches: "(^|/)(\\.env|id_rsa|id_ed25519)$"
    deny: "Reading secrets is not allowed"
```

### Shell commands

```yaml
rules:
  - id: require-approval-for-destructive-shell
    description: Require approval before destructive shell usage
    tools: [bash, shell]
    severity: require_approval
    when:
      command:
        matches: "\\b(rm -rf|sudo rm|shutdown|reboot)\\b"
    deny: "Destructive shell commands require approval"
```

### External APIs

```yaml
rules:
  - id: block-unapproved-webhooks
    description: Only allow requests to approved domains
    tools: [http_request, fetch]
    severity: deny
    when:
      url:
        not_matches: "^https://(api\\.)?(example\\.com|stripe\\.com|slack\\.com)/"
    deny: "Outbound API calls must target approved domains"
```

## What the plugin does

- validates every `before_tool_call` through `veto.guard()`
- blocks denied calls before execution
- supports OpenClaw-native and Veto Cloud approval flows
- records post-execution tool activity for audit visibility

## Docs

For the full rule format, policy packs, cloud approvals, and deployment guidance, see https://docs.veto.so.
