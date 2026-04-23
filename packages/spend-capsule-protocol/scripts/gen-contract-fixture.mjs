// Generates cross-language contract fixtures.
// Run: node scripts/gen-contract-fixture.mjs > ../sdk-python/tests/fixtures/contract-capsule.json
import { signCapsule, publicJwkFromPrivate, hashBeneficiary } from "../dist/index.js";
import * as ed from "@noble/ed25519";

function bytesToBase64Url(bytes) {
  const b64 = Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const SEED_HEX = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const privateBytes = hexToBytes(SEED_HEX);
const publicBytes = await ed.getPublicKeyAsync(privateBytes);

const privateKey = {
  kid: "veto-gateway-test",
  jwk: {
    kty: "OKP",
    crv: "Ed25519",
    x: bytesToBase64Url(publicBytes),
    d: bytesToBase64Url(privateBytes),
  },
};

const capsule = {
  version: "veto.capsule/1",
  capsule_id: "cap_01hy2z3abcdefghijklmnop1",
  issuer: "https://gateway.veto.so",
  entity_id: "ent_abc",
  agent_id: "claude-code-ci-bot",
  session_id: "sess_01hy2z3qrstuvwx",
  tool: "meow.pay",
  rail_allowlist: ["ach"],
  counterparty_hash: hashBeneficiary({
    type: "bank_us",
    name: "Acme Supplies LLC",
    routing: "121000248",
    account_last4: "4821",
  }),
  amount_ceiling: { currency: "USD", amount: "12500.00" },
  memo_template: "Invoice {{invoice_number}}",
  invoice_hash: "sha256:84a0c6f1a1f8b80ec5d3abaf22b9c9e0000000000000000000000000000000ff",
  workflow_id: "wf_01hy2z3abcdefghijklmnop1",
  policy_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  approval_ref: null,
  dual_control_ref: null,
  issued_at: "2026-04-17T14:00:00Z",
  expires_at: "2026-04-17T14:15:00Z",
  max_uses: 1,
  nonce: "7f3d9b2e1c8a4f60",
};

const jws = await signCapsule(capsule, privateKey);
// AuthorizedJwks shape — production-safety default requires issuer binding.
const jwks = {
  keys: [publicJwkFromPrivate(privateKey)],
  authorizations: [
    { kid: privateKey.kid, issuer: "https://gateway.veto.so" },
  ],
};

console.log(
  JSON.stringify(
    {
      description:
        "Cross-language contract fixture. Produced by the TS reference impl; consumed by the Python mirror's test_capsule_contract.py.",
      seed_hex: SEED_HEX,
      kid: privateKey.kid,
      jwks,
      payload: capsule,
      jws,
      now_for_verify: "2026-04-17T14:05:00Z",
    },
    null,
    2,
  ),
);
