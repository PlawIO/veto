import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  compile,
  parseAndValidateLLMOutput,
  toYaml,
  buildUserPrompt,
  CompileError,
} from '../../src/cli/compile.js';

const TEST_DIR = '/tmp/veto-compile-test-' + Date.now();

const VALID_LLM_RESPONSE = JSON.stringify({
  rules: [
    {
      id: 'block-external-emails',
      name: 'Block external emails',
      description: 'Prevent sending emails outside the company domain',
      enabled: true,
      severity: 'high',
      action: 'block',
      tools: ['send_email'],
      conditions: [
        {
          field: 'arguments.to',
          operator: 'not_contains',
          value: '@company.com',
        },
      ],
    },
  ],
  notes: '',
});

const MULTI_RULE_RESPONSE = JSON.stringify({
  rules: [
    {
      id: 'block-large-transfers',
      name: 'Block large transfers',
      description: 'Block fund transfers over $10,000',
      enabled: true,
      severity: 'critical',
      action: 'block',
      tools: ['transfer_funds'],
      conditions: [
        {
          field: 'arguments.amount',
          operator: 'greater_than',
          value: 10000,
        },
      ],
    },
    {
      id: 'block-international-transfers',
      name: 'Block international transfers',
      description: 'Block transfers to non-US countries',
      enabled: true,
      severity: 'high',
      action: 'block',
      tools: ['transfer_funds'],
      conditions: [
        {
          field: 'arguments.country',
          operator: 'not_in',
          value: ['US', 'USA'],
        },
      ],
    },
  ],
  notes: 'Currency conversion policies may need LLM-based evaluation.',
});

