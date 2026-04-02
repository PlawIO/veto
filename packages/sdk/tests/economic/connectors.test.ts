import { describe, it, expect } from 'vitest';
import { createX402Connector, buildX402ConnectorError } from '../../src/economic/connectors/x402.js';
import { createMPPConnector, buildMPPConnectorError } from '../../src/economic/connectors/mpp.js';
import { createAP2Connector, buildAP2ConnectorError } from '../../src/economic/connectors/ap2.js';

describe('x402 Connector', () => {
  const connector = createX402Connector();

  it('should have correct protocol metadata', () => {
    expect(connector.protocol).toBe('x402');
    expect(connector.protocolVersion).toBe('2.0');
  });

  describe('extract (plain object)', () => {
    it('should extract from valid 402 response with X-Payment header', () => {
      const response = {
        status: 402,
        headers: {
          'x-payment': 'price=0.01;token=USDC;chain=base;recipient=0xabc123',
        },
      };
      const ctx = connector.extract(response);
      expect(ctx).not.toBeNull();
      expect(ctx!.cost).toBe(0.01);
      expect(ctx!.currency).toBe('USD');
      expect(ctx!.protocol).toBe('x402');
      expect(ctx!.protocol_metadata?.token).toBe('USDC');
      expect(ctx!.protocol_metadata?.chain).toBe('base');
      expect(ctx!.protocol_metadata?.recipient).toBe('0xabc123');
    });

    it('should return null for non-402 status', () => {
      const response = { status: 200, headers: {} };
      expect(connector.extract(response)).toBeNull();
    });

    it('should return null for 402 without X-Payment header', () => {
      const response = { status: 402, headers: {} };
      expect(connector.extract(response)).toBeNull();
    });

    it('should return null for malformed X-Payment header (missing fields)', () => {
      const response = {
        status: 402,
        headers: { 'x-payment': 'price=0.01;token=USDC' },
      };
      expect(connector.extract(response)).toBeNull();
    });

    it('should return null for non-stablecoin token', () => {
      const response = {
        status: 402,
        headers: {
          'x-payment': 'price=0.5;token=ETH;chain=ethereum;recipient=0xabc',
        },
      };
      expect(connector.extract(response)).toBeNull();
    });

    it('should handle USDT stablecoin', () => {
      const response = {
        status: 402,
        headers: {
          'x-payment': 'price=5.00;token=USDT;chain=base;recipient=0xabc',
        },
      };
      const ctx = connector.extract(response);
      expect(ctx).not.toBeNull();
      expect(ctx!.cost).toBe(5.00);
    });

    it('should return null for negative price', () => {
      const response = {
        status: 402,
        headers: {
          'x-payment': 'price=-1;token=USDC;chain=base;recipient=0xabc',
        },
      };
      expect(connector.extract(response)).toBeNull();
    });

    it('should return null for non-numeric price', () => {
      const response = {
        status: 402,
        headers: {
          'x-payment': 'price=abc;token=USDC;chain=base;recipient=0xabc',
        },
      };
      expect(connector.extract(response)).toBeNull();
    });

    it('should handle zero price', () => {
      const response = {
        status: 402,
        headers: {
          'x-payment': 'price=0;token=USDC;chain=base;recipient=0xabc',
        },
      };
      const ctx = connector.extract(response);
      expect(ctx).not.toBeNull();
      expect(ctx!.cost).toBe(0);
    });

    it('should support case-insensitive X-Payment header key', () => {
      const response = {
        status: 402,
        headers: {
          'X-Payment': 'price=1.00;token=USDC;chain=base;recipient=0xabc',
        },
      };
      const ctx = connector.extract(response);
      expect(ctx).not.toBeNull();
    });
  });

  describe('extract (Response object)', () => {
    it('should extract from 402 Response with x-payment header', () => {
      const res = new Response(null, {
        status: 402,
        headers: { 'x-payment': 'price=0.01;token=USDC;chain=base;recipient=0xabc123' },
      });
      const ctx = connector.extract(res);
      expect(ctx).not.toBeNull();
      expect(ctx!.cost).toBe(0.01);
      expect(ctx!.currency).toBe('USD');
      expect(ctx!.protocol).toBe('x402');
      expect(ctx!.protocol_metadata?.token).toBe('USDC');
      expect(ctx!.protocol_metadata?.chain).toBe('base');
      expect(ctx!.protocol_metadata?.recipient).toBe('0xabc123');
    });

    it('should return null for non-402 Response', () => {
      const res = new Response(null, { status: 200 });
      expect(connector.extract(res)).toBeNull();
    });

    it('should return null for 402 Response without x-payment header', () => {
      const res = new Response(null, { status: 402 });
      expect(connector.extract(res)).toBeNull();
    });

    it('should return null for 402 Response with malformed x-payment header', () => {
      const res = new Response(null, {
        status: 402,
        headers: { 'x-payment': 'price=0.01;token=USDC' },
      });
      expect(connector.extract(res)).toBeNull();
    });

    it('should return null for 402 Response with non-stablecoin token', () => {
      const res = new Response(null, {
        status: 402,
        headers: { 'x-payment': 'price=0.5;token=ETH;chain=ethereum;recipient=0xabc' },
      });
      expect(connector.extract(res)).toBeNull();
    });
  });

  describe('wrapFetch', () => {
    it('should intercept 402 with X-Payment and attach __vetoEconomicContext', async () => {
      const mockFetch = async () =>
        new Response(null, {
          status: 402,
          headers: { 'x-payment': 'price=0.05;token=USDC;chain=base;recipient=0xdef456' },
        });

      const wrapped = connector.wrapFetch!(mockFetch as typeof fetch);
      const res = await wrapped('https://example.com');
      const augmented = res as Response & { __vetoEconomicContext?: unknown };

      expect(augmented.__vetoEconomicContext).toBeDefined();
      expect((augmented.__vetoEconomicContext as any).cost).toBe(0.05);
      expect((augmented.__vetoEconomicContext as any).protocol).toBe('x402');
      expect((augmented.__vetoEconomicContext as any).protocol_metadata?.token).toBe('USDC');
      expect((augmented.__vetoEconomicContext as any).protocol_metadata?.recipient).toBe('0xdef456');
    });

    it('should pass through non-402 responses without __vetoEconomicContext', async () => {
      const mockFetch = async () => new Response('ok', { status: 200 });

      const wrapped = connector.wrapFetch!(mockFetch as typeof fetch);
      const res = await wrapped('https://example.com');
      const augmented = res as Response & { __vetoEconomicContext?: unknown };

      expect(res.status).toBe(200);
      expect(augmented.__vetoEconomicContext).toBeUndefined();
    });

    it('should pass through 402 without X-Payment header (no __vetoEconomicContext)', async () => {
      const mockFetch = async () => new Response(null, { status: 402 });

      const wrapped = connector.wrapFetch!(mockFetch as typeof fetch);
      const res = await wrapped('https://example.com');
      const augmented = res as Response & { __vetoEconomicContext?: unknown };

      expect(res.status).toBe(402);
      expect(augmented.__vetoEconomicContext).toBeUndefined();
    });

    it('should pass through 402 with malformed X-Payment (no __vetoEconomicContext)', async () => {
      const mockFetch = async () =>
        new Response(null, {
          status: 402,
          headers: { 'x-payment': 'price=0.01;token=USDC' },
        });

      const wrapped = connector.wrapFetch!(mockFetch as typeof fetch);
      const res = await wrapped('https://example.com');
      const augmented = res as Response & { __vetoEconomicContext?: unknown };

      expect(res.status).toBe(402);
      expect(augmented.__vetoEconomicContext).toBeUndefined();
    });
  });
});

