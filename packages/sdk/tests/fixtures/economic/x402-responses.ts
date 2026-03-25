/**
 * x402 protocol response fixtures for testing.
 *
 * Based on x402 V2 spec (Coinbase, stable since Dec 2025).
 * Header format: key=value pairs separated by semicolons.
 */

/** Valid 402 with USDC payment on Base chain */
export const VALID_402_USDC_BASE = {
  status: 402,
  headers: {
    'x-payment': 'price=0.01;token=USDC;chain=base;recipient=0xabc123def456',
  },
};

/** Valid 402 with higher cost */
export const VALID_402_EXPENSIVE = {
  status: 402,
  headers: {
    'x-payment': 'price=75.00;token=USDC;chain=base;recipient=0xabc123def456',
  },
};

/** Valid 402 with USDT */
export const VALID_402_USDT = {
  status: 402,
  headers: {
    'x-payment': 'price=5.00;token=USDT;chain=ethereum;recipient=0xdef789',
  },
};

/** Valid 402 with zero price (free tier) */
export const VALID_402_FREE = {
  status: 402,
  headers: {
    'x-payment': 'price=0;token=USDC;chain=base;recipient=0xabc123def456',
  },
};

/** Non-402 success response */
export const SUCCESS_200 = {
  status: 200,
  headers: {},
};

/** 402 without payment header */
export const BARE_402 = {
  status: 402,
  headers: {},
};

/** 402 with non-stablecoin (should reject) */
export const INVALID_402_ETH = {
  status: 402,
  headers: {
    'x-payment': 'price=0.5;token=ETH;chain=ethereum;recipient=0xabc',
  },
};

/** 402 with malformed header (missing fields) */
export const MALFORMED_402 = {
  status: 402,
  headers: {
    'x-payment': 'price=0.01;token=USDC',
  },
};

/** 402 with negative price */
export const NEGATIVE_PRICE_402 = {
  status: 402,
  headers: {
    'x-payment': 'price=-1;token=USDC;chain=base;recipient=0xabc',
  },
};
