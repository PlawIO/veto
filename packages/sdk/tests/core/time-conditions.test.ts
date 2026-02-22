import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Veto } from '../../src/core/veto.js';

const TEST_DIR = '/tmp/veto-time-conditions-' + Date.now();
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

function writeRuleFile(content: string): void {
  writeFileSync(join(RULES_DIR, 'policy.yaml'), content, 'utf-8');
}

describe('Local Time Conditions', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(RULES_DIR, { recursive: true });
    writeLocalConfig();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it('blocks tool calls when outside_hours matches', async () => {
    writeRuleFile(
      `
version: "1.0"
rules:
  - id: block-off-hours
    name: Block outside business hours
    action: block
    tools: [wire_transfer]
    conditions:
      - field: context.time
        operator: outside_hours
        value:
          start: "09:00"
          end: "17:00"
          timezone: "UTC"
`
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-06T22:00:00.000Z'));

    const veto = await Veto.init({ configDir: VETO_DIR });
    const result = await veto.guard('wire_transfer', { amount: 1500 });

    expect(result).toMatchObject({
      decision: 'deny',
      ruleId: 'block-off-hours',
    });
  });

  it('allows tool calls when within_hours allow rule matches', async () => {
    writeRuleFile(
      `
version: "1.0"
rules:
  - id: block-off-hours
    name: Block outside business hours
    action: block
    tools: [wire_transfer]
    conditions:
      - field: context.time
        operator: outside_hours
        value:
          start: "09:00"
          end: "17:00"
          timezone: "UTC"

  - id: allow-work-hours
    name: Allow during business hours
    action: allow
    tools: [wire_transfer]
    conditions:
      - field: context.time
        operator: within_hours
        value:
          start: "09:00"
          end: "17:00"
          timezone: "UTC"
`
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-06T10:00:00.000Z'));

    const veto = await Veto.init({ configDir: VETO_DIR });
    const result = await veto.guard('wire_transfer', { amount: 1500 });

    expect(result).toMatchObject({
      decision: 'allow',
      ruleId: 'allow-work-hours',
    });
  });
});
