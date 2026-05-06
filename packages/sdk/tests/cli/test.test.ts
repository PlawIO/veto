import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  test as vetoTest,
  GapAnalyzer,
  UncoveredToolAnalyzer,
  SplittingAttackAnalyzer,
  UncheckedFieldAnalyzer,
  RegexBypassAnalyzer,
  CrossToolAnalyzer,
  TypeCoercionAnalyzer,
  loadRuleSets,
  type ParsedRule,
} from '../../src/cli/test.js';

const TEST_DIR = '/tmp/veto-test-cmd-' + Date.now();

function makeRule(overrides: Partial<ParsedRule> = {}): ParsedRule {
  return {
    id: 'test-rule',
    name: 'Test Rule',
    enabled: true,
    severity: 'medium',
    action: 'block',
    tools: [],
    conditions: [],
    conditionGroups: [],
    ...overrides,
  };
}

describe('veto test', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('test command', () => {
    it('should fail when policy directory does not exist', async () => {
      const result = await vetoTest({
        policy: join(TEST_DIR, 'nonexistent'),
        quiet: true,
      });
      expect(result.success).toBe(false);
      expect(result.report.rulesLoaded).toBe(0);
    });

    it('should succeed with empty policy directory', async () => {
      const result = await vetoTest({ policy: TEST_DIR, quiet: true });
      expect(result.success).toBe(true);
      expect(result.report.gaps).toHaveLength(0);
    });

    it('should load and analyze YAML rules', async () => {
      writeFileSync(
        join(TEST_DIR, 'rules.yaml'),
        `version: "1.0"
name: test-rules
rules:
  - id: block-path
    name: Block paths
    action: block
    tools:
      - read_file
    conditions:
      - field: arguments.path
        operator: starts_with
        value: /etc
`,
        'utf-8'
      );

      const result = await vetoTest({ policy: TEST_DIR, quiet: true });
      expect(result.report.rulesLoaded).toBe(1);
      expect(result.report.toolsCovered).toContain('read_file');
    });

    it('should write JSON output file', async () => {
      writeFileSync(
        join(TEST_DIR, 'rules.yaml'),
        `version: "1.0"
name: test-rules
rules:
  - id: r1
    name: Rule 1
    action: block
    tools: [read_file]
    conditions:
      - field: arguments.path
        operator: starts_with
        value: /etc
`,
        'utf-8'
      );

      const outputPath = join(TEST_DIR, 'report.json');
      await vetoTest({ policy: TEST_DIR, output: outputPath, quiet: true });

      expect(existsSync(outputPath)).toBe(true);
    });

    it('should exit code 1 on critical gaps', async () => {
      writeFileSync(
        join(TEST_DIR, 'rules.yaml'),
        `version: "1.0"
name: test-rules
rules:
  - id: limit-amount
    name: Limit amount
    action: block
    tools: [send_money]
    conditions:
      - field: arguments.amount
        operator: less_than
        value: 1000
`,
        'utf-8'
      );

      const result = await vetoTest({ policy: TEST_DIR, quiet: true });
      expect(result.success).toBe(false);
      expect(result.report.summary.critical).toBeGreaterThan(0);
    });
  });

  describe('loadRuleSets', () => {
    it('should return empty array for nonexistent directory', () => {
      const result = loadRuleSets('/tmp/does-not-exist-' + Date.now());
      expect(result).toHaveLength(0);
    });

    it('should load YAML files recursively', () => {
      const subDir = join(TEST_DIR, 'sub');
      mkdirSync(subDir, { recursive: true });

      writeFileSync(
        join(TEST_DIR, 'top.yaml'),
        `version: "1.0"\nname: top\nrules:\n  - id: r1\n    name: Rule 1\n    action: block\n`,
        'utf-8'
      );
      writeFileSync(
        join(subDir, 'nested.yaml'),
        `version: "1.0"\nname: nested\nrules:\n  - id: r2\n    name: Rule 2\n    action: block\n`,
        'utf-8'
      );

      const result = loadRuleSets(TEST_DIR);
      expect(result).toHaveLength(2);
      expect(result.flatMap(rs => rs.rules)).toHaveLength(2);
    });

    it('should reject invalid YAML files', () => {
      writeFileSync(join(TEST_DIR, 'bad.yaml'), '{{invalid yaml', 'utf-8');
      writeFileSync(
        join(TEST_DIR, 'good.yaml'),
        `version: "1.0"\nname: good\nrules:\n  - id: r1\n    name: Rule 1\n    action: block\n`,
        'utf-8'
      );

      expect(() => loadRuleSets(TEST_DIR)).toThrow('Invalid policy file');
    });

    it('should not follow symlink loops during YAML discovery', () => {
      const subDir = join(TEST_DIR, 'sub');
      mkdirSync(subDir, { recursive: true });
      symlinkSync(TEST_DIR, join(subDir, 'loop'), 'dir');
      writeFileSync(
        join(TEST_DIR, 'rules.yaml'),
        `version: "1.0"\nname: rules\nrules:\n  - id: r1\n    name: Rule 1\n    action: block\n`,
        'utf-8'
      );

      const result = loadRuleSets(TEST_DIR);
      expect(result).toHaveLength(1);
    });

    it('test command should fail on invalid YAML files', async () => {
      writeFileSync(join(TEST_DIR, 'bad.yaml'), '{{invalid yaml', 'utf-8');

      const result = await vetoTest({ policy: TEST_DIR, quiet: true });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid policy file');
    });
  });

  describe('UncoveredToolAnalyzer', () => {
    const analyzer = new UncoveredToolAnalyzer();

    it('should flag tools without blocking rules', () => {
      const rules = [
        makeRule({ tools: ['read_file'], action: 'block' }),
        makeRule({ tools: ['write_file'], action: 'log' }),
      ];

      const gaps = analyzer.analyze(rules, ['read_file', 'write_file']);
      expect(gaps).toHaveLength(1);
      expect(gaps[0].tool).toBe('write_file');
      expect(gaps[0].severity).toBe('warning');
    });

    it('should return no gaps when all tools have block rules', () => {
      const rules = [
        makeRule({ tools: ['read_file'], action: 'block' }),
        makeRule({ tools: ['write_file'], action: 'block' }),
      ];

      const gaps = analyzer.analyze(rules, ['read_file', 'write_file']);
      expect(gaps).toHaveLength(0);
    });

    it('should return no gaps when a global block rule exists', () => {
      const rules = [
        makeRule({ tools: [], action: 'block' }),
      ];

      const gaps = analyzer.analyze(rules, ['read_file', 'write_file']);
      expect(gaps).toHaveLength(0);
    });

    it('should skip disabled rules', () => {
      const rules = [
        makeRule({ tools: ['read_file'], action: 'block', enabled: false }),
      ];

      const gaps = analyzer.analyze(rules, ['read_file']);
      expect(gaps).toHaveLength(1);
    });
  });

  describe('SplittingAttackAnalyzer', () => {
    const analyzer = new SplittingAttackAnalyzer();

    it('should flag numeric less_than limits', () => {
      const rules = [
        makeRule({
          id: 'limit-amount',
          tools: ['send_money'],
          conditions: [
            { field: 'arguments.amount', operator: 'less_than', value: 1000 },
          ],
        }),
      ];

      const gaps = analyzer.analyze(rules, ['send_money']);
      expect(gaps).toHaveLength(1);
      expect(gaps[0].severity).toBe('critical');
      expect(gaps[0].title).toContain('split across calls');
    });

    it('should flag numeric greater_than limits as warning for non-sensitive fields', () => {
      const rules = [
        makeRule({
          conditions: [
            { field: 'arguments.count', operator: 'greater_than', value: 10 },
          ],
        }),
      ];

      const gaps = analyzer.analyze(rules, []);
      expect(gaps).toHaveLength(1);
      expect(gaps[0].severity).toBe('warning');
    });

    it('should flag sensitive fields as critical', () => {
      const rules = [
        makeRule({
          id: 'limit-balance',
          tools: ['transfer'],
          conditions: [
            { field: 'arguments.balance', operator: 'less_than', value: 5000 },
          ],
        }),
      ];

      const gaps = analyzer.analyze(rules, ['transfer']);
      expect(gaps).toHaveLength(1);
      expect(gaps[0].severity).toBe('critical');
    });

    it('should not flag non-numeric operators', () => {
      const rules = [
        makeRule({
          conditions: [
            { field: 'arguments.path', operator: 'starts_with', value: '/etc' },
          ],
        }),
      ];

      const gaps = analyzer.analyze(rules, []);
      expect(gaps).toHaveLength(0);
    });

    it('should not flag string values with numeric operators', () => {
      const rules = [
        makeRule({
          conditions: [
            { field: 'arguments.amount', operator: 'less_than', value: 'high' },
          ],
        }),
      ];

      const gaps = analyzer.analyze(rules, []);
      expect(gaps).toHaveLength(0);
    });

    it('should check condition_groups too', () => {
      const rules = [
        makeRule({
          conditionGroups: [
            [{ field: 'arguments.amount', operator: 'less_than', value: 500 }],
          ],
        }),
      ];

      const gaps = analyzer.analyze(rules, []);
      expect(gaps).toHaveLength(1);
    });
  });

  describe('UncheckedFieldAnalyzer', () => {
    const analyzer = new UncheckedFieldAnalyzer();

    it('should flag unchecked fields on known tools', () => {
      const rules = [
        makeRule({
          tools: ['send_email'],
          conditions: [
            { field: 'arguments.to', operator: 'matches', value: '@company.com$' },
          ],
        }),
      ];

      const gaps = analyzer.analyze(rules, ['send_email']);
      const flaggedFields = gaps.map(g => g.field);
      expect(flaggedFields).toContain('cc');
      expect(flaggedFields).toContain('bcc');
      expect(flaggedFields).toContain('body');
      expect(flaggedFields).not.toContain('to');
    });

    it('should not flag tools without known sensitive fields', () => {
      const rules = [
        makeRule({
          tools: ['custom_tool'],
          conditions: [
            { field: 'arguments.x', operator: 'equals', value: 'y' },
          ],
        }),
      ];

      const gaps = analyzer.analyze(rules, ['custom_tool']);
      expect(gaps).toHaveLength(0);
    });

    it('should handle arguments. prefix stripping', () => {
      const rules = [
        makeRule({
          tools: ['execute_command'],
          conditions: [
            { field: 'arguments.command', operator: 'contains', value: 'safe' },
            { field: 'arguments.args', operator: 'equals', value: '' },
            { field: 'arguments.cwd', operator: 'equals', value: '/home' },
            { field: 'arguments.env', operator: 'equals', value: '{}' },
          ],
        }),
      ];

      const gaps = analyzer.analyze(rules, ['execute_command']);
      expect(gaps).toHaveLength(0);
    });
  });

  describe('RegexBypassAnalyzer', () => {
    const analyzer = new RegexBypassAnalyzer();

    it('should flag regex patterns without anchors', () => {
      const rules = [
        makeRule({
          id: 'email-check',
          conditions: [
            { field: 'arguments.to', operator: 'matches', value: '@company\\.com' },
          ],
        }),
      ];

      const gaps = analyzer.analyze(rules, []);
      const anchorGap = gaps.find(g => g.title.includes('missing anchors'));
      expect(anchorGap).toBeDefined();
      expect(anchorGap!.severity).toBe('warning');
    });

    it('should not flag fully anchored patterns', () => {
      const rules = [
        makeRule({
          conditions: [
            { field: 'arguments.to', operator: 'matches', value: '^.*@company\\.com$' },
          ],
        }),
      ];

      const gaps = analyzer.analyze(rules, []);
      const anchorGap = gaps.find(g => g.title.includes('missing anchors'));
      expect(anchorGap).toBeUndefined();
    });

    it('should flag domain regex vulnerable to subdomain bypass', () => {
      const rules = [
        makeRule({
          id: 'domain-check',
          conditions: [
            { field: 'arguments.url', operator: 'matches', value: 'example\\.com' },
          ],
        }),
      ];

      const gaps = analyzer.analyze(rules, []);
      const domainGap = gaps.find(g => g.title.includes('subdomain bypass'));
      expect(domainGap).toBeDefined();
      expect(domainGap!.severity).toBe('critical');
    });

    it('should flag starts_with domain checks on allow rules', () => {
      const rules = [
        makeRule({
          id: 'url-allow',
          action: 'allow',
          conditions: [
            { field: 'arguments.url', operator: 'starts_with', value: 'https://api.example.com' },
          ],
        }),
      ];

      const gaps = analyzer.analyze(rules, []);
      expect(gaps.length).toBeGreaterThan(0);
      expect(gaps.some(g => g.title.includes('starts_with domain'))).toBe(true);
    });

    it('should flag short contains values', () => {
      const rules = [
        makeRule({
          id: 'rm-check',
          conditions: [
            { field: 'arguments.command', operator: 'contains', value: 'rm' },
          ],
        }),
      ];

      const gaps = analyzer.analyze(rules, []);
      const shortGap = gaps.find(g => g.title.includes('Short "contains"'));
      expect(shortGap).toBeDefined();
      expect(shortGap!.severity).toBe('info');
    });
  });

  describe('CrossToolAnalyzer', () => {
    const analyzer = new CrossToolAnalyzer();

    it('should flag dangerous tool combos without session constraints', () => {
      const rules = [
        makeRule({ tools: ['read_file'] }),
        makeRule({ tools: ['write_file'] }),
      ];

      const gaps = analyzer.analyze(rules, ['read_file', 'write_file']);
      expect(gaps.length).toBeGreaterThan(0);
      expect(gaps[0].title).toContain('cross-tool constraints');
    });

    it('should not flag combos when only one tool is present', () => {
      const rules = [makeRule({ tools: ['read_file'] })];

      const gaps = analyzer.analyze(rules, ['read_file']);
      expect(gaps).toHaveLength(0);
    });

    it('should not flag when session constraints exist', () => {
      const rules = [
        makeRule({
          tools: ['read_file'],
          conditions: [{ field: 'session.total_reads', operator: 'less_than', value: 10 }],
        }),
        makeRule({ tools: ['write_file'] }),
      ];

      const gaps = analyzer.analyze(rules, ['read_file', 'write_file']);
      expect(gaps).toHaveLength(0);
    });

    it('should flag http + read_file exfiltration combo', () => {
      const rules = [
        makeRule({ tools: ['http_request'] }),
        makeRule({ tools: ['read_file'] }),
      ];

      const gaps = analyzer.analyze(rules, ['http_request', 'read_file']);
      expect(gaps.length).toBeGreaterThan(0);
      expect(gaps.some(g => g.description.includes('exfiltrat'))).toBe(true);
    });
  });

  describe('TypeCoercionAnalyzer', () => {
    const analyzer = new TypeCoercionAnalyzer();

    it('should flag string values with numeric operators', () => {
      const rules = [
        makeRule({
          id: 'amount-check',
          conditions: [
            { field: 'arguments.amount', operator: 'less_than', value: '1000' },
          ],
        }),
      ];

      const gaps = analyzer.analyze(rules, []);
      const coercionGap = gaps.find(g => g.severity === 'critical');
      expect(coercionGap).toBeDefined();
      expect(coercionGap!.title).toContain('String value');
    });

    it('should flag numeric values on string-input fields', () => {
      const rules = [
        makeRule({
          id: 'param-check',
          conditions: [
            { field: 'arguments.query_param', operator: 'greater_than', value: 100 },
          ],
        }),
      ];

      const gaps = analyzer.analyze(rules, []);
      const infoGap = gaps.find(g => g.severity === 'info');
      expect(infoGap).toBeDefined();
      expect(infoGap!.title).toContain('may receive string input');
    });

    it('should not flag numeric values on non-string-input fields', () => {
      const rules = [
        makeRule({
          id: 'count-check',
          conditions: [
            { field: 'arguments.count', operator: 'greater_than', value: 100 },
          ],
        }),
      ];

      const gaps = analyzer.analyze(rules, []);
      const infoGap = gaps.find(g => g.severity === 'info');
      expect(infoGap).toBeUndefined();
    });

    it('should not flag non-numeric operators', () => {
      const rules = [
        makeRule({
          conditions: [
            { field: 'arguments.path', operator: 'equals', value: '/tmp' },
          ],
        }),
      ];

      const gaps = analyzer.analyze(rules, []);
      expect(gaps).toHaveLength(0);
    });

    it('should skip disabled rules', () => {
      const rules = [
        makeRule({
          enabled: false,
          conditions: [
            { field: 'arguments.amount', operator: 'less_than', value: '1000' },
          ],
        }),
      ];

      const gaps = analyzer.analyze(rules, []);
      expect(gaps).toHaveLength(0);
    });
  });

  describe('GapAnalyzer', () => {
    it('should run all analyzers by default', () => {
      const analyzer = new GapAnalyzer();
      const ruleSets = [
        {
          version: '1.0',
          name: 'test',
          sourceFile: 'test.yaml',
          rules: [
            makeRule({
              tools: ['send_email'],
              conditions: [
                { field: 'arguments.to', operator: 'matches', value: '@company\\.com' },
                { field: 'arguments.amount', operator: 'less_than', value: 1000 },
              ],
            }),
          ],
        },
      ];

      const gaps = analyzer.analyze(ruleSets);
      const analyzerNames = [...new Set(gaps.map(g => g.analyzer))];
      expect(analyzerNames.length).toBeGreaterThan(1);
    });

    it('should accept custom analyzers', () => {
      const customAnalyzer = {
        name: 'custom',
        analyze: () => [{
          analyzer: 'custom',
          severity: 'info' as const,
          title: 'Custom gap',
          description: 'Custom description',
          suggestedFix: 'Custom fix',
        }],
      };

      const analyzer = new GapAnalyzer([customAnalyzer]);
      const gaps = analyzer.analyze([{
        version: '1.0',
        name: 'test',
        sourceFile: 'test.yaml',
        rules: [makeRule()],
      }]);

      expect(gaps).toHaveLength(1);
      expect(gaps[0].analyzer).toBe('custom');
    });

    it('should collect tools from all rule sets', () => {
      const analyzer = new GapAnalyzer([new UncoveredToolAnalyzer()]);
      const ruleSets = [
        {
          version: '1.0',
          name: 'set1',
          sourceFile: 'set1.yaml',
          rules: [makeRule({ tools: ['tool_a'], action: 'block' })],
        },
        {
          version: '1.0',
          name: 'set2',
          sourceFile: 'set2.yaml',
          rules: [makeRule({ tools: ['tool_b'], action: 'log' })],
        },
      ];

      const gaps = analyzer.analyze(ruleSets);
      expect(gaps.some(g => g.tool === 'tool_b')).toBe(true);
    });
  });
});
