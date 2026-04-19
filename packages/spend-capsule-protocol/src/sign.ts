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
import { ValidationError, validateCapsulePayload } from "./validate.js";

const DEFAULT_SKEW_SECONDS = 30;

export interface PrivateSigningKey {
  kid: string;
  jwk: JwksKey & { d: string };
}

export type CapsuleErrorCode =
  | "jws_malformed"
  | "signature_alg_not_supported"
  | "signature_typ_invalid"
  | "signature_kid_missing"
  | "signature_kid_unknown"
  | "signature_invalid"
  | "jwks_key_invalid"
  | "payload_invalid_json"
  | "payload_not_canonical"
  | "capsule_payload_invalid"
  | "capsule_version_unsupported"
  | "capsule_expires_at_invalid"
  | "capsule_issued_at_invalid"
  | "capsule_expired"
  | "capsule_issued_in_future";

export class CapsuleVerificationError extends Error {
  readonly code: CapsuleErrorCode;
  constructor(code: CapsuleErrorCode, message: string) {
    super(message);
    this.name = "CapsuleVerificationError";
    this.code = code;
  }
}

export async function signCapsule(
  payload: CapsulePayload,
  key: PrivateSigningKey,
): Promise<string> {
  // Refuse to sign anything that wouldn't verify. This catches bugs on the
  // issuing side before bad capsules hit the wire.
  validateCapsulePayload(payload);

  const cryptoKey = await importJWK(key.jwk, "EdDSA");
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
  if (firstDot < 0) {
    throw new CapsuleVerificationError("jws_malformed", "JWS has no header segment");
  }
  const headerB64 = jws.slice(0, firstDot);
  let json: string;
  try {
    const padded = headerB64 + "=".repeat((4 - (headerB64.length % 4)) % 4);
    const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
    json =
      typeof atob === "function"
        ? atob(normalized)
        : Buffer.from(normalized, "base64").toString("utf8");
  } catch {
    throw new CapsuleVerificationError(
      "jws_malformed",
      "JWS header is not valid base64url",
    );
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new CapsuleVerificationError("jws_malformed", "JWS header is not valid JSON");
  }
}

function decodeBase64Url(s: string): Uint8Array {
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  const normalized = padded.replace(/-/g, "+").replace(/_/g, "/");
  try {
    if (typeof atob === "function") {
      const bin = atob(normalized);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(normalized, "base64"));
  } catch {
    throw new CapsuleVerificationError("jws_malformed", "invalid base64url segment");
  }
}

function parseRfc3339(value: string, code: CapsuleErrorCode): Date {
  // Reject naive datetimes without explicit UTC or ±HH:MM offset.
  // `new Date("2026-04-17T14:00:00")` silently interprets as LOCAL time,
  // which differs between hosts and has caused real drift bugs.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new CapsuleVerificationError(
      code,
      `timestamp must be RFC 3339 with explicit offset; got "${value}"`,
    );
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new CapsuleVerificationError(code, `invalid datetime: "${value}"`);
  }
  return d;
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

  const parts = jws.split(".");
  if (parts.length !== 3) {
    throw new CapsuleVerificationError(
      "jws_malformed",
      `JWS must have exactly 3 segments, got ${parts.length}`,
    );
  }
  const [headerB64, payloadB64] = parts;
  if (!headerB64 || !payloadB64) {
    throw new CapsuleVerificationError("jws_malformed", "JWS has empty segments");
  }

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
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
    throw new CapsuleVerificationError(
      "jwks_key_invalid",
      `JWKS key for kid=${header.kid} must be OKP/Ed25519`,
    );
  }

  let cryptoKey: Awaited<ReturnType<typeof importJWK>>;
  try {
    cryptoKey = await importJWK(jwk, "EdDSA");
  } catch (err) {
    throw new CapsuleVerificationError(
      "jwks_key_invalid",
      `JWKS key import failed: ${(err as Error).message}`,
    );
  }

  let verified: { payload: Uint8Array };
  try {
    verified = await compactVerify(jws, cryptoKey);
  } catch {
    throw new CapsuleVerificationError(
      "signature_invalid",
      "JWS signature verification failed",
    );
  }

  // Canonical-form enforcement. The signer commits to JCS-canonicalized bytes;
  // the verifier MUST reject a valid-signature-over-non-canonical payload so
  // there is exactly one wire encoding per semantic capsule.
  const expectedCanonical = canonicalize(
    JSON.parse(new TextDecoder().decode(verified.payload)),
  );
  const signedCanonical = new TextDecoder().decode(verified.payload);
  if (expectedCanonical !== signedCanonical) {
    throw new CapsuleVerificationError(
      "payload_not_canonical",
      "capsule payload is valid JSON but not JCS-canonical",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(verified.payload));
  } catch {
    throw new CapsuleVerificationError("payload_invalid_json", "payload is not JSON");
  }

  let payload: CapsulePayload;
  try {
    payload = validateCapsulePayload(parsed);
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new CapsuleVerificationError(
        "capsule_payload_invalid",
        `capsule failed schema validation: ${err.message}`,
      );
    }
    throw err;
  }

  if (payload.version !== "veto.capsule/1") {
    throw new CapsuleVerificationError(
      "capsule_version_unsupported",
      `unsupported capsule version: ${payload.version}`,
    );
  }

  const expiresAt = parseRfc3339(payload.expires_at, "capsule_expires_at_invalid");
  const issuedAt = parseRfc3339(payload.issued_at, "capsule_issued_at_invalid");

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

  // Decode sig segment just to confirm it's well-formed base64url — already
  // consumed by compactVerify but we expose a clear error if the caller
  // hand-crafted something malformed.
  decodeBase64Url(parts[2]!);

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
