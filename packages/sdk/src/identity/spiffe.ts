import { constants, createPublicKey, type KeyObject, verify } from 'node:crypto';

export interface JsonWebKey {
  kty?: string;
  kid?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
  x5c?: string[];
  [key: string]: unknown;
}

export interface JsonWebKeySet {
  keys: JsonWebKey[];
}

export interface TrustBundle {
  jwks: JsonWebKeySet;
  issuer?: string;
  audience?: string | string[];
  trustDomain?: string;
  trust_domain?: string;
  allowedSpiffeIds?: string[];
  allowed_spiffe_ids?: string[];
  clockSkewSeconds?: number;
}

export interface IdentityPolicyConfig {
  require_signed?: boolean;
  trustBundle?: TrustBundle;
  trust_bundle?: TrustBundle;
  jwks?: JsonWebKeySet;
  issuer?: string;
  audience?: string | string[];
  trustDomain?: string;
  trust_domain?: string;
  allowedSpiffeIds?: string[];
  allowed_spiffe_ids?: string[];
  clockSkewSeconds?: number;
}

export interface AgentIdentity {
  spiffeId: string;
  trustDomain: string;
  path: string;
  subject: string;
  issuer?: string;
  audience: string[];
  issuedAt?: Date;
  expiresAt: Date;
  claims: Record<string, unknown>;
}

export class AgentIdentityVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentIdentityVerificationError';
  }
}

const SUPPORTED_ALGORITHMS = new Set([
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
]);

const DEFAULT_CLOCK_SKEW_SECONDS = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function base64UrlDecode(segment: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) {
    throw new AgentIdentityVerificationError(`Invalid JWT ${label} encoding`);
  }

  const paddingLength = (4 - (segment.length % 4)) % 4;
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(paddingLength);
  return Buffer.from(padded, 'base64');
}

