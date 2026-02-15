import type { ToolCall } from '../types/tool.js';
import type { ArgumentConstraint } from '../deterministic/types.js';

export interface ObservedCall {
  toolName: string;
  arguments: Record<string, unknown>;
  timestamp: number;
}

export interface StopCondition {
  runs?: number;
  durationMs?: number;
}

export interface LearnOptions {
  stopCondition: StopCondition;
  output?: string;
  quiet?: boolean;
  margin?: number;
}

export interface ToolObservation {
  toolName: string;
  callCount: number;
  arguments: Map<string, ArgumentObservation>;
  callOrder: number[];
}

export interface ArgumentObservation {
  name: string;
  types: Set<string>;
  numericValues: number[];
  stringValues: string[];
  arrayLengths: number[];
  presentCount: number;
  totalCalls: number;
  nullCount: number;
}

export interface GeneratedPolicy {
  toolName: string;
  mode: 'deterministic';
  constraints: ArgumentConstraint[];
}

const DEFAULT_MARGIN = 0.1;
const ENUM_THRESHOLD = 10;

export class Observer {
  private readonly calls: ObservedCall[] = [];
  private readonly stopCondition: StopCondition;
  private startTime: number = 0;
  private _stopped = false;

  constructor(stopCondition: StopCondition) {
    this.stopCondition = stopCondition;
  }

  start(): void {
    this.startTime = Date.now();
    this._stopped = false;
  }

  record(call: ToolCall): void {
    if (this._stopped) return;

    this.calls.push({
      toolName: call.name,
      arguments: call.arguments,
      timestamp: Date.now(),
    });

    if (this.shouldStop()) {
      this._stopped = true;
    }
  }

  recordRaw(toolName: string, args: Record<string, unknown>): void {
    if (this._stopped) return;

    this.calls.push({
      toolName,
      arguments: args,
      timestamp: Date.now(),
    });

    if (this.shouldStop()) {
      this._stopped = true;
    }
  }

  shouldStop(): boolean {
    if (this._stopped) return true;

    if (this.stopCondition.runs !== undefined && this.calls.length >= this.stopCondition.runs) {
      return true;
    }

    if (this.stopCondition.durationMs !== undefined && this.startTime > 0) {
      const elapsed = Date.now() - this.startTime;
      if (elapsed >= this.stopCondition.durationMs) {
        return true;
      }
    }

    return false;
  }

  get stopped(): boolean {
    return this._stopped;
  }

  get callCount(): number {
    return this.calls.length;
  }

  getCalls(): readonly ObservedCall[] {
    return this.calls;
  }

  getObservations(): Map<string, ToolObservation> {
    const observations = new Map<string, ToolObservation>();
    let orderIndex = 0;

    for (const call of this.calls) {
      let obs = observations.get(call.toolName);
      if (!obs) {
        obs = {
          toolName: call.toolName,
          callCount: 0,
          arguments: new Map(),
          callOrder: [],
        };
        observations.set(call.toolName, obs);
      }

      obs.callCount++;
      obs.callOrder.push(orderIndex++);

      for (const [argName, argValue] of Object.entries(call.arguments)) {
        let argObs = obs.arguments.get(argName);
        if (!argObs) {
          argObs = {
            name: argName,
            types: new Set(),
            numericValues: [],
            stringValues: [],
            arrayLengths: [],
            presentCount: 0,
            totalCalls: obs.callCount,
            nullCount: 0,
          };
          obs.arguments.set(argName, argObs);
        }

        argObs.totalCalls = obs.callCount;
        argObs.presentCount++;

        if (argValue === null) {
          argObs.types.add('null');
          argObs.nullCount++;
        } else if (Array.isArray(argValue)) {
          argObs.types.add('array');
          argObs.arrayLengths.push(argValue.length);
        } else {
          const t = typeof argValue;
          argObs.types.add(t);
          if (t === 'number' && Number.isFinite(argValue as number)) {
            argObs.numericValues.push(argValue as number);
          } else if (t === 'string') {
            argObs.stringValues.push(argValue as string);
          }
        }
      }

      for (const [, argObs] of obs.arguments) {
        argObs.totalCalls = obs.callCount;
      }
    }

    return observations;
  }
}

export class PolicyGenerator {
  private readonly margin: number;

  constructor(margin: number = DEFAULT_MARGIN) {
    this.margin = margin;
  }

  generate(observations: Map<string, ToolObservation>): GeneratedPolicy[] {
    const policies: GeneratedPolicy[] = [];

    for (const [, obs] of observations) {
      const constraints = this.generateConstraints(obs);
      if (constraints.length > 0) {
        policies.push({
          toolName: obs.toolName,
          mode: 'deterministic',
          constraints,
        });
      }
    }

    return policies;
  }

