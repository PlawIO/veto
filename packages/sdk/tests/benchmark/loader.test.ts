import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadBenchmarkSamples } from '../../src/benchmark/loader.js';

const TEST_DIR = `/tmp/veto-benchmark-loader-${Date.now()}`;

function writeDatasetFile(relativePath: string, lines: string[]): string {
  const absolutePath = join(TEST_DIR, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, lines.join('\n') + '\n', 'utf-8');
  return absolutePath;
}

function buildTrainingLine(options: {
  tool: string;
  args: string[];
  rules: string[];
  assistant: string;
}): string {
  return JSON.stringify({
    messages: [
      {
        role: 'system',
        content: 'system prompt',
      },
      {
        role: 'user',
        content: [
          'TOOL CALL:',
          `tool: ${options.tool}`,
          'arguments:',
          ...options.args,
          '',
          'RULES:',
          ...options.rules,
        ].join('\n'),
      },
      {
        role: 'assistant',
        content: options.assistant,
      },
    ],
  });
}

describe('loadBenchmarkSamples', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it('parses valid JSONL examples and preserves empty inline tool arrays', async () => {
    writeDatasetFile('data/batches/general/global-rule.jsonl', [
      buildTrainingLine({
        tool: 'read_file',
        args: [
          '  path: "/tmp/report.csv"',
          '  row_limit: null',
          '  include_headers: true',
          '  tags: [finance, internal]',
        ],
        rules: [
          '- id: global-approval',
          '  name: Global approval gate',
          '  enabled: true',
          '  severity: medium',
          '  action: block',
          '  tools: []',
          '  conditions:',
          '    - field: arguments.path',
          '      operator: starts_with',
          '      value: "/tmp/"',
        ],
        assistant: '{"pass_weight":0.1,"block_weight":0.9,"decision":"block","reasoning":"blocked"}',
      }),
    ]);

    const samples = await loadBenchmarkSamples(join(TEST_DIR, 'data', 'batches', '**/*.jsonl'));

    expect(samples).toHaveLength(1);
    expect(samples[0]?.tool).toBe('read_file');
    expect(samples[0]?.arguments).toEqual({
      path: '/tmp/report.csv',
      row_limit: null,
      include_headers: true,
      tags: ['finance', 'internal'],
    });
    expect(samples[0]?.rules).toHaveLength(1);
    expect(samples[0]?.rules[0]?.tools).toEqual([]);
    expect(samples[0]?.category).toBe('general/global-rule');
    expect(samples[0]?.expectedDecision).toBe('block');
  });

  it('applies maxSamples after deterministic shuffling when a seed is provided', async () => {
    writeDatasetFile('data/batches/finance/seeded.jsonl', [
      buildTrainingLine({
        tool: 'tool_a',
        args: ['  amount: 10'],
        rules: ['- id: rule-a', '  name: Rule A', '  enabled: true', '  severity: low', '  action: block'],
        assistant: '{"pass_weight":0.9,"block_weight":0.1,"decision":"pass","reasoning":"a"}',
      }),
      buildTrainingLine({
        tool: 'tool_b',
        args: ['  amount: 20'],
        rules: ['- id: rule-b', '  name: Rule B', '  enabled: true', '  severity: low', '  action: block'],
        assistant: '{"pass_weight":0.8,"block_weight":0.2,"decision":"pass","reasoning":"b"}',
      }),
      buildTrainingLine({
        tool: 'tool_c',
        args: ['  amount: 30'],
        rules: ['- id: rule-c', '  name: Rule C', '  enabled: true', '  severity: low', '  action: block'],
        assistant: '{"pass_weight":0.7,"block_weight":0.3,"decision":"pass","reasoning":"c"}',
      }),
    ]);

    const pattern = join(TEST_DIR, 'data', 'batches', '**/*.jsonl');
    const first = await loadBenchmarkSamples(pattern, 2, true, 42);
    const second = await loadBenchmarkSamples(pattern, 2, true, 42);

    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(first.map((sample) => sample.tool)).toEqual(second.map((sample) => sample.tool));
  });
});