describe('MPP Connector', () => {
  const connector = createMPPConnector();

  it('should have correct protocol metadata', () => {
    expect(connector.protocol).toBe('mpp');
    expect(connector.protocolVersion).toBe('2026.03');
  });

  describe('extract (plain object)', () => {
    it('should extract from valid MPP session data', () => {
      const response = {
        session_token: 'spt_abc123',
        cost: 2.50,
        currency: 'USD',
        spending_limit: 100,
        spent: 25,
        payer: 'cus_stripe_123',
      };
      const ctx = connector.extract(response);
      expect(ctx).not.toBeNull();
      expect(ctx!.cost).toBe(2.50);
      expect(ctx!.currency).toBe('USD');
      expect(ctx!.protocol).toBe('mpp');
      expect(ctx!.payer).toBe('cus_stripe_123');
      expect(ctx!.protocol_metadata?.session_token).toBe('spt_abc123');
    });

    it('should return null without session_token', () => {
      const response = { cost: 2.50, currency: 'USD' };
      expect(connector.extract(response)).toBeNull();
    });

    it('should handle nested mpp_session', () => {
      const response = {
        mpp_session: {
          session_token: 'spt_nested',
          cost: 1.00,
          currency: 'EUR',
        },
      };
      const ctx = connector.extract(response);
      expect(ctx).not.toBeNull();
      expect(ctx!.cost).toBe(1.00);
      expect(ctx!.currency).toBe('EUR');
    });

    it('should default cost to 0 when missing', () => {
      const response = { session_token: 'spt_nocost' };
      const ctx = connector.extract(response);
      expect(ctx).not.toBeNull();
      expect(ctx!.cost).toBe(0);
    });

    it('should default currency to USD when missing', () => {
      const response = { session_token: 'spt_nocurrency', cost: 1.00 };
      const ctx = connector.extract(response);
      expect(ctx).not.toBeNull();
      expect(ctx!.currency).toBe('USD');
    });
  });

  describe('extract (Response object)', () => {
    it('should extract from Response with MPP headers', () => {
      const res = new Response(null, {
        status: 200,
        headers: {
          'x-mpp-session': 'spt_resp123',
          'x-mpp-cost': '3.50',
          'x-mpp-currency': 'USD',
          'x-mpp-payer': 'cus_stripe_456',
        },
      });
      const ctx = connector.extract(res);
      expect(ctx).not.toBeNull();
      expect(ctx!.cost).toBe(3.50);
      expect(ctx!.currency).toBe('USD');
      expect(ctx!.protocol).toBe('mpp');
      expect(ctx!.payer).toBe('cus_stripe_456');
      expect(ctx!.protocol_metadata?.session_token).toBe('spt_resp123');
    });

    it('should return null for Response missing x-mpp-session', () => {
      const res = new Response(null, {
        status: 200,
        headers: {
          'x-mpp-cost': '1.00',
          'x-mpp-currency': 'USD',
        },
      });
      expect(connector.extract(res)).toBeNull();
    });

    it('should default cost to 0 when x-mpp-cost header is absent', () => {
      const res = new Response(null, {
        status: 200,
        headers: { 'x-mpp-session': 'spt_nocost' },
      });
      const ctx = connector.extract(res);
      expect(ctx).not.toBeNull();
      expect(ctx!.cost).toBe(0);
    });

    it('should default currency to USD when x-mpp-currency header is absent', () => {
      const res = new Response(null, {
        status: 200,
        headers: {
          'x-mpp-session': 'spt_nocurr',
          'x-mpp-cost': '2.00',
        },
      });
      const ctx = connector.extract(res);
      expect(ctx).not.toBeNull();
      expect(ctx!.currency).toBe('USD');
    });

    it('should return null for negative cost in header', () => {
      const res = new Response(null, {
        status: 200,
        headers: {
          'x-mpp-session': 'spt_neg',
          'x-mpp-cost': '-5',
        },
      });
      expect(connector.extract(res)).toBeNull();
    });
  });
});

