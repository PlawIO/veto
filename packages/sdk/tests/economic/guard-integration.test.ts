import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Veto } from '../../src/core/veto.js';

const TEST_DIR = '/tmp/veto-economic-guard-' + Date.now();
const VETO_DIR = join(TEST_DIR, 'veto');
const RULES_DIR = join(VETO_DIR, 'rules');

// Suppress console output during tests
vi.spyOn(console, 'info').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'debug').mockImplementation(() => {});

function writeConfig(opts: {
  economic?: object;
  rules?: boolean;
} = {}): void {
  const economicYaml = opts.economic
    ? `economic:\n${toYaml(opts.economic, 2)}`
    : '';

  writeFileSync(
    join(VETO_DIR, 'veto.config.yaml'),
    `
version: "1.0"
mode: "strict"
validation:
  mode: "local"
logging:
  level: "silent"
rules:
  directory: "./rules"
${economicYaml}
`,
    'utf-8',
  );
}

/** Minimal indented YAML serializer (handles the shapes we need). */
function toYaml(obj: unknown, indent: number): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(obj)) {
    return obj.map(item => {
      if (typeof item === 'object' && item !== null) {
        const lines = toYaml(item, indent + 2).split('\n').filter(Boolean);
        return `${pad}- ${lines[0].trim()}\n${lines.slice(1).map(l => `${pad}  ${l.trim()}`).join('\n')}`;
      }
      return `${pad}- ${item}`;
    }).join('\n');
  }
  if (typeof obj === 'object' && obj !== null) {
    return Object.entries(obj).map(([key, val]) => {
      if (typeof val === 'object' && val !== null) {
        return `${pad}${key}:\n${toYaml(val, indent + 2)}`;
      }
      return `${pad}${key}: ${JSON.stringify(val)}`;
    }).join('\n');
  }
  return `${pad}${obj}`;
}

function writeBlockRule(toolName: string): void {
  writeFileSync(
    join(RULES_DIR, `block-${toolName}.yaml`),
    `
version: "1.0"
name: block-${toolName}
rules:
  - id: block-${toolName}
    name: Block ${toolName}
    enabled: true
    action: block
    tools: [${toolName}]
    conditions:
      - field: arguments.blocked
        operator: equals
        value: true
`,
    'utf-8',
  );
}

const ECONOMIC_50_USD = {
  budgets: [
    { scope: 'session', limit: 50, currency: 'USD', window: 'session' },
  ],
  cost_extraction: { default: 'arguments.cost' },
};

