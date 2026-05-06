# veto

## What this codebase does

Veto is an open-source TypeScript/Python policy runtime and CLI for AI agent tool calls. It wraps tools with `protect()`/`Veto.wrap()`, evaluates YAML or built-in policy packs deterministically, supports cloud/self-host validation, approval workflows, MCP integrations, Claude/Codex/Cursor install hooks, and an HTTP proxy that intercepts OpenAI/Anthropic tool-call responses.

## Auth shape

- Local SDK enforcement is policy-driven, not user-authenticated: `Veto.init()`, `Veto.fromRules()`, `protect()`, and `guard()` must fail closed when configured policy/cloud init or validation breaks.
- Cloud CLI/API paths authenticate via `VETO_API_KEY` or `~/.veto/cloud-session.json` loaded by `resolveCloudAuthHeaders()` in `headless.ts`; tokens must never be logged or exported.
- Validation API clients use `Authorization: Bearer` from `ValidationAPIClient.buildHeaders()` and respect `failMode` (`closed` default, `open` explicit only).
- Installed agent hooks/MCP proxies trust project-local `veto/veto.config.yaml` as the configured boundary; missing config is bootstrap, present-but-broken config should deny.
- Policy YAML is parsed/validated through `validatePolicyIR()`, `RuleLoader`, and built-in policy pack resolution before runtime use.

## Threat model

Highest impact is silent fail-open: destructive tool calls, money movement, file/network access, or agent browser actions proceeding when Veto was configured but failed to initialize or validate. Attackers also benefit from malformed hook payloads, tampered YAML policies, spoofed MCP/tool names, path traversal in CLI file operations, leaked API/session credentials, and proxy buffering edge cases that skip validation for real tool calls.

## Project-specific patterns to flag

- Any `catch` around `Veto.init()`, `guard()`, policy loading, hook execution, MCP proxying, or API validation that returns allow/pass unless an explicit unsafe option is required.
- Claude/Codex/Cursor install artifacts that allow tool calls after `veto/veto.config.yaml` exists but hook payload parsing, guard startup, timeout, invalid JSON, or `ok=false` fails.
- CLI commands that write policy/config files from prompts or flags (`policy generate/apply`, `init`, `install`, `mcp`) without path containment, schema validation, or deterministic error envelopes.
- Proxy/interceptor code that flushes buffered tool-call responses on parse errors, stream truncation, or buffer overflow without a clear documented fail-open boundary.
- Cloud/session code that prints, persists, or includes access tokens/API keys in structured error details, logs, exported findings, or generated config.

## Known false-positives

- `mode: 'log'`, `shadow`, `warn`, and safe-defaults observe mode intentionally allow execution while recording decisions; do not flag unless used after an initialization/validation failure.
- `validation.failMode: 'open'`, `allowAllOnInitError`, and `VETO_HOOK_FAIL_OPEN=1` are explicit unsafe compatibility opt-ins; flag only if defaulted or hidden.
- Tests, examples, fixtures, policy packs, and generated DeepSec data intentionally contain blocked commands, fake tokens, dangerous tool names, and invalid payloads.
- Local template fallback for policy generation is intentional when cloud/custom LLM generation is unavailable, but it must produce warnings and validated YAML.
- Self-host docs and Docker examples expose localhost/dev endpoints by design; production BYOC artifacts should remain outbound-only and avoid cross-account privileges.
