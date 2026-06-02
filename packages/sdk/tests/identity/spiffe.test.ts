import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AgentIdentityVerificationError,
  verifyAgentJWT,
  type JsonWebKey,
  type TrustBundle,
} from '../../src/identity/spiffe.js';

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function createSignedJwt(overrides: Record<string, unknown> = {}): {
  token: string;
  trustBundle: TrustBundle;
} {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  jwk.kid = 'spiffe-test-key';
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = base64UrlJson({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' });
  const encodedPayload = base64UrlJson({
    iss: 'https://issuer.example.test',
    sub: 'spiffe://example.test/agent/caleb',
    aud: ['veto-sdk'],
    iat: now,
    exp: now + 300,
    ...overrides,
  });
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const encodedSignature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');

  return {
    token: `${signingInput}.${encodedSignature}`,
    trustBundle: {
      jwks: { keys: [jwk] },
      issuer: 'https://issuer.example.test',
      audience: 'veto-sdk',
      trustDomain: 'example.test',
    },
  };
}

describe('verifyAgentJWT', () => {
  it('returns a verified SPIFFE agent identity for a valid JWT-SVID', () => {
    const { token, trustBundle } = createSignedJwt();

    const identity = verifyAgentJWT(token, trustBundle);

    expect(identity.spiffeId).toBe('spiffe://example.test/agent/caleb');
    expect(identity.trustDomain).toBe('example.test');
    expect(identity.path).toBe('/agent/caleb');
    expect(identity.audience).toEqual(['veto-sdk']);
  });

  it('rejects JWTs outside the configured trust domain', () => {
    const { token, trustBundle } = createSignedJwt({
      sub: 'spiffe://other.example.test/agent/caleb',
    });

    expect(() => verifyAgentJWT(token, trustBundle)).toThrow(AgentIdentityVerificationError);
  });

  it('falls back to default skew when configured skew is not finite', () => {
    const now = Math.floor(Date.now() / 1000);
    const { token, trustBundle } = createSignedJwt({
      exp: now - 120,
    });

    expect(() => verifyAgentJWT(token, {
      ...trustBundle,
      clockSkewSeconds: Number.POSITIVE_INFINITY,
    })).toThrow('SPIFFE JWT-SVID has expired');
  });
});