function decodeJsonSegment(segment: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(segment, label).toString('utf-8'));
  } catch (error) {
    throw new AgentIdentityVerificationError(
      `Invalid JWT ${label}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (!isRecord(parsed)) {
    throw new AgentIdentityVerificationError(`Invalid JWT ${label}: expected JSON object`);
  }

  return parsed;
}

function getStringClaim(payload: Record<string, unknown>, claim: string): string | undefined {
  const value = payload[claim];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function getNumberClaim(payload: Record<string, unknown>, claim: string): number | undefined {
  const value = payload[claim];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getAudiences(payload: Record<string, unknown>): string[] {
  const audience = payload.aud;
  if (typeof audience === 'string' && audience.trim().length > 0) {
    return [audience];
  }

  if (Array.isArray(audience)) {
    const audiences = audience.filter((value): value is string =>
      typeof value === 'string' && value.trim().length > 0
    );
    if (audiences.length === audience.length && audiences.length > 0) {
      return audiences;
    }
  }

  throw new AgentIdentityVerificationError('SPIFFE JWT-SVID must include a non-empty audience');
}

function toArray(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function getTrustDomain(trustBundle: TrustBundle): string | undefined {
  return trustBundle.trustDomain ?? trustBundle.trust_domain;
}

function getAllowedSpiffeIds(trustBundle: TrustBundle): string[] {
  return trustBundle.allowedSpiffeIds ?? trustBundle.allowed_spiffe_ids ?? [];
}

function parseSpiffeId(spiffeId: string): { trustDomain: string; path: string } {
  let url: URL;
  try {
    url = new URL(spiffeId);
  } catch {
    throw new AgentIdentityVerificationError('JWT subject must be a valid SPIFFE ID');
  }

  if (
    url.protocol !== 'spiffe:'
    || url.hostname.length === 0
    || url.username.length > 0
    || url.password.length > 0
    || url.port.length > 0
    || url.search.length > 0
    || url.hash.length > 0
    || url.pathname.length <= 1
  ) {
    throw new AgentIdentityVerificationError('JWT subject must use SPIFFE ID format spiffe://trust-domain/path');
  }

  return {
    trustDomain: url.hostname,
    path: url.pathname,
  };
}

function hashAlgorithmForJwtAlg(alg: string): string | null {
  switch (alg) {
    case 'RS256':
    case 'PS256':
      return 'RSA-SHA256';
    case 'RS384':
    case 'PS384':
      return 'RSA-SHA384';
    case 'RS512':
    case 'PS512':
      return 'RSA-SHA512';
    case 'ES256':
      return 'SHA256';
    case 'ES384':
      return 'SHA384';
    case 'ES512':
      return 'SHA512';
    case 'EdDSA':
      return null;
    default:
      throw new AgentIdentityVerificationError(`Unsupported JWT alg "${alg}"`);
  }
}

function keyMatchesAlgorithm(jwk: JsonWebKey, alg: string): boolean {
  if (jwk.alg !== undefined && jwk.alg !== alg) {
    return false;
  }
  if (jwk.use !== undefined && jwk.use !== 'sig') {
    return false;
  }
  if (Array.isArray(jwk.key_ops) && jwk.key_ops.length > 0 && !jwk.key_ops.includes('verify')) {
    return false;
  }
  if ((alg.startsWith('RS') || alg.startsWith('PS')) && jwk.kty !== 'RSA') {
    return false;
  }
  if (alg.startsWith('ES') && jwk.kty !== 'EC') {
    return false;
  }
  if (alg === 'EdDSA' && jwk.kty !== 'OKP') {
    return false;
  }
  return true;
}

function createPublicKeyFromJwk(jwk: JsonWebKey): KeyObject {
  const certChain = jwk.x5c;
  if (Array.isArray(certChain) && typeof certChain[0] === 'string') {
    const cert = certChain[0].match(/.{1,64}/g)?.join('\n') ?? certChain[0];
    return createPublicKey(`-----BEGIN CERTIFICATE-----\n${cert}\n-----END CERTIFICATE-----`);
  }

  return createPublicKey({ key: jwk, format: 'jwk' } as never);
}

function verifyJwtSignature(
  signingInput: string,
  signature: Buffer,
  alg: string,
  jwk: JsonWebKey
): boolean {
  const publicKey = createPublicKeyFromJwk(jwk);
  const hashAlgorithm = hashAlgorithmForJwtAlg(alg);

  if (alg.startsWith('PS')) {
    return verify(
      hashAlgorithm,
      Buffer.from(signingInput),
      {
        key: publicKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
      },
      signature
    );
  }

  if (alg.startsWith('ES')) {
    return verify(
      hashAlgorithm,
      Buffer.from(signingInput),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      signature
    );
  }

  return verify(hashAlgorithm, Buffer.from(signingInput), publicKey, signature);
}

function validateJwtTiming(payload: Record<string, unknown>, trustBundle: TrustBundle): {
  issuedAt?: Date;
  expiresAt: Date;
} {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const clockSkewSeconds = Math.max(0, trustBundle.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS);
  const exp = getNumberClaim(payload, 'exp');
  const iat = getNumberClaim(payload, 'iat');
  const nbf = getNumberClaim(payload, 'nbf');

  if (exp === undefined) {
    throw new AgentIdentityVerificationError('SPIFFE JWT-SVID must include exp');
  }
  if (nowSeconds > exp + clockSkewSeconds) {
    throw new AgentIdentityVerificationError('SPIFFE JWT-SVID has expired');
  }
  if (nbf !== undefined && nowSeconds + clockSkewSeconds < nbf) {
    throw new AgentIdentityVerificationError('SPIFFE JWT-SVID is not yet valid');
  }
  if (iat !== undefined && iat > nowSeconds + clockSkewSeconds) {
    throw new AgentIdentityVerificationError('SPIFFE JWT-SVID issued-at time is in the future');
  }

  return {
    issuedAt: iat === undefined ? undefined : new Date(iat * 1000),
    expiresAt: new Date(exp * 1000),
  };
}

function validateJwtClaims(
  payload: Record<string, unknown>,
  trustBundle: TrustBundle
): Omit<AgentIdentity, 'claims'> {
  const subject = getStringClaim(payload, 'sub');
  if (!subject) {
    throw new AgentIdentityVerificationError('SPIFFE JWT-SVID must include sub');
  }

  const parsedSpiffeId = parseSpiffeId(subject);
  const expectedTrustDomain = getTrustDomain(trustBundle);
  if (expectedTrustDomain !== undefined && parsedSpiffeId.trustDomain !== expectedTrustDomain) {
    throw new AgentIdentityVerificationError('SPIFFE JWT-SVID trust domain is not trusted');
  }

  const allowedSpiffeIds = getAllowedSpiffeIds(trustBundle);
  if (allowedSpiffeIds.length > 0 && !allowedSpiffeIds.includes(subject)) {
    throw new AgentIdentityVerificationError('SPIFFE JWT-SVID subject is not allowed');
  }

  const issuer = getStringClaim(payload, 'iss');
  if (trustBundle.issuer !== undefined && issuer !== trustBundle.issuer) {
    throw new AgentIdentityVerificationError('SPIFFE JWT-SVID issuer is not trusted');
  }

  const audiences = getAudiences(payload);
  const expectedAudiences = toArray(trustBundle.audience);
  if (expectedAudiences.length > 0 && !audiences.some((audience) => expectedAudiences.includes(audience))) {
    throw new AgentIdentityVerificationError('SPIFFE JWT-SVID audience is not accepted');
  }

  const timing = validateJwtTiming(payload, trustBundle);

  return {
    spiffeId: subject,
    trustDomain: parsedSpiffeId.trustDomain,
    path: parsedSpiffeId.path,
    subject,
    issuer,
    audience: audiences,
    ...timing,
  };
}

export function verifyAgentJWT(token: string, trustBundle: TrustBundle): AgentIdentity {
  const jwt = token.trim();
  const parts = jwt.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new AgentIdentityVerificationError('Invalid JWT-SVID structure');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJsonSegment(encodedHeader, 'header');
  const payload = decodeJsonSegment(encodedPayload, 'payload');
  const alg = getStringClaim(header, 'alg');

  if (!alg || alg === 'none' || !SUPPORTED_ALGORITHMS.has(alg)) {
    throw new AgentIdentityVerificationError('JWT-SVID uses an unsupported signature algorithm');
  }

  if (!trustBundle.jwks || !Array.isArray(trustBundle.jwks.keys) || trustBundle.jwks.keys.length === 0) {
    throw new AgentIdentityVerificationError('Trust bundle JWKS must contain at least one key');
  }

  const kid = getStringClaim(header, 'kid');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = base64UrlDecode(encodedSignature, 'signature');
  const candidateKeys = trustBundle.jwks.keys.filter((key) =>
    (kid === undefined || key.kid === kid) && keyMatchesAlgorithm(key, alg)
  );

  if (candidateKeys.length === 0) {
    throw new AgentIdentityVerificationError('No trusted JWKS key matches JWT-SVID header');
  }

  const signatureValid = candidateKeys.some((key) => {
    try {
      return verifyJwtSignature(signingInput, signature, alg, key);
    } catch {
      return false;
    }
  });

  if (!signatureValid) {
    throw new AgentIdentityVerificationError('JWT-SVID signature verification failed');
  }

  const identity = validateJwtClaims(payload, trustBundle);

  return {
    ...identity,
    claims: payload,
  };
}
