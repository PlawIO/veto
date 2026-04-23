# veto-spend-capsule-protocol

Delegated-authority protocol for agentic money movement. Signed, short-lived, single-use authority objects plus a tamper-evident decision-receipt chain.

> Any auditor can verify our log without trusting us.

## Install

```bash
pnpm add veto-spend-capsule-protocol
```

## What's in here

- `signCapsule(payload, privateKey)` — Ed25519 JWS (`alg: EdDSA`, `typ: veto.capsule+jws`)
- `verifyCapsule(jws, trust, opts?)` — signature + expiry + skew + issuer/entity authorization
- `hashBeneficiary(b)` — JCS-canonical SHA-256 of a normalized beneficiary
- `buildReceipt({ draft, prev, merkleRoot? })` — append one decision receipt to a per-entity chain
- `verifyReceiptChain(receipts)` — structural validation + hash-continuity + monotonic timestamps + merkle progression
- `computeMerkleRoot(leaves)` — domain-separated merkle tree with leaf count bound into the root
- `anchorBlock(...)` — rolling O(log N) merkle anchor for 1024-receipt blocks
- `jwkThumbprint(jwk)` — RFC 7638 JWK thumbprint for deriving stable kids

All hashing uses **JCS (RFC 8785)** via the `canonicalize` npm package. All signatures use **Ed25519** via `@noble/ed25519` and **JWS compact serialization** via `jose`.

## What this package does NOT do

- **Replay prevention.** `nonce` and `max_uses` are signed fields, but the protocol does not itself track consumption. Any production gateway MUST:
  - Reject a capsule whose `nonce` has already been observed for this `entity_id`.
  - Track per-capsule consumption counts and refuse once `max_uses` is reached.
  - Use a durable, low-latency store (Redis + mirror, Convex mutation, etc.).
    The reference gateway at `veto-platform/apps/meow-gateway` implements this.
- **Key rotation.** You rotate JWKS out-of-band and publish overlap windows.

## Trust anchors

`verifyCapsule` accepts three input shapes, but only two are safe for production:

1. **`AuthorizedJwks`** — pairs each `kid` with an `issuer` (and optional `entity_ids` allowlist). **Use this.**
2. **`TrustAnchor { jwks, requireIssuerBinding? }`** — wrap an `AuthorizedJwks` (binding enforced) when you want to be explicit, or pass a plain `Jwks` with `requireIssuerBinding: false` for the dev-only legacy path.
3. **Plain `Jwks`** — `{ keys: [...] }`. **Rejected by default.** A plain JWKS has no issuer binding, so any trusted key could sign a capsule for any issuer — a production risk we now block. You will see `CapsuleVerificationError({ code: "signature_kid_unknown" })` until you migrate to `AuthorizedJwks` or explicitly opt out via `TrustAnchor { jwks, requireIssuerBinding: false }`.

```ts
import {
  verifyCapsule,
  type AuthorizedJwks,
} from "veto-spend-capsule-protocol";

const trust: AuthorizedJwks = {
  keys: [
    /* ... */
  ],
  authorizations: [
    {
      kid: "veto-gateway-2026q2",
      issuer: "https://gateway.veto.so",
      entity_ids: ["ent_abc", "ent_xyz"], // optional
    },
  ],
};
await verifyCapsule(jws, trust);
```

## Usage

### Sign and verify a capsule

```ts
import {
  signCapsule,
  verifyCapsule,
  hashBeneficiary,
  publicJwkFromPrivate,
  type AuthorizedJwks,
} from "veto-spend-capsule-protocol";

const privateKey = {
  kid: "veto-gateway-2026q2",
  jwk: {
    kty: "OKP",
    crv: "Ed25519",
    x: "…", // public
    d: "…", // private
  },
};

const capsule = {
  version: "veto.capsule/1" as const,
  capsule_id: "cap_01hy2z3abcdefghijklmnop1",
  issuer: "https://gateway.veto.so",
  entity_id: "ent_abc",
  agent_id: "claude-code-ci-bot",
  rail_allowlist: ["ach" as const],
  counterparty_hash: hashBeneficiary({
    type: "bank_us",
    name: "Acme Supplies LLC",
    routing: "121000248",
    account_last4: "4821",
  }),
  amount_ceiling: { currency: "USD", amount: "12500.00" },
  invoice_hash:
    "sha256:84a0c6f1a1f8b80ec5d3abaf22b9c9e0000000000000000000000000000000ff",
  workflow_id: "wf_01hy2z3abcdefghijklmnop1",
  policy_sha256:
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  issued_at: "2026-04-17T14:00:00Z",
  expires_at: "2026-04-17T14:15:00Z",
  nonce: "7f3d9b2e1c8a4f60",
};

const jws = await signCapsule(capsule, privateKey);

const trust: AuthorizedJwks = {
  keys: [publicJwkFromPrivate(privateKey)],
  authorizations: [{ kid: privateKey.kid, issuer: "https://gateway.veto.so" }],
};
const { payload } = await verifyCapsule(jws, trust);
```

### Build and verify a receipt chain

```ts
import { buildReceipt, verifyReceiptChain } from "veto-spend-capsule-protocol";

const r1 = buildReceipt({
  draft: {
    receipt_id: "rcp_01hy2z3abcdefghijklmno1",
    entity_id: "ent_abc",
    agent_id: "bot",
    tool: "meow.pay",
    decision: "allow",
    args_hash: "sha256:…",
    result_hash: "sha256:…",
    policy_hash: "…",
    issued_at: "2026-04-17T14:03:00Z",
  },
  prev: null, // genesis
});

const r2 = buildReceipt({
  draft: {
    /* ... */
  },
  prev: r1,
});

const result = verifyReceiptChain([r1, r2]);
// → { ok: true }
```

## Wire-format guarantees

Byte-for-byte identical output is produced across the TypeScript (`veto-spend-capsule-protocol`) and Python (`veto.capsule`) reference implementations, for the same input. The test fixture at `test/fixtures/contract-capsule.json` locks this parity. CI regenerates it on every PR — a drift fails the build.

Timestamps are validated by a hand-rolled strict RFC 3339 parser. Cross-language drift vectors that previously passed (e.g., `2026-02-31` via `new Date()`, `+00:60` normalization, 7-digit fractional seconds) are now rejected before signing and on verification.

## License

Apache-2.0.
