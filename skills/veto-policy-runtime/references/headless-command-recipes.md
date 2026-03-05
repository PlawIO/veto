# Headless Command Recipes

Use these commands for non-interactive agent workflows.

## Create Policy (Deterministic First)

```bash
npx -y veto-cli@latest policy generate \
  --tool <tool_name> \
  --prompt "<policy_intent>" \
  --mode-hint deterministic \
  --save ./veto/rules/<tool_name>-<intent>.generated.yaml \
  --json
```

## Create Policy (LLM-Assisted)

```bash
npx -y veto-cli@latest policy generate \
  --tool <tool_name> \
  --prompt "<policy_intent>" \
  --mode-hint llm \
  --save ./veto/rules/<tool_name>-<intent>.generated.yaml \
  --json
```

## Apply Policy Locally

```bash
npx -y veto-cli@latest policy apply \
  --file ./veto/rules/<tool_name>-<intent>.generated.yaml \
  --target local \
  --json
```

## Apply Policy To Cloud Drafts

```bash
npx -y veto-cli@latest policy apply \
  --file ./veto/rules/<tool_name>-<intent>.generated.yaml \
  --target cloud \
  --json
```

## Validate a Tool Call

```bash
npx -y veto-cli@latest guard check \
  --tool <tool_name> \
  --args '{"key":"value"}' \
  --mode local \
  --json
```

## Validate With stdin JSON

```bash
echo '{"key":"value"}' | npx -y veto-cli@latest guard check \
  --tool <tool_name> \
  --mode local \
  --json
```

## Cloud Session Setup

```bash
npx -y veto-cli@latest cloud login
npx -y veto-cli@latest cloud whoami
```

## Diagnostics

```bash
npx -y veto-cli@latest doctor --json
```

## Non-Destructive Policy Rule

- Allowed: `policy generate`, `policy apply`, `guard check`.
- Not allowed: deleting or editing existing policy files, or invoking policy delete/update APIs.