describe('compile', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('parseAndValidateLLMOutput', () => {
    it('should parse valid LLM response', () => {
      const output = parseAndValidateLLMOutput(VALID_LLM_RESPONSE);
      expect(output.rules).toHaveLength(1);
      expect(output.rules[0].id).toBe('block-external-emails');
      expect(output.rules[0].action).toBe('block');
      expect(output.notes).toBe('');
    });

    it('should parse multi-rule response', () => {
      const output = parseAndValidateLLMOutput(MULTI_RULE_RESPONSE);
      expect(output.rules).toHaveLength(2);
      expect(output.notes).toContain('Currency conversion');
    });

    it('should extract JSON from surrounding text', () => {
      const wrapped = `Here is the result:\n${VALID_LLM_RESPONSE}\nDone.`;
      const output = parseAndValidateLLMOutput(wrapped);
      expect(output.rules).toHaveLength(1);
    });

    it('should reject response without JSON', () => {
      expect(() => parseAndValidateLLMOutput('no json here')).toThrow(
        CompileError
      );
    });

    it('should reject invalid JSON', () => {
      expect(() => parseAndValidateLLMOutput('{invalid json}')).toThrow(
        CompileError
      );
    });

    it('should reject missing rules array', () => {
      expect(() =>
        parseAndValidateLLMOutput(JSON.stringify({ notes: 'no rules' }))
      ).toThrow('missing "rules" array');
    });

    it('should reject rule without id', () => {
      const bad = JSON.stringify({
        rules: [{ name: 'test', action: 'block' }],
      });
      expect(() => parseAndValidateLLMOutput(bad)).toThrow('missing "id"');
    });

    it('should reject rule with invalid action', () => {
      const bad = JSON.stringify({
        rules: [{ id: 'test', name: 'test', action: 'destroy' }],
      });
      expect(() => parseAndValidateLLMOutput(bad)).toThrow('invalid action');
    });

    it('should accept require_approval action', () => {
      const output = parseAndValidateLLMOutput(JSON.stringify({
        rules: [{ id: 'test', name: 'test', action: 'require_approval' }],
        notes: '',
      }));
      expect(output.rules[0].action).toBe('require_approval');
    });

    it('should reject rule with invalid severity', () => {
      const bad = JSON.stringify({
        rules: [
          { id: 'test', name: 'test', action: 'block', severity: 'extreme' },
        ],
      });
      expect(() => parseAndValidateLLMOutput(bad)).toThrow('invalid severity');
    });

    it('should reject rule with invalid operator', () => {
      const bad = JSON.stringify({
        rules: [
          {
            id: 'test',
            name: 'test',
            action: 'block',
            conditions: [
              { field: 'arguments.x', operator: 'like', value: 'foo' },
            ],
          },
        ],
      });
      expect(() => parseAndValidateLLMOutput(bad)).toThrow('invalid operator');
    });
  });

  describe('toYaml', () => {
    it('should produce valid YAML', () => {
      const output = parseAndValidateLLMOutput(VALID_LLM_RESPONSE);
      const yaml = toYaml(output, 'Block external emails');
      const parsed = parseYaml(yaml);

      expect(parsed.version).toBe('1.0');
      expect(parsed.name).toBe('compiled-rules');
      expect(parsed.rules).toHaveLength(1);
      expect(parsed.rules[0].id).toBe('block-external-emails');
    });

    it('should truncate long descriptions', () => {
      const longPolicy = 'x'.repeat(200);
      const output = parseAndValidateLLMOutput(VALID_LLM_RESPONSE);
      const yaml = toYaml(output, longPolicy);
      const parsed = parseYaml(yaml);

      expect(parsed.description.length).toBeLessThan(200);
      expect(parsed.description).toContain('...');
    });
  });

  describe('buildUserPrompt', () => {
    it('should include policy text', () => {
      const prompt = buildUserPrompt('No emails outside company');
      expect(prompt).toContain('No emails outside company');
    });
  });

  describe('compile (integration with mocked LLM)', () => {
    it('should fail without --input or --file', async () => {
      const result = await compile({
        output: join(TEST_DIR, 'out.yaml'),
        quiet: true,
      });
      expect(result.success).toBe(false);
      expect(result.messages).toContain('Provide --input or --file');
    });

    it('should fail with nonexistent file', async () => {
      const result = await compile({
        file: join(TEST_DIR, 'missing.txt'),
        output: join(TEST_DIR, 'out.yaml'),
        quiet: true,
      });
      expect(result.success).toBe(false);
      expect(result.messages[0]).toContain('File not found');
    });

    it('should fail with empty policy text', async () => {
      const filePath = join(TEST_DIR, 'empty.txt');
      writeFileSync(filePath, '', 'utf-8');
      const result = await compile({
        file: filePath,
        output: join(TEST_DIR, 'out.yaml'),
        quiet: true,
      });
      expect(result.success).toBe(false);
      expect(result.messages).toContain('Policy text is empty');
    });

    it('should fail without API key', async () => {
      const origKey = process.env.OPENAI_API_KEY;
      const origAnthropicKey = process.env.ANTHROPIC_API_KEY;
      const origGeminiKey = process.env.GEMINI_API_KEY;
      const origOpenRouterKey = process.env.OPENROUTER_API_KEY;

      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENROUTER_API_KEY;

      try {
        const result = await compile({
          input: 'Block external emails',
          output: join(TEST_DIR, 'out.yaml'),
          quiet: true,
        });
        expect(result.success).toBe(false);
        expect(result.messages[0]).toContain('No LLM provider configured');
      } finally {
        if (origKey) process.env.OPENAI_API_KEY = origKey;
        if (origAnthropicKey) process.env.ANTHROPIC_API_KEY = origAnthropicKey;
        if (origGeminiKey) process.env.GEMINI_API_KEY = origGeminiKey;
        if (origOpenRouterKey)
          process.env.OPENROUTER_API_KEY = origOpenRouterKey;
      }
    });

    it('should write YAML file with mocked OpenAI', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: VALID_LLM_RESPONSE } }],
      });

      vi.doMock('openai', () => ({
        default: class {
          chat = { completions: { create: mockCreate } };
        },
      }));

      process.env.OPENAI_API_KEY = 'test-key';

      try {
        const outputPath = join(TEST_DIR, 'email.yaml');
        const result = await compile({
          input: 'Block emails outside company domain',
          output: outputPath,
          provider: 'openai',
          quiet: true,
        });

        expect(result.success).toBe(true);
        expect(result.outputPath).toBe(outputPath);
        expect(existsSync(outputPath)).toBe(true);

        const content = readFileSync(outputPath, 'utf-8');
        const parsed = parseYaml(content);
        expect(parsed.version).toBe('1.0');
        expect(parsed.rules[0].id).toBe('block-external-emails');
      } finally {
        vi.doUnmock('openai');
        delete process.env.OPENAI_API_KEY;
      }
    });

    it('should write to directory with auto-generated filename', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: VALID_LLM_RESPONSE } }],
      });

      vi.doMock('openai', () => ({
        default: class {
          chat = { completions: { create: mockCreate } };
        },
      }));

      process.env.OPENAI_API_KEY = 'test-key';

      try {
        const policyFile = join(TEST_DIR, 'my-policies.txt');
        writeFileSync(
          policyFile,
          'Block emails outside company domain',
          'utf-8'
        );

        const outDir = join(TEST_DIR, 'rules');
        const result = await compile({
          file: policyFile,
          output: outDir,
          provider: 'openai',
          quiet: true,
        });

        expect(result.success).toBe(true);
        expect(result.outputPath).toBe(join(outDir, 'my-policies.yaml'));
        expect(existsSync(join(outDir, 'my-policies.yaml'))).toBe(true);
      } finally {
        vi.doUnmock('openai');
        delete process.env.OPENAI_API_KEY;
      }
    });

    it('should include notes in result messages', async () => {
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: MULTI_RULE_RESPONSE } }],
      });

      vi.doMock('openai', () => ({
        default: class {
          chat = { completions: { create: mockCreate } };
        },
      }));

      process.env.OPENAI_API_KEY = 'test-key';

      try {
        const result = await compile({
          input: 'Block large and international transfers',
          output: join(TEST_DIR, 'transfers.yaml'),
          provider: 'openai',
          quiet: true,
        });

        expect(result.success).toBe(true);
        expect(result.messages).toContain(
          'Currency conversion policies may need LLM-based evaluation.'
        );

        const content = readFileSync(result.outputPath!, 'utf-8');
        const parsed = parseYaml(content);
        expect(parsed.rules).toHaveLength(2);
      } finally {
        vi.doUnmock('openai');
        delete process.env.OPENAI_API_KEY;
      }
    });
  });
});
