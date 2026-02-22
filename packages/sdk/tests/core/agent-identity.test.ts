import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Veto } from '../../src/core/veto.js';
import type { ValidationContext, ValidationResult } from '../../src/types/config.js';

const TEST_DIR = '/tmp/veto-agent-identity-' + Date.now();
const VETO_DIR = join(TEST_DIR, 'veto');
const RULES_DIR = join(VETO_DIR, 'rules');

function writeLocalConfig(): void {
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
`,
    'utf-8'
  );
}

function writeRules(content: string): void {
  writeFileSync(join(RULES_DIR, 'rules.yaml'), content, 'utf-8');
}

describe('agent identity and role scoping', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(RULES_DIR, { recursive: true });
    writeLocalConfig();
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it('applies rules scoped to specific agent IDs', async () => {
    writeRules(
      `
version: "1.0"
rules:
  - id: scoped-agents
    name: Scoped by agent list
    action: block
    tools: [deploy]
    agents:
      - agent-a
      - agent-b
`
    );

    const veto = await Veto.init({
      configDir: VETO_DIR,
      agentId: 'agent-a',
    });

    const matchingAgentResult = await veto.guard('deploy', {});
    const nonMatchingAgentResult = await veto.guard('deploy', {}, { agentId: 'agent-c' });

    expect(matchingAgentResult.decision).toBe('deny');
    expect(matchingAgentResult.ruleId).toBe('scoped-agents');
    expect(nonMatchingAgentResult.decision).toBe('allow');
  });

  it('supports agents.not exclusion syntax', async () => {
    writeRules(
      `
version: "1.0"
rules:
  - id: exclude-agents
    name: Exclude specific agents
    action: block
    tools: [deploy]
    agents:
      not:
        - agent-internal
`
    );

    const veto = await Veto.init({
      configDir: VETO_DIR,
      agentId: 'agent-internal',
    });

    const excludedAgentResult = await veto.guard('deploy', {});
    const includedAgentResult = await veto.guard('deploy', {}, { agentId: 'agent-external' });

    expect(excludedAgentResult.decision).toBe('allow');
    expect(includedAgentResult.decision).toBe('deny');
    expect(includedAgentResult.ruleId).toBe('exclude-agents');
  });

  it('applies rules without agents scope to everyone', async () => {
    writeRules(
      `
version: "1.0"
rules:
  - id: no-agent-scope
    name: Applies to everyone
    action: block
    tools: [deploy]
`
    );

    const veto = await Veto.init({
      configDir: VETO_DIR,
      agentId: 'agent-a',
    });

    const defaultAgentResult = await veto.guard('deploy', {});
    const overrideAgentResult = await veto.guard('deploy', {}, { agentId: 'agent-b' });

    expect(defaultAgentResult.decision).toBe('deny');
    expect(defaultAgentResult.ruleId).toBe('no-agent-scope');
    expect(overrideAgentResult.decision).toBe('deny');
    expect(overrideAgentResult.ruleId).toBe('no-agent-scope');
  });

  it('combines agents scope with existing conditions', async () => {
    writeRules(
      `
version: "1.0"
rules:
  - id: scoped-high-value
    name: Block high-value transfer for scoped agent
    action: block
    tools: [transfer_funds]
    agents:
      - ops-agent
    conditions:
      - field: arguments.amount
        operator: greater_than
        value: 1000
`
    );

    const veto = await Veto.init({
      configDir: VETO_DIR,
      agentId: 'ops-agent',
    });

    const lowValueForScopedAgent = await veto.guard('transfer_funds', { amount: 100 });
    const highValueForScopedAgent = await veto.guard('transfer_funds', { amount: 5000 });
    const highValueForOtherAgent = await veto.guard(
      'transfer_funds',
      { amount: 5000 },
      { agentId: 'support-agent' }
    );

    expect(lowValueForScopedAgent.decision).toBe('allow');
    expect(highValueForScopedAgent.decision).toBe('deny');
    expect(highValueForScopedAgent.ruleId).toBe('scoped-high-value');
    expect(highValueForOtherAgent.decision).toBe('allow');
  });

  it('exposes agentId, userId, and role in ValidationContext for custom validators', async () => {
    const observed: Array<Pick<ValidationContext, 'agentId' | 'userId' | 'role'>> = [];
    const contextProbe = {
      name: 'context-probe',
      validate: (context: ValidationContext): ValidationResult => {
        observed.push({
          agentId: context.agentId,
          userId: context.userId,
          role: context.role,
        });
        return { decision: 'allow' };
      },
    };

    const veto = await Veto.init({
      configDir: VETO_DIR,
      agentId: 'agent-default',
      userId: 'user-default',
      role: 'analyst',
      validators: [contextProbe],
    });

    const wrapped = veto.wrap([
      {
        name: 'status_check',
        handler: async () => 'ok',
        inputSchema: { type: 'object' },
      },
    ]);

    await wrapped[0].handler({});
    await veto.guard('status_check', {}, {
      agentId: 'agent-override',
      userId: 'user-override',
      role: 'admin',
    });

    expect(observed[0]).toEqual({
      agentId: 'agent-default',
      userId: 'user-default',
      role: 'analyst',
    });
    expect(observed[1]).toEqual({
      agentId: 'agent-override',
      userId: 'user-override',
      role: 'admin',
    });
  });
});
