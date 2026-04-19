import { CompactSign, compactVerify, importJWK } from "jose";
import type {
  CapsulePayload,
  Jwks,
  JwksKey,
  VerifyCapsuleResult,
  VerifyOptions,
} from "./types.js";
import { JWS_TYP } from "./types.js";
import { canonicalize } from "./hash.js";

const DEFAULT_SKEW_SECONDS = 30;

export interface PrivateSigningKey {
  kid: string;
  jwk: JwksKey & { d: string };
}

export class CapsuleVerificationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CapsuleVerificationError";
    this.code = code;
  }
}

export async function signCapsule(
  payload: CapsulePayload,
  key: PrivateSigningKey,
): Promise<string> {
  const cryptoKey = await importJWK(key.jwk, "EdDSA");
  // JCS-canonicalize the payload so JWS bytes are byte-identical across
  // languages. Cross-language contract test depends on this.
  const body = new TextEncoder().encode(canonicalize(payload));
  return await new CompactSign(body)
    .setProtectedHeader({ alg: "EdDSA", typ: JWS_TYP, kid: key.kid })
    .sign(cryptoKey);
}

function parseProtectedHeader(jws: string): {
  alg?: unknown;
  typ?: unknown;
  kid?: unknown;
} {
  const firstDot = jws.indexOf(".");
  if (firstDot < 0) throw new CapsuleVerificationError("jws_malformed", "invalid JWS");
  const headerB64 = jws.slice(0, firstDot);
  const padded = headerB64 + "=".repeat((4 - (headerB64.length % 4)) % 4);
  const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
  const json = typeof atob === "function"
    ? atob(normalized)
    : Buffer.from(normalized, "base64").toString("utf8");
  try {
    return JSON.parse(json);
  } catch {
    throw new CapsuleVerificationError("jws_malformed", "invalid JWS header");
  }
}

function secondsBetween(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / 1000;
}

export async function verifyCapsule(
  jws: string,
  jwks: Jwks,
  options: VerifyOptions = {},
): Promise<VerifyCapsuleResult> {
  const skew = options.clockSkewSeconds ?? DEFAULT_SKEW_SECONDS;
  const now = options.now ?? new Date();

  const header = parseProtectedHeader(jws);
  if (header.alg !== "EdDSA") {
    throw new CapsuleVerificationError(
      "signature_alg_not_supported",
      `unsupported alg: ${String(header.alg)}`,
    );
  }
  if (header.typ !== JWS_TYP) {
    throw new CapsuleVerificationError(
      "signature_typ_invalid",
      `unexpected typ: ${String(header.typ)}`,
    );
  }
  if (typeof header.kid !== "string") {
    throw new CapsuleVerificationError("signature_kid_missing", "missing kid in JWS header");
  }

  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    throw new CapsuleVerificationError(
      "signature_kid_unknown",
      `no JWKS key with kid=${header.kid}`,
    );
  }

  const cryptoKey = await importJWK(jwk, "EdDSA");

  let verified;
  try {
    verified = await compactVerify(jws, cryptoKey);
  } catch {
    throw new CapsuleVerificationError(
      "signature_invalid",
      "JWS signature verification failed",
    );
  }

  let payload: CapsulePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(verified.payload));
  } catch {
    throw new CapsuleVerificationError("payload_invalid_json", "payload is not JSON");
  }

  if (payload.version !== "veto.capsule/1") {
    throw new CapsuleVerificationError(
      "capsule_version_unsupported",
      `unsupported capsule version: ${payload.version}`,
    );
  }

  const expiresAt = new Date(payload.expires_at);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new CapsuleVerificationError(
      "capsule_expires_at_invalid",
      "expires_at is not a valid date-time",
    );
  }
  const issuedAt = new Date(payload.issued_at);
  if (Number.isNaN(issuedAt.getTime())) {
    throw new CapsuleVerificationError(
      "capsule_issued_at_invalid",
      "issued_at is not a valid date-time",
    );
  }

  if (secondsBetween(now, expiresAt) > skew) {
    throw new CapsuleVerificationError(
      "capsule_expired",
      `capsule expired at ${payload.expires_at}`,
    );
  }
  if (secondsBetween(issuedAt, now) > skew) {
    throw new CapsuleVerificationError(
      "capsule_issued_in_future",
      `capsule issued_at ${payload.issued_at} is beyond tolerated skew`,
    );
  }

  return {
    payload,
    protectedHeader: {
      alg: "EdDSA",
      typ: JWS_TYP,
      kid: header.kid,
    },
  };
}

export function publicJwkFromPrivate(key: PrivateSigningKey): JwksKey {
  return {
    kty: key.jwk.kty,
    crv: key.jwk.crv,
    kid: key.kid,
    x: key.jwk.x,
    alg: "EdDSA",
    use: "sig",
  };
}
