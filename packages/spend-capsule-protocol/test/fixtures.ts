import * as ed from "@noble/ed25519";
import type { CapsulePayload, Jwks, PrivateSigningKey } from "../src/index.js";

// noble/ed25519 v2 async methods use WebCrypto internally; no hash wiring needed.

function bytesToBase64Url(bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// RFC 8032 §7.1 TEST 1 secret key — deterministic across runs.
export const TEST_PRIVATE_SEED_HEX =
  "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";

export async function buildTestSigningKey(
  kid = "veto-gateway-test",
): Promise<PrivateSigningKey> {
  const privateBytes = hexToBytes(TEST_PRIVATE_SEED_HEX);
  const publicBytes = await ed.getPublicKeyAsync(privateBytes);
  return {
    kid,
    jwk: {
      kty: "OKP",
      crv: "Ed25519",
      x: bytesToBase64Url(publicBytes),
      d: bytesToBase64Url(privateBytes),
    },
  };
}

export async function buildTestJwks(kid = "veto-gateway-test"): Promise<Jwks> {
  const key = await buildTestSigningKey(kid);
  return {
    keys: [
      {
        kty: key.jwk.kty,
        crv: key.jwk.crv,
        kid: key.kid,
        x: key.jwk.x,
        alg: "EdDSA",
        use: "sig",
      },
    ],
  };
}

export function fixedCapsule(overrides: Partial<CapsulePayload> = {}): CapsulePayload {
  return {
    version: "veto.capsule/1",
    capsule_id: "cap_01hy2z3abcdefghijklmnop1",
    issuer: "https://gateway.veto.so",
    entity_id: "ent_abc",
    agent_id: "claude-code-ci-bot",
    session_id: "sess_01hy2z3qrstuvwx",
    rail_allowlist: ["ach"],
    counterparty_hash:
      "sha256:3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855e",
    amount_ceiling: { currency: "USD", amount: "12500.00" },
    memo_template: "Invoice {{invoice_number}}",
    invoice_hash:
      "sha256:84a0c6f1a1f8b80ec5d3abaf22b9c9e0000000000000000000000000000000ff",
    workflow_id: "wf_01hy2z3abcdefghijklmnop1",
    policy_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    approval_ref: null,
    dual_control_ref: null,
    issued_at: "2026-04-17T14:00:00Z",
    expires_at: "2026-04-17T14:15:00Z",
    max_uses: 1,
    nonce: "7f3d9b2e1c8a4f60",
    ...overrides,
  };
}

export const REFERENCE_NOW = new Date("2026-04-17T14:05:00Z");
