---
name: veto-policy-runtime
description: >
  Create and apply new Veto policies safely for AI agents using deterministic
  rules first, with optional LLM-assisted generation when needed. Use this when
  you must add guardrails without editing or deleting existing policies.
license: Apache-2.0
compatibility: Requires `veto-cli` and a project-local `veto/` config directory.
---

# Veto Policy Runtime

This skill makes Veto policy authoring agent-native and safe-by-default.

## Use This Skill When

- You need to add a new policy for one or more tools.
- You need deterministic enforcement in local runtime.
- You want optional LLM-assisted policy generation with CLI commands.
- You must avoid destructive policy operations.

## Hard Safety Rules

1. Never delete policy files.
2. Never modify existing policy files in place.
3. Create new policy files under `veto/rules/` only.
4. Do not call delete/update policy APIs in cloud workflows.
5. If asked to "change" a policy, create a new superseding policy file and explain precedence.

## Default Workflow (Create-Only)

1. Ensure project is initialized:

```bash
npx -y veto-cli@latest init
```

2. Generate policy from natural language (deterministic bias):

```bash
npx -y veto-cli@latest policy generate \
  --tool approve_invoice \
  --prompt "do not approve invoices above 50 dollars" \
  --mode-hint deterministic \
  --save ./veto/rules/approve-invoice-over-50.generated.yaml \
  --json
```

3. If semantics are too broad for strict constraints, use LLM generation explicitly:

```bash
npx -y veto-cli@latest policy generate \
  --tool outbound_email \
  --prompt "deny sending customer data outside approved domains" \
  --mode-hint llm \
  --save ./veto/rules/outbound-email-sensitive.generated.yaml \
  --json
```

4. Apply generated file (local deterministic runtime):

```bash
npx -y veto-cli@latest policy apply \
  --file ./veto/rules/approve-invoice-over-50.generated.yaml \
  --target local \
  --json
```

5. Validate behavior with explicit test calls:

```bash
npx -y veto-cli@latest guard check \
  --tool approve_invoice \
  --args '{"amount":40}' \
  --mode local \
  --json

npx -y veto-cli@latest guard check \
  --tool approve_invoice \
  --args '{"amount":75}' \
  --mode local \
  --json
```

## Deterministic-First Decision Rule

- Use `deterministic` when policy can be expressed as thresholds, enums, allowlists, deny-lists, ranges, presence checks, or regex-like constraints.
- Use `llm` only for semantic intent that cannot be captured reliably with deterministic constraints.

## Cloud Workflow (Create Drafts Only)

Use cloud target for draft creation and review flows without destructive changes:

```bash
npx -y veto-cli@latest policy generate \
  --tool approve_invoice \
  --prompt "require approval for invoices over 1000" \
  --target cloud \
  --mode-hint deterministic \
  --json

npx -y veto-cli@latest policy apply \
  --file ./veto/rules/approve-invoice-over-1000.generated.yaml \
  --target cloud \
  --json
```

## Runtime Integration (TypeScript)

```ts
import { Veto } from "veto-sdk";

const veto = await Veto.init();
const guardedTools = veto.wrap(tools);
```

## Runtime Integration (Python)

```python
from veto import Veto

veto = await Veto.init()
guarded_tools = veto.wrap(tools)
```

## Output Contract For Agents

When this skill runs successfully, return:

1. Created policy file path(s)
2. Tool names covered
3. `guard check` results for allow and deny scenarios
4. Whether deterministic or llm mode was used
5. Any warnings from CLI generation

## References

- `references/headless-command-recipes.md`
- `references/policy-patterns.md`
