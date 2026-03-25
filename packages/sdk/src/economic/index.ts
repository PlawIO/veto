/**
 * Economic authorization module.
 *
 * Protocol-agnostic economic policy enforcement for agent payments
 * across x402, Stripe MPP, Google AP2, and custom protocols.
 *
 * @module economic
 */

// Types
export type {
  EconomicProtocol,
  EconomicContext,
  EconomicDenialReason,
  EconomicDenialDetails,
  BudgetScope,
  EconomicBudgetConfig,
  CostExtractionConfig,
  PayerConfig,
  DenialReasonTemplates,
  EconomicPolicyConfig,
  BudgetCheckResult,
  EconomicBudgetStatus,
  BudgetEngine,
  ProtocolConnector,
  EconomicWebhookEventType,
} from './types.js';

// Budget engine
export {
  LocalBudgetEngine,
  type LocalBudgetEngineOptions,
} from './budget-engine.js';

// Evaluator
export {
  EconomicEvaluator,
  type EconomicEvaluatorOptions,
  type EconomicEvaluationResult,
} from './evaluator.js';

// Connectors
export {
  createX402Connector,
  createMPPConnector,
  createAP2Connector,
  buildX402ConnectorError,
  buildMPPConnectorError,
  buildAP2ConnectorError,
  type MPPSessionData,
  type AP2MandateData,
} from './connectors/index.js';
