/**
 * Core module exports for Veto.
 *
 * @module core
 */

export {
  Veto,
  ToolCallDeniedError,
  type VetoOptions,
  type GuardContext,
  type GuardResult,
} from './veto.js';
export {
  ValidationEngine,
  createPassthroughValidator,
  createBlocklistValidator,
  createAllowlistValidator,
  type ValidationEngineOptions,
  type AggregatedValidationResult,
} from './validator.js';
export {
  HistoryTracker,
  type HistoryTrackerOptions,
  type HistoryStats,
} from './history.js';
export {
  BudgetTracker,
  BudgetExceededError,
  type BudgetConfig,
  type ToolCostMap,
  type BudgetTrackerOptions,
  type BudgetStatus,
} from './budget.js';
export {
  Interceptor,
  type InterceptorOptions,
  type InterceptionResult,
} from './interceptor.js';
export {
  EventWebhookEmitter,
  formatSlackPayload,
  formatPagerDutyPayload,
  formatGenericPayload,
  formatCefPayload,
  resolveEventWebhookConfig,
  type EventWebhookConfig,
  type VetoWebhookEvent,
  type VetoWebhookEventType,
  type VetoWebhookFormat,
} from './events.js';
