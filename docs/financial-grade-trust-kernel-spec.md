# Veto Financial-Grade Trust Kernel Spec

Status: active implementation spec  
Source of truth: Veto is financial-grade agent infrastructure for irreversible actions, not a generic AGT/IAM/governance clone.  
Audience: SDK/kernel, platform, hosted docs, release engineering.

This document is the checklist that drives the multi-PR implementation. A claim is not done because it appears in docs or examples; it is done only when the evidence below points to code, tests, and release gates.

## Product Contract

Veto proves whether a machine action is authorized before it executes, then emits an offline-verifiable receipt for the exact decision.

The first killer workflow is AP/procurement/refunds:

1. An agent proposes `issue_refund`, `approve_invoice`, or `wire_transfer`.
2. Local enforcement evaluates a compiled policy bundle without Veto Cloud.
3. The result is `allow`, `deny`, or `require_approval`.
4. Approval artifacts bind exact action commitments and cannot be replayed for a different action.
5. Every recorded decision can append a chained `veto.receipt/1` receipt.
6. Veto Cloud is the enterprise control plane for authoring, approvals, rollout, indexing, retention, and audit export. It is not the local trust root.

Public category copy stays simple: "rules for AI agents" and "prove machine action authority before execution." MAP remains technical/deep docs until the demo and conformance suite are real.

## Dependency Zones

Local enforcement is the trusted computing base.

| Zone                   | Packages                                           | Rule                                                                                                                                                 | Current status |
| ---------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Local trust kernel     | `crates/veto-core`, future thin TS/Python bindings | No third-party npm/PyPI runtime code on the decision path. Rust crypto/canonicalization dependencies require explicit audited budget.                | In progress    |
| Protocol helpers       | `packages/receipt-protocol`, `packages/map-core`   | Small audited dependency budget only. No cloud/CLI/provider imports.                                                                                 | Bridge         |
| TS SDK app surface     | `packages/sdk`                                     | Current runtime dependencies are frozen until zero-dep split lands. CLI/UI/cloud/integration dependencies must not move into base dependencies.      | Gate added     |
| Python SDK app surface | `packages/sdk-python`                              | Current base dependencies are frozen until extras split lands. Rich/Typer/server/proxy/cloud deps must not be required for simple local enforcement. | Gate added     |
| CLI/UI                 | `packages/cli`, SDK `src/cli/*`                    | May depend on UI/terminal libraries. Must not become the local trust kernel.                                                                         | Bridge         |
| Hosted platform        | `veto-platform`                                    | May use platform dependencies. Receipt append and audit export invariants must be enforced by storage, not by docs claims.                           | In progress    |
| Hosted docs            | `veto-platform/apps/docs`                          | High-stakes claims require a claims manifest entry with code/test/release evidence.                                                                  | In progress    |

Executable gate: `pnpm check:dependency-zones`.

The gate intentionally freezes current bridge dependency budgets. It does not claim zero-dep enforcement is complete; it prevents dependency creep while `veto-core` and wrapper packages are built.

Current evidence:

- Dependency budget script: `scripts/check-dependency-zones.mjs`
- Local command: `pnpm check:dependency-zones`
- CI wiring: `.github/workflows/ci.yml`

## Protocol Spine

MAP-Core is the contract spine being introduced for Rust, TypeScript, Python, and platform conformance.

Required artifact families:

- `map.authority/0.1`: issuer, subject, delegator/on_behalf_of, audience, allowed actions, scope, limits, state refs, conditions, validity, evidence, receipt requirements.
- `map.policy_pack/0.1`: compiled policy bundle used by local enforcement. YAML/prose are authoring surfaces only.
- `map.approval/0.1`: exact action approval artifact with commitment, expiration, approver, and replay protection.
- `map.receipt/0.1` / `veto.receipt/1`: decision receipt payload with canonical hash and chain links.

Required fixture groups:

- decisions: allow, deny, require approval
- reason codes and failure details
- raw argument commitments and redacted payloads
- approval replay and expiration
- malformed bundles and malformed receipts
- no-network local enforcement
- cross-runtime parity for Rust, TS, Python, and platform

Current evidence:

- MAP-Core package: `packages/map-core`
- Artifact types: `packages/map-core/src/types.ts`
- Dependency-free commitments: `packages/map-core/src/commitment.ts`
- Artifact/fixture validation: `packages/map-core/src/validate.ts`
- Conformance fixtures: `packages/map-core/fixtures/*.json`
- Fixture tests: `packages/map-core/test/fixtures.test.ts`

## Rust Trust Kernel

`veto-core` is the canonical local trust kernel.

Required APIs:

- `enforce(bundle, action, context) -> DecisionOutcome`
- `verify_bundle(bundle) -> VerificationResult`
- `verify_receipt(receipt) -> VerificationResult`
- `verify_receipt_chain(receipts) -> ChainVerifyResult`
- `compute_commitment(value) -> sha256:<hex>`

Non-negotiables:

- no cloud, CLI, provider, UI, or filesystem policy discovery inside the kernel
- deterministic evaluator
- fail-closed typed errors
- canonical JSON commitments
- receipt hashing and chain verification shared with wrappers
- Rust unit, property, fuzz, and benchmark tests

Current evidence:

- Initial kernel crate: `crates/veto-core`
- MAP fixture enforcement and replay checks: `crates/veto-core/tests/map_fixtures.rs`
- Receipt hashing and chain verification checks: `crates/veto-core/tests/receipt_chain.rs`
- Explicit Rust dependency budget: `scripts/check-dependency-zones.mjs`

