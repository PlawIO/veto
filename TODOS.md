# TODOs

## Economic Authorization — Deferred Items

### MPP Spec Tracking

**What:** Track Stripe MPP spec changes and update connector when spec stabilizes.
**Why:** MPP launched 2026-03-18 and the spec may evolve. Our connector uses `protocolVersion: '2026.03'` and parses session tokens, costs, and payer from both top-level and nested `mpp_session` shapes. If Stripe changes the header names or session format, the connector will silently fail closed (safe, but lossy).
**How to apply:** Monitor Stripe's developer changelog for MPP updates. When the spec stabilizes (likely Q3 2026), pin the connector to a specific protocol version and add version negotiation.
**Priority:** P2
**Effort:** S (human) → S (CC)

### AP2 Mandate Signature Verification

**What:** Add cryptographic verification of AP2 mandate signatures.
**Why:** v1 connector trusts `mandate_id` and `expires_at` at face value. A malicious response could forge mandate data. Google AP2 mandates are cryptographically signed — verifying the signature ensures the mandate is authentic and hasn't been tampered with.
**How to apply:** Import AP2 verification library (when available) or implement Ed25519 signature check against Google's public key. Add `verify_signature: boolean` option to AP2 connector config, defaulting to `false` for backward compatibility.
**Priority:** P1 (security-sensitive)
**Effort:** M (human) → S (CC)
**Blocked by:** Google AP2 SDK availability / public key distribution mechanism

## Competitive Feature Parity

### Python SDK parity for new features

**What:** Port `veto run-tests`, `veto audit verify`, stateful rate limiting, and OTEL integration to the Python SDK (`packages/sdk-python/`).
**Why:** The 6 new features (run-tests, crypto audit, rate limiting, OTEL, require_payment, veto intercept) are TypeScript-only. Python users get none of the competitive advantages.
**How to apply:** Implement `RateLimitStore` (in-memory dict of lists), `computeChainHash` (hashlib.sha256), `tryLoadOtel` (try/except on `opentelemetry-api` import), and `runTests` (yaml + local evaluator). `veto intercept` can reuse the existing CLI structure.
**Priority:** P1
**Effort:** L (human) → M (CC)

### Unify `veto test` umbrella command

**What:** Consolidate `veto test` (adversarial gap analysis) and `veto run-tests` (fixture-based policy unit tests) under a unified `veto test` command with subcommands.
**Why:** Two separate commands for related testing workflows creates friction. The split was intentional to avoid breaking `veto test` callers (it already exists as a gap analyzer at `cli/test.ts`). Once we confirm no downstream callers are broken by the change, unify as: `veto test` (fixture runner, current `veto run-tests`), `veto test --gaps` (adversarial gap analysis, current `veto test`).
**How to apply:** Deprecate `veto run-tests` with a forwarding message. Update help text and docs. Add `--gaps` flag to `veto test` that dispatches to `cli/test.ts`.
**Priority:** P2
**Effort:** S (human) → S (CC)

### Distributed rate limiting backend

**What:** Add Redis/Valkey backend for `rate_limits` to support multi-process deployments.
**Why:** Current rate limiting is process-local — resets on restart and is not shared across workers. Multi-instance agents (load balanced) can bypass per-user rate limits since each process has its own store.
**How to apply:** Add `rate_limiting.backend: redis` to config schema. Implement `RedisRateLimitStore` with `EVALSHA` for atomic sliding-window check-and-record. Fall back to in-memory store if Redis is unavailable (fail-open for rate limits only, not for security-critical rules).
**Priority:** P2
**Effort:** M (human) → S (CC)

### veto intercept — Anthropic streaming format

**What:** Add Anthropic SSE format support to `veto intercept`.
**Why:** v1 proxy handles OpenAI SSE format only. Anthropic's streaming format uses different event types (`content_block_start`, `input_json_delta`, `message_stop`) and different tool call assembly.
**How to apply:** Detect upstream URL or add `--format anthropic` flag. Implement `AnthropicInterceptor` following the same buffer/validate/flush pattern as `OpenAIInterceptor`.
**Priority:** P2
**Effort:** M (human) → S (CC)
