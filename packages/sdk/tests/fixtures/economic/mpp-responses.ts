/**
 * Stripe MPP protocol response fixtures for testing.
 *
 * Based on MPP spec (launched 2026-03-18, protocolVersion: 2026.03).
 */

/** Valid MPP session with all fields */
export const VALID_MPP_SESSION = {
  session_token: 'spt_abc123',
  cost: 2.50,
  currency: 'USD',
  spending_limit: 100,
  spent: 25,
  payer: 'cus_stripe_123',
};

/** MPP session with nested mpp_session field */
export const NESTED_MPP_SESSION = {
  mpp_session: {
    session_token: 'spt_nested_456',
    cost: 1.00,
    currency: 'EUR',
  },
};

/** MPP session without cost (defaults to 0) */
export const MPP_NO_COST = {
  session_token: 'spt_nocost',
};

/** MPP session without session_token (invalid) */
export const MPP_NO_TOKEN = {
  cost: 2.50,
  currency: 'USD',
};

/** MPP session for budget exhaustion testing */
export const MPP_EXPENSIVE = {
  session_token: 'spt_expensive',
  cost: 40.00,
  currency: 'USD',
  payer: 'cus_stripe_big',
};
