/**
 * Google AP2 (Agent Payments Protocol) connector.
 *
 * Reads AP2 mandate constraints (spending caps, categories, expiry)
 * and enforces Veto policies ON TOP of mandate constraints.
 * Veto is always more restrictive, never less (D4).
 *
 * Timing mode: pre-call — mandate metadata available at setup.
 * Note: v1 does NOT verify mandate signatures. AP2 card-based
 * crypto path is still maturing; signature verification is Phase 2.
 *
 * @module economic/connectors/ap2
 */

import type { EconomicContext, ProtocolConnector, EconomicDenialDetails } from '../types.js';

/**
 * AP2 mandate data shape (from mandate negotiation response).
 */
export interface AP2MandateData {
  /** Mandate identifier */
  mandate_id?: string;
  /** Maximum spending amount for this mandate */
  spending_cap?: number;
  /** Amount already spent under this mandate */
  spent?: number;
  /** Mandate currency (ISO 4217) */
  currency?: string;
  /** Mandate expiry (ISO 8601) */
  expires_at?: string;
  /**
   * Allowed spending categories.
   *
   * Categories are advisory metadata in v1. Use Veto rules to enforce
   * tool-category constraints.
   */
  categories?: string[];
  /** Mandate signer (payer identity) */
  signer?: string;
  /** Per-action cost */
  cost?: number;
  /** Additional mandate metadata */
  [key: string]: unknown;
}

function extractMandateData(obj: Record<string, unknown>): AP2MandateData | null {
  const mandate = (obj.ap2_mandate ?? obj.mandate ?? obj) as Record<string, unknown>;

  const mandateId = mandate.mandate_id;
  if (typeof mandateId !== 'string' || !mandateId) return null;

  return {
    mandate_id: mandateId,
    spending_cap: typeof mandate.spending_cap === 'number' ? mandate.spending_cap : undefined,
    spent: typeof mandate.spent === 'number' ? mandate.spent : undefined,
    currency: typeof mandate.currency === 'string' ? mandate.currency : undefined,
    expires_at: typeof mandate.expires_at === 'string' ? mandate.expires_at : undefined,
    categories: Array.isArray(mandate.categories) ? mandate.categories.filter(c => typeof c === 'string') : undefined,
    signer: typeof mandate.signer === 'string' ? mandate.signer : undefined,
    cost: typeof mandate.cost === 'number' ? mandate.cost : undefined,
  };
}

function isMandateExpired(expiresAt: string): boolean {
  const expiry = new Date(expiresAt);
  // Fail-closed: treat unparseable dates as expired (payment boundary)
  if (Number.isNaN(expiry.getTime())) return true;
  return expiry.getTime() < Date.now();
}

function exceedsSpendingCap(cost: number, spendingCap?: number, spent?: number): boolean {
  if (spendingCap == null) return false;
  // If spent is unknown, assume 0 (fail-closed: enforce cap from scratch)
  return cost > (spendingCap - (spent ?? 0));
}

/**
 * Create an AP2 protocol connector.
 */
export function createAP2Connector(): ProtocolConnector {
  return {
    protocol: 'ap2',
    protocolVersion: '2026.03',

    extract(response: Response | Record<string, unknown>): EconomicContext | null {
      // Handle fetch Response objects
      if (response instanceof Response) {
        const mandateId = response.headers.get('x-ap2-mandate-id');
        const ap2Cost = response.headers.get('x-ap2-cost');
        const ap2Currency = response.headers.get('x-ap2-currency');
        const ap2Signer = response.headers.get('x-ap2-signer');
        const ap2SpendingCap = response.headers.get('x-ap2-spending-cap');
        const ap2Spent = response.headers.get('x-ap2-spent');
        const ap2Expires = response.headers.get('x-ap2-expires');

        if (!mandateId) return null;

        // Check mandate expiry
        if (ap2Expires && isMandateExpired(ap2Expires)) return null;

        const cost = ap2Cost ? Number(ap2Cost) : 0;
        if (!Number.isFinite(cost) || cost < 0) return null;

        // Enforce spending cap (D4: Veto is always more restrictive)
        const spendingCap = ap2SpendingCap ? Number(ap2SpendingCap) : undefined;
        const spent = ap2Spent ? Number(ap2Spent) : undefined;
        if (exceedsSpendingCap(cost, spendingCap, spent)) return null;

        return {
          cost,
          currency: (ap2Currency ?? 'USD').toUpperCase(),
          payer: ap2Signer ?? undefined,
          protocol: 'ap2',
          protocol_metadata: {
            mandate_id: mandateId,
            spending_cap: spendingCap,
            mandate_spent: spent,
            expires_at: ap2Expires ?? undefined,
          },
        };
      }

      // Handle plain objects (manual mode / pre-call)
      const mandate = extractMandateData(response);
      if (!mandate) return null;

      // Check mandate expiry
      if (mandate.expires_at && isMandateExpired(mandate.expires_at)) return null;

      // Enforce spending cap (D4: Veto is always more restrictive)
      const cost = mandate.cost ?? 0;
      if (exceedsSpendingCap(cost, mandate.spending_cap, mandate.spent)) return null;

      return {
        cost,
        currency: (mandate.currency ?? 'USD').toUpperCase(),
        payer: mandate.signer,
        protocol: 'ap2',
        protocol_metadata: {
          mandate_id: mandate.mandate_id,
          spending_cap: mandate.spending_cap,
          mandate_spent: mandate.spent,
          /**
           * Categories are advisory metadata in v1. Use Veto rules to
           * enforce tool-category constraints.
           */
          categories: mandate.categories,
          expires_at: mandate.expires_at,
        },
      };
    },
  };
}

/**
 * Build a connector_error denial for AP2 parse failures.
 */
export function buildAP2ConnectorError(error: string): EconomicDenialDetails {
  return {
    reason: 'connector_error',
    cost: 0,
    currency: 'USD',
    budget_scope: 'session',
    budget_limit: 0,
    budget_spent: 0,
    budget_remaining: 0,
    connector_name: 'ap2',
    raw_error: error,
  };
}
