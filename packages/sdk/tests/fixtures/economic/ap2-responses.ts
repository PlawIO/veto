/**
 * Google AP2 protocol response fixtures for testing.
 *
 * Based on AP2 spec (60+ org coalition, protocolVersion: 2026.03).
 */

/** Valid AP2 mandate with all fields */
export const VALID_AP2_MANDATE = {
  mandate_id: 'mdt_abc123',
  cost: 15.00,
  currency: 'USD',
  spending_cap: 500,
  spent: 100,
  signer: 'user@example.com',
  categories: ['api_calls', 'search'],
};

/** AP2 mandate with nested ap2_mandate field */
export const NESTED_AP2_MANDATE = {
  ap2_mandate: {
    mandate_id: 'mdt_nested_456',
    cost: 10.00,
    currency: 'EUR',
  },
};

/** Expired AP2 mandate */
export const EXPIRED_AP2_MANDATE = {
  mandate_id: 'mdt_expired',
  cost: 5.00,
  expires_at: '2020-01-01T00:00:00Z',
};

/** AP2 mandate without mandate_id (invalid) */
export const AP2_NO_MANDATE = {
  cost: 15.00,
  currency: 'USD',
};

/** AP2 mandate with future expiry */
export const VALID_AP2_FUTURE_EXPIRY = {
  mandate_id: 'mdt_future',
  cost: 5.00,
  expires_at: new Date(Date.now() + 86400000).toISOString(),
};
