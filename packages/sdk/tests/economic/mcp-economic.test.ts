import { describe, it, expect } from 'vitest';
import { extractMCPEconomicContext } from '../../src/providers/adapters.js';

describe('MCP Economic Context Extraction', () => {
  it('should extract from _meta.economic_context', () => {
    const toolCall = {
      name: 'search_api',
      arguments: {
        query: 'test',
        _meta: {
          economic_context: {
            cost: 0.01,
            currency: 'USD',
            protocol: 'mpp',
            payer: 'cus_stripe_123',
          },
        },
      },
    };
    const ctx = extractMCPEconomicContext(toolCall);
    expect(ctx).not.toBeNull();
    expect(ctx!.cost).toBe(0.01);
    expect(ctx!.currency).toBe('USD');
    expect(ctx!.protocol).toBe('mpp');
    expect(ctx!.payer).toBe('cus_stripe_123');
  });

  it('should extract from top-level economic_context', () => {
    const toolCall = {
      name: 'trade',
      arguments: {
        economic_context: {
          cost: 25.00,
          currency: 'USD',
          protocol: 'ap2',
        },
      },
    };
    const ctx = extractMCPEconomicContext(toolCall);
    expect(ctx).not.toBeNull();
    expect(ctx!.cost).toBe(25);
    expect(ctx!.protocol).toBe('ap2');
  });

  it('should return null when no economic context present', () => {
    const toolCall = {
      name: 'read_file',
      arguments: { path: '/tmp/test' },
    };
    expect(extractMCPEconomicContext(toolCall)).toBeNull();
  });

  it('should return null for missing arguments', () => {
    const toolCall = { name: 'read_file' };
    expect(extractMCPEconomicContext(toolCall)).toBeNull();
  });

  it('should return null for negative cost', () => {
    const toolCall = {
      name: 'trade',
      arguments: {
        _meta: {
          economic_context: { cost: -5, currency: 'USD' },
        },
      },
    };
    expect(extractMCPEconomicContext(toolCall)).toBeNull();
  });

  it('should return null for non-numeric cost', () => {
    const toolCall = {
      name: 'trade',
      arguments: {
        _meta: {
          economic_context: { cost: 'expensive', currency: 'USD' },
        },
      },
    };
    expect(extractMCPEconomicContext(toolCall)).toBeNull();
  });

  it('should default currency to USD when missing', () => {
    const toolCall = {
      name: 'api_call',
      arguments: {
        _meta: {
          economic_context: { cost: 1.00, protocol: 'x402' },
        },
      },
    };
    const ctx = extractMCPEconomicContext(toolCall);
    expect(ctx).not.toBeNull();
    expect(ctx!.currency).toBe('USD');
  });

  it('should default protocol to custom when missing', () => {
    const toolCall = {
      name: 'api_call',
      arguments: {
        _meta: {
          economic_context: { cost: 1.00 },
        },
      },
    };
    const ctx = extractMCPEconomicContext(toolCall);
    expect(ctx).not.toBeNull();
    expect(ctx!.protocol).toBe('custom');
  });

  it('should preserve extra metadata as protocol_metadata', () => {
    const toolCall = {
      name: 'trade',
      arguments: {
        _meta: {
          economic_context: {
            cost: 10.00,
            currency: 'USD',
            protocol: 'ap2',
            mandate_id: 'mdt_123',
            categories: ['trading'],
          },
        },
      },
    };
    const ctx = extractMCPEconomicContext(toolCall);
    expect(ctx).not.toBeNull();
    expect(ctx!.protocol_metadata?.mandate_id).toBe('mdt_123');
    expect(ctx!.protocol_metadata?.categories).toEqual(['trading']);
  });

  it('should prefer _meta over top-level economic_context', () => {
    const toolCall = {
      name: 'trade',
      arguments: {
        economic_context: { cost: 999, currency: 'EUR', protocol: 'custom' as const },
        _meta: {
          economic_context: { cost: 1, currency: 'USD', protocol: 'x402' as const },
        },
      },
    };
    const ctx = extractMCPEconomicContext(toolCall);
    expect(ctx).not.toBeNull();
    expect(ctx!.cost).toBe(1);
    expect(ctx!.currency).toBe('USD');
  });

  it('should normalize invalid protocol to custom', () => {
    const toolCall = {
      name: 'api_call',
      arguments: {
        _meta: {
          economic_context: {
            cost: 5,
            currency: 'USD',
            protocol: 'invalid_garbage_protocol',
          },
        },
      },
    };
    const ctx = extractMCPEconomicContext(toolCall);
    expect(ctx).not.toBeNull();
    expect(ctx!.protocol).toBe('custom');
  });

  it('should accept valid protocol values', () => {
    for (const proto of ['x402', 'mpp', 'ap2', 'custom']) {
      const toolCall = {
        name: 'test',
        arguments: {
          _meta: {
            economic_context: { cost: 1, currency: 'USD', protocol: proto },
          },
        },
      };
      const ctx = extractMCPEconomicContext(toolCall);
      expect(ctx!.protocol).toBe(proto);
    }
  });
});