describe('AP2 Connector', () => {
  const connector = createAP2Connector();

  it('should have correct protocol metadata', () => {
    expect(connector.protocol).toBe('ap2');
    expect(connector.protocolVersion).toBe('2026.03');
  });

  describe('extract (plain object)', () => {
    it('should extract from valid AP2 mandate', () => {
      const response = {
        mandate_id: 'mdt_abc123',
        cost: 15.00,
        currency: 'USD',
        spending_cap: 500,
        spent: 100,
        signer: 'user@example.com',
        categories: ['api_calls', 'search'],
      };
      const ctx = connector.extract(response);
      expect(ctx).not.toBeNull();
      expect(ctx!.cost).toBe(15.00);
      expect(ctx!.currency).toBe('USD');
      expect(ctx!.protocol).toBe('ap2');
      expect(ctx!.payer).toBe('user@example.com');
      expect(ctx!.protocol_metadata?.mandate_id).toBe('mdt_abc123');
      expect(ctx!.protocol_metadata?.categories).toEqual(['api_calls', 'search']);
    });

    it('should return null without mandate_id', () => {
      const response = { cost: 15.00, currency: 'USD' };
      expect(connector.extract(response)).toBeNull();
    });

    it('should return null for expired mandate', () => {
      const response = {
        mandate_id: 'mdt_expired',
        cost: 5.00,
        expires_at: '2020-01-01T00:00:00Z',
      };
      expect(connector.extract(response)).toBeNull();
    });

    it('should fail closed for unparseable mandate expiry', () => {
      const response = {
        mandate_id: 'mdt_bad_expiry',
        cost: 5.00,
        expires_at: 'not-a-date',
      };
      expect(connector.extract(response)).toBeNull();
    });

    it('should accept non-expired mandate', () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      const response = {
        mandate_id: 'mdt_valid',
        cost: 5.00,
        expires_at: futureDate,
      };
      const ctx = connector.extract(response);
      expect(ctx).not.toBeNull();
    });

    it('should handle nested ap2_mandate', () => {
      const response = {
        ap2_mandate: {
          mandate_id: 'mdt_nested',
          cost: 10.00,
          currency: 'EUR',
        },
      };
      const ctx = connector.extract(response);
      expect(ctx).not.toBeNull();
      expect(ctx!.cost).toBe(10.00);
    });

    it('should default cost to 0 when missing', () => {
      const response = { mandate_id: 'mdt_nocost' };
      const ctx = connector.extract(response);
      expect(ctx).not.toBeNull();
      expect(ctx!.cost).toBe(0);
    });

    it('should return null when cost exceeds remaining spending cap', () => {
      const response = {
        mandate_id: 'mdt_overcap',
        cost: 50,
        spending_cap: 100,
        spent: 80,
      };
      expect(connector.extract(response)).toBeNull();
    });

    it('should allow when cost is within remaining spending cap', () => {
      const response = {
        mandate_id: 'mdt_undercap',
        cost: 15,
        spending_cap: 100,
        spent: 80,
      };
      const ctx = connector.extract(response);
      expect(ctx).not.toBeNull();
      expect(ctx!.cost).toBe(15);
    });

    it('should enforce spending cap when spent is omitted', () => {
      const response = {
        mandate_id: 'mdt_missing_spent',
        cost: 150,
        spending_cap: 100,
      };
      expect(connector.extract(response)).toBeNull();
    });

    it('should allow when spending_cap is not present (no enforcement)', () => {
      const response = {
        mandate_id: 'mdt_nocap',
        cost: 999,
      };
      const ctx = connector.extract(response);
      expect(ctx).not.toBeNull();
      expect(ctx!.cost).toBe(999);
    });
  });

  describe('extract (Response object)', () => {
    it('should extract from Response with AP2 headers', () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      const res = new Response(null, {
        status: 200,
        headers: {
          'x-ap2-mandate-id': 'mdt_resp123',
          'x-ap2-cost': '10.00',
          'x-ap2-currency': 'USD',
          'x-ap2-signer': 'user@example.com',
          'x-ap2-spending-cap': '500',
          'x-ap2-expires': futureDate,
        },
      });
      const ctx = connector.extract(res);
      expect(ctx).not.toBeNull();
      expect(ctx!.cost).toBe(10.00);
      expect(ctx!.currency).toBe('USD');
      expect(ctx!.protocol).toBe('ap2');
      expect(ctx!.payer).toBe('user@example.com');
      expect(ctx!.protocol_metadata?.mandate_id).toBe('mdt_resp123');
      expect(ctx!.protocol_metadata?.spending_cap).toBe(500);
      expect(ctx!.protocol_metadata?.expires_at).toBe(futureDate);
    });

    it('should return null for Response missing x-ap2-mandate-id', () => {
      const res = new Response(null, {
        status: 200,
        headers: {
          'x-ap2-cost': '10.00',
          'x-ap2-currency': 'USD',
        },
      });
      expect(connector.extract(res)).toBeNull();
    });

    it('should return null for expired x-ap2-expires header', () => {
      const res = new Response(null, {
        status: 200,
        headers: {
          'x-ap2-mandate-id': 'mdt_expired',
          'x-ap2-cost': '5.00',
          'x-ap2-expires': '2020-01-01T00:00:00Z',
        },
      });
      expect(connector.extract(res)).toBeNull();
    });

    it('should fail closed for unparseable x-ap2-expires header', () => {
      const res = new Response(null, {
        status: 200,
        headers: {
          'x-ap2-mandate-id': 'mdt_bad_expiry',
          'x-ap2-cost': '5.00',
          'x-ap2-expires': 'not-a-date',
        },
      });
      expect(connector.extract(res)).toBeNull();
    });

    it('should enforce x-ap2-spending-cap when x-ap2-spent is absent', () => {
      const res = new Response(null, {
        status: 200,
        headers: {
          'x-ap2-mandate-id': 'mdt_missing_spent',
          'x-ap2-cost': '150',
          'x-ap2-spending-cap': '100',
        },
      });
      expect(connector.extract(res)).toBeNull();
    });

    it('should default cost to 0 when x-ap2-cost header is absent', () => {
      const res = new Response(null, {
        status: 200,
        headers: { 'x-ap2-mandate-id': 'mdt_nocost' },
      });
      const ctx = connector.extract(res);
      expect(ctx).not.toBeNull();
      expect(ctx!.cost).toBe(0);
    });

    it('should default currency to USD when x-ap2-currency header is absent', () => {
      const res = new Response(null, {
        status: 200,
        headers: {
          'x-ap2-mandate-id': 'mdt_nocurr',
          'x-ap2-cost': '7.00',
        },
      });
      const ctx = connector.extract(res);
      expect(ctx).not.toBeNull();
      expect(ctx!.currency).toBe('USD');
    });

    it('should accept non-expired mandate via Response headers', () => {
      const futureDate = new Date(Date.now() + 86400000 * 30).toISOString();
      const res = new Response(null, {
        status: 200,
        headers: {
          'x-ap2-mandate-id': 'mdt_valid',
          'x-ap2-cost': '3.00',
          'x-ap2-expires': futureDate,
        },
      });
      const ctx = connector.extract(res);
      expect(ctx).not.toBeNull();
      expect(ctx!.cost).toBe(3.00);
    });

    it('should return null when cost exceeds spending cap via headers', () => {
      const res = new Response(null, {
        status: 200,
        headers: {
          'x-ap2-mandate-id': 'mdt_overcap',
          'x-ap2-cost': '50',
          'x-ap2-spending-cap': '100',
          'x-ap2-spent': '80',
        },
      });
      expect(connector.extract(res)).toBeNull();
    });

    it('should allow when cost is within spending cap via headers', () => {
      const res = new Response(null, {
        status: 200,
        headers: {
          'x-ap2-mandate-id': 'mdt_undercap',
          'x-ap2-cost': '15',
          'x-ap2-spending-cap': '100',
          'x-ap2-spent': '80',
        },
      });
      const ctx = connector.extract(res);
      expect(ctx).not.toBeNull();
      expect(ctx!.cost).toBe(15);
      expect(ctx!.protocol_metadata?.mandate_spent).toBe(80);
    });

    it('should allow when x-ap2-spending-cap header is absent', () => {
      const res = new Response(null, {
        status: 200,
        headers: {
          'x-ap2-mandate-id': 'mdt_nocap',
          'x-ap2-cost': '999',
        },
      });
      const ctx = connector.extract(res);
      expect(ctx).not.toBeNull();
      expect(ctx!.cost).toBe(999);
    });
  });
});

