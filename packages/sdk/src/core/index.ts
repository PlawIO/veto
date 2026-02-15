/**
 * Core module exports for Veto.
 *
 * @module core
 */

export { Veto, ToolCallDeniedError, type VetoOptions } from './veto.js';
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
