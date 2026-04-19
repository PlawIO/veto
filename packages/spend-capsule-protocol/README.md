# @veto/spend-capsule-protocol

Delegated-authority protocol for agentic money movement. Signed, short-lived, single-use authority objects plus a tamper-evident decision-receipt chain.

> Any auditor can verify our log without trusting us.

## Install

```bash
pnpm add @veto/spend-capsule-protocol
```

## What's in here

- `signCapsule(payload, privateKey)` — Ed25519 JWS (`alg: EdDSA`, `typ: veto.capsule+jws`)
- `verifyCapsule(jws, jwks, opts?)` — signature + expiry + skew (≤30s default) verification
- `hashBeneficiary(b)` — JCS-canonical SHA-256 of a normalized beneficiary
- `buildReceipt({ draft, prev, merkleRoot? })` — append one decision receipt to a per-entity chain
- `verifyReceiptChain(receipts)` — hash-continuity check, no keys required
- `computeMerkleRoot(leaves)` — standard binary merkle tree
- `anchorBlock(...)` — rolling O(log N) merkle anchor for 1024-receipt blocks

All hashing uses **JCS (RFC 8785)** via the `canonicalize` npm package. All signatures use **Ed25519** via `@noble/ed25519` and **JWS compact serialization** via `jose`.

## Usage

### Sign and verify a capsule

```ts
import {
  signCapsule,
  verifyCapsule,
  hashBeneficiary,
  publicJwkFromPrivate,
} from "@veto/spend-capsule-protocol";

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
  capsule_id: "cap_01hy2z3abcdefghijklmnop",
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
    "sha256:84a0c6f1a1f8b80ec5d3abaf22b9c9e0000000000000000000000000000000000",
  workflow_id: "wf_01hy2z3abcdefghijklmnop",
  policy_sha256:
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  issued_at: "2026-04-17T14:00:00Z",
  expires_at: "2026-04-17T14:15:00Z",
  nonce: "7f3d9b2e1c8a4f60",
};

const jws = await signCapsule(capsule, privateKey);

const jwks = { keys: [publicJwkFromPrivate(privateKey)] };
const { payload } = await verifyCapsule(jws, jwks);
```

### Build and verify a receipt chain

```ts
import {
  buildReceipt,
  verifyReceiptChain,
  hashReceipt,
  computeMerkleRoot,
} from "@veto/spend-capsule-protocol";

const r1 = buildReceipt({
  draft: {
    receipt_id: "rcp_01hy...0001",
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

## License

Apache-2.0.