describe('guard() with economic policies', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(RULES_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('allows guard() with explicit EconomicContext within budget', async () => {
    writeConfig({ economic: ECONOMIC_50_USD });
    const veto = await Veto.init({ configDir: VETO_DIR });

    const result = await veto.guard('pay_tool', { amount: 5 }, {
      economic: { cost: 5, currency: 'USD', protocol: 'custom' },
    });

    expect(result.decision).toBe('allow');
    expect(result.economicDenial).toBeUndefined();
  });

  it('denies guard() with EconomicContext exceeding budget', async () => {
    writeConfig({ economic: ECONOMIC_50_USD });
    const veto = await Veto.init({ configDir: VETO_DIR });

    const result = await veto.guard('pay_tool', { amount: 60 }, {
      economic: { cost: 60, currency: 'USD', protocol: 'custom' },
    });

    expect(result.decision).toBe('deny');
    expect(result.economicDenial).toBeDefined();
    expect(result.economicDenial!.reason).toBe('budget_exceeded');
  });

  it('allows when both behavioral rule and economic pass', async () => {
    writeConfig({ economic: ECONOMIC_50_USD });
    writeBlockRule('guarded_tool');
    const veto = await Veto.init({ configDir: VETO_DIR });

    // blocked=false so behavioral rule doesn't fire, cost within budget
    const result = await veto.guard('guarded_tool', { blocked: false, cost: 5 }, {
      economic: { cost: 5, currency: 'USD', protocol: 'custom' },
    });

    expect(result.decision).toBe('allow');
  });

  it('denies when behavioral rule denies even if economic allows', async () => {
    writeConfig({ economic: ECONOMIC_50_USD });
    writeBlockRule('guarded_tool');
    const veto = await Veto.init({ configDir: VETO_DIR });

    // blocked=true triggers behavioral deny, cost within budget
    const result = await veto.guard('guarded_tool', { blocked: true, cost: 5 }, {
      economic: { cost: 5, currency: 'USD', protocol: 'custom' },
    });

    expect(result.decision).toBe('deny');
    // Behavioral deny — no economicDenial
    expect(result.economicDenial).toBeUndefined();
  });

  it('denies when economic denies even if behavioral allows', async () => {
    writeConfig({ economic: ECONOMIC_50_USD });
    writeBlockRule('guarded_tool');
    const veto = await Veto.init({ configDir: VETO_DIR });

    // blocked=false so behavioral passes, but cost exceeds budget
    const result = await veto.guard('guarded_tool', { blocked: false, cost: 60 }, {
      economic: { cost: 60, currency: 'USD', protocol: 'custom' },
    });

    expect(result.decision).toBe('deny');
    expect(result.economicDenial).toBeDefined();
    expect(result.economicDenial!.reason).toBe('budget_exceeded');
  });

  it('resolves implicit cost from args via cost_extraction', async () => {
    writeConfig({ economic: ECONOMIC_50_USD });
    const veto = await Veto.init({ configDir: VETO_DIR });

    // No explicit EconomicContext — cost extracted from arguments.cost
    const result = await veto.guard('pay_tool', { cost: 60 });

    expect(result.decision).toBe('deny');
    expect(result.economicDenial).toBeDefined();
    expect(result.economicDenial!.reason).toBe('budget_exceeded');
  });

  it('accumulates budget through guard() and denies when exhausted', async () => {
    writeConfig({ economic: ECONOMIC_50_USD });
    const veto = await Veto.init({ configDir: VETO_DIR });

    // 5 calls at $10 each = $50 spent
    for (let i = 0; i < 5; i++) {
      const result = await veto.guard('pay_tool', { cost: 10 }, {
        economic: { cost: 10, currency: 'USD', protocol: 'custom' },
      });
      expect(result.decision).toBe('allow');
    }

    // 6th call should be denied — budget exhausted
    const denied = await veto.guard('pay_tool', { cost: 10 }, {
      economic: { cost: 10, currency: 'USD', protocol: 'custom' },
    });
    expect(denied.decision).toBe('deny');
    expect(denied.economicDenial).toBeDefined();
    expect(denied.economicDenial!.reason).toBe('budget_exceeded');
  });

  it('getEconomicBudgetStatus() returns correct state after guard() calls', async () => {
    writeConfig({ economic: ECONOMIC_50_USD });
    const veto = await Veto.init({ configDir: VETO_DIR });

    // Initially empty
    const before = veto.getEconomicBudgetStatus('session');
    expect(before).not.toBeNull();
    expect(before!.spent).toBe(0);
    expect(before!.limit).toBe(50);
    expect(before!.remaining).toBe(50);

    // Spend $15
    await veto.guard('pay_tool', { cost: 15 }, {
      economic: { cost: 15, currency: 'USD', protocol: 'custom' },
    });

    const after = veto.getEconomicBudgetStatus('session');
    expect(after!.spent).toBe(15);
    expect(after!.remaining).toBe(35);
  });

  it('resetEconomicBudget() resets and allows previously-blocked calls', async () => {
    writeConfig({ economic: ECONOMIC_50_USD });
    const veto = await Veto.init({ configDir: VETO_DIR });

    // Exhaust the budget
    await veto.guard('pay_tool', { cost: 45 }, {
      economic: { cost: 45, currency: 'USD', protocol: 'custom' },
    });
    const denied = await veto.guard('pay_tool', { cost: 10 }, {
      economic: { cost: 10, currency: 'USD', protocol: 'custom' },
    });
    expect(denied.decision).toBe('deny');

    // Reset
    veto.resetEconomicBudget('session');

    const status = veto.getEconomicBudgetStatus('session');
    expect(status!.spent).toBe(0);
    expect(status!.remaining).toBe(50);

    // Same call now succeeds
    const allowed = await veto.guard('pay_tool', { cost: 10 }, {
      economic: { cost: 10, currency: 'USD', protocol: 'custom' },
    });
    expect(allowed.decision).toBe('allow');
  });

  it('getEconomicBudgetStatus() returns null when no economic policy configured', async () => {
    writeConfig();
    const veto = await Veto.init({ configDir: VETO_DIR });

    expect(veto.getEconomicBudgetStatus()).toBeNull();
  });
});
