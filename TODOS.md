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

## Competitive Feature Parity — DONE

All 4 items shipped in `fix/sdk/hardening-audit-fixes`:

- ~~Python SDK parity~~ — rate limiting, audit chain, OTEL, test runner ported
- ~~Unify `veto test`~~ — `veto test` is fixture runner, `--gaps` for gap analysis, `run-tests` deprecated
- ~~Distributed rate limiting~~ — `RedisRateLimitStore` with EVALSHA, optional `redis` peer dep
- ~~Anthropic streaming~~ — `AnthropicInterceptor`, `--format` flag, auto-detect from target URL