  private generateConstraints(obs: ToolObservation): ArgumentConstraint[] {
    const constraints: ArgumentConstraint[] = [];

    for (const [, argObs] of obs.arguments) {
      const constraint = this.generateConstraint(argObs);
      if (constraint) {
        constraints.push(constraint);
      }
    }

    return constraints;
  }

  private generateConstraint(argObs: ArgumentObservation): ArgumentConstraint | null {
    const constraint: ArgumentConstraint = {
      argumentName: argObs.name,
      enabled: true,
    };

    let hasConstraints = false;

    if (argObs.presentCount === argObs.totalCalls && argObs.totalCalls > 0) {
      constraint.required = true;
      hasConstraints = true;
    }

    if (argObs.nullCount === 0 && argObs.presentCount > 0) {
      constraint.notNull = true;
      hasConstraints = true;
    }

    if (argObs.numericValues.length > 0) {
      const min = Math.min(...argObs.numericValues);
      const max = Math.max(...argObs.numericValues);
      const range = max - min;
      const marginValue = range > 0 ? range * this.margin : Math.max(Math.abs(min) * this.margin, 1);

      constraint.minimum = Math.floor((min - marginValue) * 100) / 100;
      constraint.maximum = Math.ceil((max + marginValue) * 100) / 100;
      hasConstraints = true;
    }

    if (argObs.stringValues.length > 0) {
      const uniqueValues = [...new Set(argObs.stringValues)];

      if (uniqueValues.length <= ENUM_THRESHOLD) {
        constraint.enum = uniqueValues.sort();
        hasConstraints = true;
      } else {
        const lengths = argObs.stringValues.map((s) => s.length);
        const minLen = Math.min(...lengths);
        const maxLen = Math.max(...lengths);
        constraint.minLength = Math.max(0, minLen - 1);
        constraint.maxLength = maxLen + Math.ceil(maxLen * this.margin);
        hasConstraints = true;
      }
    }

    if (argObs.arrayLengths.length > 0) {
      const minItems = Math.min(...argObs.arrayLengths);
      const maxItems = Math.max(...argObs.arrayLengths);
      const margin = Math.max(1, Math.ceil((maxItems - minItems) * this.margin));
      constraint.minItems = Math.max(0, minItems - margin);
      constraint.maxItems = maxItems + margin;
      hasConstraints = true;
    }

    return hasConstraints ? constraint : null;
  }
}

export function parseDuration(input: string): number {
  const match = input.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/);
  if (!match) {
    throw new Error(`Invalid duration format: "${input}". Use: 30s, 10m, 1h, 500ms`);
  }

  const value = parseFloat(match[1]);
  const unit = match[2];

  switch (unit) {
    case 'ms': return value;
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    default: throw new Error(`Unknown duration unit: ${unit}`);
  }
}

export function policiesToYaml(policies: GeneratedPolicy[]): string {
  const lines: string[] = [];
  lines.push('# Auto-generated policies from veto learn');
  lines.push(`# Generated at: ${new Date().toISOString()}`);
  lines.push(`# Tools observed: ${policies.length}`);
  lines.push('');
  lines.push('policies:');

  for (const policy of policies) {
    lines.push(`  - toolName: ${JSON.stringify(policy.toolName)}`);
    lines.push(`    mode: ${policy.mode}`);
    lines.push('    constraints:');

    for (const c of policy.constraints) {
      lines.push(`      - argumentName: ${JSON.stringify(c.argumentName)}`);
      lines.push(`        enabled: true`);

      if (c.required) lines.push(`        required: true`);
      if (c.notNull) lines.push(`        notNull: true`);
      if (c.minimum !== undefined) lines.push(`        minimum: ${c.minimum}`);
      if (c.maximum !== undefined) lines.push(`        maximum: ${c.maximum}`);
      if (c.minLength !== undefined) lines.push(`        minLength: ${c.minLength}`);
      if (c.maxLength !== undefined) lines.push(`        maxLength: ${c.maxLength}`);
      if (c.regex !== undefined) lines.push(`        regex: ${JSON.stringify(c.regex)}`);
      if (c.enum !== undefined) {
        lines.push(`        enum:`);
        for (const v of c.enum) {
          lines.push(`          - ${JSON.stringify(v)}`);
        }
      }
      if (c.minItems !== undefined) lines.push(`        minItems: ${c.minItems}`);
      if (c.maxItems !== undefined) lines.push(`        maxItems: ${c.maxItems}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}