Remaining kernel gaps:

- signed bundle verification
- full policy expression language
- property/fuzz/benchmark jobs
- TS/Python bindings over the Rust kernel

## SDK Requirements

TypeScript and Python must be thin ergonomic faces over the kernel.

Required local APIs:

- `Veto.local({ bundle, receipts })`
- `enforce` / `validate`
- `protect`
- receipt `export`, `show`, `verify`
- no-network local enforcement test

Required packaging:

- base local enforcement installs without CLI/cloud/integration deps
- optional extras/packages for CLI, cloud, proxy/server, integrations, and UI
- no postinstall scripts for local enforcement packages
- package smoke tests for clean `npm`, `pnpm`, `uvx`, and `pipx` installs

## Platform Requirements

Receipt storage must be finance-grade before docs make finance-grade claims.

Done criteria:

- one storage-owned append operation per org/project receipt chain
- Postgres transaction/locking
- SQLite transaction and chain indexes
- Convex CAS-style mutation
- per-chain sequence invariant
- unique previous-hash invariant to reject forks
- concurrent validation test
- export pagination beyond 10k without silent truncation
- receipt protocol schema generated from or checked against the shared protocol package

Current evidence:

- Platform append hardening PR: `veto-platform` receipt storage append changes
- Storage contract: `apps/server/src/db/drivers/types.ts`
- Postgres append: `apps/server/src/db/queries/receipts.ts`
- SQLite append: `apps/server/src/db/drivers/sqlite.ts`
- Convex append: `convex/decisionReceipts.ts`
- Concurrency test: `apps/server/src/routes/__tests__/validate-sqlite-selfhost.test.ts`

Remaining platform gap:

- decision row creation and receipt append are still separate operations; a later PR must make the validation decision plus receipt append one storage-owned unit or add a reconciler with explicit failure semantics.
- OpenAPI still mirrors the receipt schema shape instead of importing/generating directly from the shared protocol package.

## Docs Requirements

Hosted docs use a claims manifest for high-stakes claims.

Done criteria:

- every SDK/API/CLI/security/performance claim maps to code, tests, release state, and owner
- docs do not claim zero-dep local enforcement, full Merkle recomputation, trusted publishing, or finance-grade receipt append until evidence is landed
- receipt docs distinguish project-chain verification from org-wide archive exports

Current evidence:

- Claims manifest PR: `veto-platform/apps/docs` compliance docs changes
- Manifest: `apps/docs/content/docs/compliance/claims-manifest.mdx`
- Receipt-doc claim softening: `apps/docs/content/docs/api-reference/receipts.mdx`

## Release Requirements

Supply-chain hardening is part of the product, not polish.

Done criteria:

- npm trusted publishing or equivalent OIDC provenance
- PyPI trusted publishing/attestations or equivalent OIDC provenance
- no long-lived publish tokens in release workflow
- protected release refs
- package smoke installs
- SBOM/provenance verification notes
- no postinstall on local enforcement packages

Current gap:

- release workflow still uses long-lived `NPM_TOKEN` and `PYPI_TOKEN`.

## PR Sequence And Status

| PR  | Scope                             | Status                    | Required gates                                                          |
| --- | --------------------------------- | ------------------------- | ----------------------------------------------------------------------- |
| 1   | SDK universal receipt bridge      | Landed on `origin/master` | existing package CI                                                     |
| 2   | Platform universal receipt bridge | Landed on `origin/main`   | existing platform CI                                                    |
| 3   | Platform atomic receipt append    | In progress               | server typecheck, full backend tests, concurrency test                  |
| 4   | Docs claims manifest              | In progress               | docs build, manifest evidence review                                    |
| 5   | SDK dependency-zone gate          | In progress               | `pnpm check:dependency-zones`, CI step                                  |
| 6   | Protocol/MAP-Core fixtures        | In progress               | `pnpm --filter veto-map-core build`, `pnpm --filter veto-map-core test` |
| 7   | Rust `veto-core`                  | In progress               | Rust unit/property/fuzz/bench, TS/Python binding smoke                  |
| 8   | SDK zero-dep local wrappers       | Not started               | base package import/enforce without registry runtime deps               |
| 9   | CLI elevation                     | Not started               | `npx`, `uvx`, `pipx` init/validate/receipt e2e                          |
| 10  | Release supply-chain hardening    | Not started               | trusted publishing/provenance/package smoke                             |
| 11  | Finance demo                      | Not started               | AP/procurement/refund allow/deny/approval receipts                      |

## Verification Matrix

Before marking this spec complete, verify every row with current evidence.

| Requirement               | Evidence required                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| E2E first                 | clean `npx --package veto-cli@latest veto init`, clean `uvx/pipx veto init`, denied-call receipt smoke, restore path, offline verification |
| Cross-runtime conformance | Rust, TS, Python, and platform run the same fixtures                                                                                       |
| Platform concurrency      | parallel validations produce sequential receipts with no fork on Postgres, SQLite, Convex                                                  |
| Dependency gates          | base TS/Python dependency budgets are enforced; local kernel path has no npm/PyPI deps when implemented                                    |
| Docs claim safety         | hosted docs manifest covers every high-stakes claim                                                                                        |
| Release gates             | OIDC/trusted publishing, provenance, no postinstall, package smoke installs                                                                |
| Demo                      | AP/procurement/refund one-way-door workflow with offline-verifiable receipts                                                               |
