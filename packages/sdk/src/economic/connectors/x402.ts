/**
 * x402 protocol connector.
 *
 * Detects HTTP 402 Payment Required responses and parses the
 * X-Payment header (Coinbase x402 V2 protocol) into EconomicContext.
 *
 * Timing mode: post-response — cost discovered from 402 response.
 *
 * @module economic/connectors/x402
 */

import type { EconomicContext, ProtocolConnector, EconomicDenialDetails } from '../types.js';

/**
 * Stablecoin tokens treated as 1:1 USD parity.
 * Non-stable tokens require developer-provided exchange rates (not supported in v1).
 */
const STABLECOIN_TOKENS = new Set(['USDC', 'USDT', 'DAI', 'BUSD']);

/**
 * Parsed x402 payment instruction from X-Payment header.
 */
interface X402PaymentInstruction {
  price: string;
  token: string;
  chain: string;
  recipient: string;
  [key: string]: string;
}

function parseXPaymentHeader(header: string): X402PaymentInstruction | null {
  // X-Payment header format: key=value pairs separated by semicolons
  // e.g., "price=0.01;token=USDC;chain=base;recipient=0xabc..."
  const parts = header.split(';').map(p => p.trim()).filter(Boolean);
  const result: Record<string, string> = {};

  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim().toLowerCase();
    const value = part.slice(eqIdx + 1).trim();
    if (key && value) {
      result[key] = value;
    }
  }

  if (!result.price || !result.token || !result.chain || !result.recipient) {
    return null;
  }

  return result as unknown as X402PaymentInstruction;
}

function tokenToUsd(price: string, token: string): number | null {
  const amount = Number(price);
  if (!Number.isFinite(amount) || amount < 0) return null;

  const upperToken = token.toUpperCase();
  if (STABLECOIN_TOKENS.has(upperToken)) {
    return amount; // 1:1 parity
  }

  // Non-stable tokens not supported in v1
  return null;
}

/**
 * Create an x402 protocol connector.
 */
export function createX402Connector(): ProtocolConnector {
  return {
    protocol: 'x402',
    protocolVersion: '2.0',

    extract(response: Response | Record<string, unknown>): EconomicContext | null {
      // Handle fetch Response objects
      if (response instanceof Response) {
        if (response.status !== 402) return null;

        const paymentHeader = response.headers.get('x-payment');
        if (!paymentHeader) return null;

        return parseFromHeader(paymentHeader);
      }

      // Handle plain objects (manual mode)
      const status = (response as Record<string, unknown>).status;
      if (status !== 402) return null;

      const headers = (response as Record<string, unknown>).headers;
      if (!headers || typeof headers !== 'object') return null;

      // Support both Map-like and plain object headers
      let paymentHeader: string | undefined;
      if (headers instanceof Headers) {
        paymentHeader = headers.get('x-payment') ?? undefined;
      } else {
        const headerObj = headers as Record<string, unknown>;
        paymentHeader = (
          headerObj['x-payment'] ?? headerObj['X-Payment']
        ) as string | undefined;
      }

      if (!paymentHeader) return null;
      return parseFromHeader(paymentHeader);
    },

    wrapFetch(fetchFn: typeof fetch): typeof fetch {
      return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const response = await fetchFn(input, init);

        // Only intercept 402 responses — pass everything else through
        if (response.status !== 402) return response;

        // Clone to avoid consuming the body
        const cloned = response.clone();
        const paymentHeader = cloned.headers.get('x-payment');
        if (!paymentHeader) return response;

        const context = parseFromHeader(paymentHeader);
        if (context) {
          // Attach economic context to response for downstream consumption
          (response as Response & { __vetoEconomicContext?: EconomicContext })
            .__vetoEconomicContext = context;
        }

        return response;
      };
    },
  };
}

function parseFromHeader(header: string): EconomicContext | null {
  const instruction = parseXPaymentHeader(header);
  if (!instruction) return null;

  const costUsd = tokenToUsd(instruction.price, instruction.token);
  if (costUsd === null) return null;

  return {
    cost: costUsd,
    currency: 'USD',
    payer: undefined, // Agent wallet set by caller
    protocol: 'x402',
    protocol_metadata: {
      token: instruction.token,
      chain: instruction.chain,
      recipient: instruction.recipient,
      raw_price: instruction.price,
    },
  };
}

/**
 * Build a connector_error denial for x402 parse failures.
 */
export function buildX402ConnectorError(error: string): EconomicDenialDetails {
  return {
    reason: 'connector_error',
    cost: 0,
    currency: 'USD',
    budget_scope: 'session',
    budget_limit: 0,
    budget_spent: 0,
    budget_remaining: 0,
    connector_name: 'x402',
    raw_error: error,
  };
}
