import type { Logger } from '../utils/logger.js';

export interface BudgetConfig {
  max: number;
  currency?: string;
  window?: 'session';
}

export interface ToolCostMap {
  [toolName: string]: number | string;
}

export interface BudgetTrackerOptions {
  config: BudgetConfig;
  costs: ToolCostMap;
  logger: Logger;
}

export interface BudgetStatus {
  spent: number;
  limit: number;
  remaining: number;
  currency: string;
}

export class BudgetExceededError extends Error {
  readonly spent: number;
  readonly limit: number;
  readonly remaining: number;
  readonly toolName: string;
  readonly toolCost: number;

  constructor(
    toolName: string,
    toolCost: number,
    spent: number,
    limit: number
  ) {
    const remaining = Math.max(0, limit - spent);
    super(
      `Budget exceeded: ${toolName} costs ${toolCost}, but only ${remaining.toFixed(2)} of ${limit.toFixed(2)} remaining`
    );
    this.name = 'BudgetExceededError';
    this.toolName = toolName;
    this.toolCost = toolCost;
    this.spent = spent;
    this.limit = limit;
    this.remaining = remaining;
  }
}

export class BudgetTracker {
  private spent = 0;
  private readonly config: BudgetConfig;
  private readonly costs: ToolCostMap;
  private readonly logger: Logger;

  constructor(options: BudgetTrackerOptions) {
    this.config = options.config;
    this.costs = options.costs;
    this.logger = options.logger;
  }

  resolveCost(
    toolName: string,
    args: Record<string, unknown>
  ): number {
    const costDef = this.costs[toolName];
    if (costDef === undefined) return 0;

    if (typeof costDef === 'number') return costDef;

    // Dynamic cost from arguments path (e.g. "args.amount")
    const value = this.resolveArgPath(costDef, args);
    if (typeof value === 'number' && isFinite(value) && value >= 0) return value;

    this.logger.warn('Dynamic cost resolved to non-numeric value, defaulting to 0', {
      toolName,
      path: costDef,
      resolved: value,
    });
    return 0;
  }

  private resolveArgPath(
    path: string,
    args: Record<string, unknown>
  ): unknown {
    // Strip leading "args." prefix if present
    const cleanPath = path.startsWith('args.') ? path.slice(5) : path;
    const parts = cleanPath.split('.');

    let current: unknown = args;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  check(toolName: string, args: Record<string, unknown>): void {
    const cost = this.resolveCost(toolName, args);
    if (cost === 0) return;

    if (this.spent + cost > this.config.max) {
      this.logger.warn('Budget would be exceeded', {
        toolName,
        cost,
        spent: this.spent,
        limit: this.config.max,
      });
      throw new BudgetExceededError(
        toolName,
        cost,
        this.spent,
        this.config.max
      );
    }
  }

  record(toolName: string, args: Record<string, unknown>): number {
    const cost = this.resolveCost(toolName, args);
    this.spent += cost;

    if (cost > 0) {
      this.logger.debug('Budget charge recorded', {
        toolName,
        cost,
        totalSpent: this.spent,
        remaining: this.config.max - this.spent,
      });
    }

    return cost;
  }

  getStatus(): BudgetStatus {
    return {
      spent: this.spent,
      limit: this.config.max,
      remaining: Math.max(0, this.config.max - this.spent),
      currency: this.config.currency ?? 'USD',
    };
  }

  reset(): void {
    const previous = this.spent;
    this.spent = 0;
    this.logger.debug('Budget reset', { previousSpent: previous });
  }
}
