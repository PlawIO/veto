/**
 * Stripe MPP (Machine Payments Protocol) connector.
 *
 * Reads MPP session spending limits and per-action costs from
 * session metadata. Tracks cumulative session spend against
 * Veto budget policies.
 *
 * Timing mode: pre-call — session metadata available at setup.
 * MPP spec version: March 2026 launch (spec may evolve).
 *
 * @module economic/connectors/mpp
 */

import type { EconomicContext, ProtocolConnector, EconomicDenialDetails } from '../types.js';

/**
 * MPP session data shape (from Stripe's session negotiation response).
 */
export interface MPPSessionData {
  /** Shared Payment Token identifier */
  session_token?: string;
  /** Per-action cost in the session currency */
  cost?: number;
  /** Session currency (ISO 4217) */
  currency?: string;
  /** Session spending limit */
  spending_limit?: number;
  /** Cumulative session spend so far */
  spent?: number;
  /** Payer identifier (Stripe customer ID or SPT holder) */
  payer?: string;
  /** Additional session metadata */
  [key: string]: unknown;
}

function extractMPPSessionData(obj: Record<string, unknown>): MPPSessionData | null {
  // Accept both top-level and nested mpp_session shapes
  const session = (obj.mpp_session ?? obj) as Record<string, unknown>;

  const sessionToken = session.session_token;
  if (typeof sessionToken !== 'string' || !sessionToken) return null;

  const cost = typeof session.cost === 'number' ? session.cost : undefined;
  const currency = typeof session.currency === 'string' ? session.currency : undefined;
  const spendingLimit = typeof session.spending_limit === 'number' ? session.spending_limit : undefined;
  const spent = typeof session.spent === 'number' ? session.spent : undefined;
  const payer = typeof session.payer === 'string' ? session.payer : undefined;

  return {
    session_token: sessionToken,
    cost,
    currency,
    spending_limit: spendingLimit,
    spent,
    payer,
  };
}

/**
 * Create an MPP protocol connector.
 */
export function createMPPConnector(): ProtocolConnector {
  return {
    protocol: 'mpp',
    protocolVersion: '2026.03',

    extract(response: Response | Record<string, unknown>): EconomicContext | null {
      // Handle fetch Response objects — MPP data comes in response headers/body
      if (response instanceof Response) {
        // Check for MPP headers
        const mppSession = response.headers.get('x-mpp-session');
        const mppCost = response.headers.get('x-mpp-cost');
        const mppCurrency = response.headers.get('x-mpp-currency');
        const mppPayer = response.headers.get('x-mpp-payer');

        if (!mppSession) return null;

        const cost = mppCost ? Number(mppCost) : undefined;
        if (cost !== undefined && (!Number.isFinite(cost) || cost < 0)) return null;

        return {
          cost: cost ?? 0,
          currency: (mppCurrency ?? 'USD').toUpperCase(),
          payer: mppPayer ?? undefined,
          protocol: 'mpp',
          protocol_metadata: {
            session_token: mppSession,
          },
        };
      }

      // Handle plain objects (manual mode / pre-call)
      const sessionData = extractMPPSessionData(response);
      if (!sessionData) return null;

      return {
        cost: sessionData.cost ?? 0,
        currency: (sessionData.currency ?? 'USD').toUpperCase(),
        payer: sessionData.payer,
        protocol: 'mpp',
        protocol_metadata: {
          session_token: sessionData.session_token,
          spending_limit: sessionData.spending_limit,
          session_spent: sessionData.spent,
        },
      };
    },
  };
}

/**
 * Build a connector_error denial for MPP parse failures.
 */
export function buildMPPConnectorError(error: string): EconomicDenialDetails {
  return {
    reason: 'connector_error',
    cost: 0,
    currency: 'USD',
    budget_scope: 'session',
    budget_limit: 0,
    budget_spent: 0,
    budget_remaining: 0,
    connector_name: 'mpp',
    raw_error: error,
  };
}