describe('Connector Error Builders', () => {
  it('buildX402ConnectorError should return connector_error with x402 name', () => {
    const err = buildX402ConnectorError('payment header parse failed');
    expect(err.reason).toBe('connector_error');
    expect(err.connector_name).toBe('x402');
    expect(err.raw_error).toBe('payment header parse failed');
    expect(err.cost).toBe(0);
    expect(err.currency).toBe('USD');
    expect(err.budget_scope).toBe('session');
    expect(err.budget_limit).toBe(0);
    expect(err.budget_spent).toBe(0);
    expect(err.budget_remaining).toBe(0);
  });

  it('buildMPPConnectorError should return connector_error with mpp name', () => {
    const err = buildMPPConnectorError('session token expired');
    expect(err.reason).toBe('connector_error');
    expect(err.connector_name).toBe('mpp');
    expect(err.raw_error).toBe('session token expired');
    expect(err.cost).toBe(0);
    expect(err.currency).toBe('USD');
    expect(err.budget_scope).toBe('session');
    expect(err.budget_limit).toBe(0);
    expect(err.budget_spent).toBe(0);
    expect(err.budget_remaining).toBe(0);
  });

  it('buildAP2ConnectorError should return connector_error with ap2 name', () => {
    const err = buildAP2ConnectorError('mandate verification failed');
    expect(err.reason).toBe('connector_error');
    expect(err.connector_name).toBe('ap2');
    expect(err.raw_error).toBe('mandate verification failed');
    expect(err.cost).toBe(0);
    expect(err.currency).toBe('USD');
    expect(err.budget_scope).toBe('session');
    expect(err.budget_limit).toBe(0);
    expect(err.budget_spent).toBe(0);
    expect(err.budget_remaining).toBe(0);
  });
});
