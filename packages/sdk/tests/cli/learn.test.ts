import { describe, it, expect, beforeEach } from 'vitest';
import {
  Observer,
  PolicyGenerator,
  parseDuration,
  policiesToYaml,
} from '../../src/cli/learn.js';
import type { ToolObservation, ArgumentObservation, GeneratedPolicy } from '../../src/cli/learn.js';

function makeArgObs(overrides: Partial<ArgumentObservation> & { name: string }): ArgumentObservation {
  return {
    types: new Set(),
    numericValues: [],
    stringValues: [],
    arrayLengths: [],
    presentCount: 0,
    totalCalls: 0,
    nullCount: 0,
    ...overrides,
  };
}

describe('Observer', () => {
  describe('stop conditions', () => {
    it('should stop after N runs', () => {
      const observer = new Observer({ runs: 3 });
      observer.start();

      observer.recordRaw('tool_a', { x: 1 });
      expect(observer.stopped).toBe(false);

      observer.recordRaw('tool_a', { x: 2 });
      expect(observer.stopped).toBe(false);

      observer.recordRaw('tool_a', { x: 3 });
      expect(observer.stopped).toBe(true);
      expect(observer.callCount).toBe(3);
    });

    it('should not record after stopped', () => {
      const observer = new Observer({ runs: 2 });
      observer.start();

      observer.recordRaw('tool_a', { x: 1 });
      observer.recordRaw('tool_a', { x: 2 });
      observer.recordRaw('tool_a', { x: 3 });

      expect(observer.callCount).toBe(2);
    });

    it('should stop after duration', () => {
      const observer = new Observer({ durationMs: 0 });
      observer.start();

      expect(observer.shouldStop()).toBe(true);
    });

    it('should not stop before duration', () => {
      const observer = new Observer({ durationMs: 60000 });
      observer.start();

      expect(observer.shouldStop()).toBe(false);
    });

    it('should require start() before duration check works', () => {
      const observer = new Observer({ durationMs: 0 });
      expect(observer.shouldStop()).toBe(false);
    });
  });

  describe('record', () => {
    it('should accept ToolCall objects', () => {
      const observer = new Observer({ runs: 10 });
      observer.start();

      observer.record({
        id: 'call-1',
        name: 'send_email',
        arguments: { to: 'user@test.com', subject: 'Hello' },
      });

      expect(observer.callCount).toBe(1);
      const calls = observer.getCalls();
      expect(calls[0].toolName).toBe('send_email');
      expect(calls[0].arguments).toEqual({ to: 'user@test.com', subject: 'Hello' });
    });
  });

  describe('getObservations', () => {
    let observer: Observer;

    beforeEach(() => {
      observer = new Observer({ runs: 100 });
      observer.start();
    });

    it('should group by tool name', () => {
      observer.recordRaw('read_file', { path: '/a' });
      observer.recordRaw('write_file', { path: '/b', content: 'hi' });
      observer.recordRaw('read_file', { path: '/c' });

      const obs = observer.getObservations();
      expect(obs.size).toBe(2);
      expect(obs.get('read_file')!.callCount).toBe(2);
      expect(obs.get('write_file')!.callCount).toBe(1);
    });

    it('should track argument types', () => {
      observer.recordRaw('tool', { count: 5 });
      observer.recordRaw('tool', { count: 10 });

      const obs = observer.getObservations();
      const argObs = obs.get('tool')!.arguments.get('count')!;
      expect(argObs.types.has('number')).toBe(true);
      expect(argObs.numericValues).toEqual([5, 10]);
    });

    it('should track string values', () => {
      observer.recordRaw('tool', { color: 'red' });
      observer.recordRaw('tool', { color: 'blue' });
      observer.recordRaw('tool', { color: 'red' });

      const obs = observer.getObservations();
      const argObs = obs.get('tool')!.arguments.get('color')!;
      expect(argObs.stringValues).toEqual(['red', 'blue', 'red']);
    });

    it('should track array lengths', () => {
      observer.recordRaw('tool', { tags: ['a', 'b'] });
      observer.recordRaw('tool', { tags: ['x'] });
      observer.recordRaw('tool', { tags: ['a', 'b', 'c', 'd'] });

      const obs = observer.getObservations();
      const argObs = obs.get('tool')!.arguments.get('tags')!;
      expect(argObs.arrayLengths).toEqual([2, 1, 4]);
    });

    it('should track null values', () => {
      observer.recordRaw('tool', { val: null });
      observer.recordRaw('tool', { val: 'hello' });

      const obs = observer.getObservations();
      const argObs = obs.get('tool')!.arguments.get('val')!;
      expect(argObs.nullCount).toBe(1);
      expect(argObs.types.has('null')).toBe(true);
    });

    it('should track presence count', () => {
      observer.recordRaw('tool', { a: 1, b: 2 });
      observer.recordRaw('tool', { a: 3 });
      observer.recordRaw('tool', { a: 5, b: 4 });

      const obs = observer.getObservations();
      const toolObs = obs.get('tool')!;
      expect(toolObs.arguments.get('a')!.presentCount).toBe(3);
      expect(toolObs.arguments.get('b')!.presentCount).toBe(2);
    });

    it('should track call order', () => {
      observer.recordRaw('a', {});
      observer.recordRaw('b', {});
      observer.recordRaw('a', {});

      const obs = observer.getObservations();
      expect(obs.get('a')!.callOrder).toEqual([0, 2]);
      expect(obs.get('b')!.callOrder).toEqual([1]);
    });
  });
});

describe('PolicyGenerator', () => {
  let generator: PolicyGenerator;

  beforeEach(() => {
    generator = new PolicyGenerator(0.1);
  });

  it('should generate numeric range constraints with margin', () => {
    const observer = new Observer({ runs: 100 });
    observer.start();
    observer.recordRaw('send_money', { amount: 10 });
    observer.recordRaw('send_money', { amount: 50 });
    observer.recordRaw('send_money', { amount: 100 });

    const policies = generator.generate(observer.getObservations());
    expect(policies).toHaveLength(1);

    const constraint = policies[0].constraints.find((c) => c.argumentName === 'amount')!;
    expect(constraint.minimum).toBeLessThan(10);
    expect(constraint.maximum).toBeGreaterThan(100);
    expect(constraint.required).toBe(true);
    expect(constraint.notNull).toBe(true);
  });

  it('should generate enum constraints for small string sets', () => {
    const observer = new Observer({ runs: 100 });
    observer.start();
    observer.recordRaw('set_color', { color: 'red' });
    observer.recordRaw('set_color', { color: 'blue' });
    observer.recordRaw('set_color', { color: 'green' });
    observer.recordRaw('set_color', { color: 'red' });

    const policies = generator.generate(observer.getObservations());
    const constraint = policies[0].constraints.find((c) => c.argumentName === 'color')!;
    expect(constraint.enum).toEqual(['blue', 'green', 'red']);
  });

  it('should generate string length constraints for large string sets', () => {
    const observer = new Observer({ runs: 100 });
    observer.start();
    for (let i = 0; i < 15; i++) {
      observer.recordRaw('log_msg', { message: `message-${i}-padding-text` });
    }

    const policies = generator.generate(observer.getObservations());
    const constraint = policies[0].constraints.find((c) => c.argumentName === 'message')!;
    expect(constraint.enum).toBeUndefined();
    expect(constraint.minLength).toBeDefined();
    expect(constraint.maxLength).toBeDefined();
  });

  it('should generate array constraints', () => {
    const observer = new Observer({ runs: 100 });
    observer.start();
    observer.recordRaw('tag_item', { tags: ['a'] });
    observer.recordRaw('tag_item', { tags: ['a', 'b', 'c'] });
    observer.recordRaw('tag_item', { tags: ['x', 'y'] });

    const policies = generator.generate(observer.getObservations());
    const constraint = policies[0].constraints.find((c) => c.argumentName === 'tags')!;
    expect(constraint.minItems).toBeDefined();
    expect(constraint.maxItems).toBeDefined();
    expect(constraint.minItems!).toBeLessThanOrEqual(1);
    expect(constraint.maxItems!).toBeGreaterThanOrEqual(3);
  });

  it('should mark always-present args as required', () => {
    const observer = new Observer({ runs: 100 });
    observer.start();
    observer.recordRaw('tool', { a: 1, b: 2 });
    observer.recordRaw('tool', { a: 3, b: 4 });
    observer.recordRaw('tool', { a: 5, b: 6 });

    const policies = generator.generate(observer.getObservations());
    for (const c of policies[0].constraints) {
      expect(c.required).toBe(true);
    }
  });

  it('should not mark optional args as required', () => {
    const observer = new Observer({ runs: 100 });
    observer.start();
    observer.recordRaw('tool', { a: 1, b: 2 });
    observer.recordRaw('tool', { a: 3 });
    observer.recordRaw('tool', { a: 5, b: 6 });

    const policies = generator.generate(observer.getObservations());
    const a = policies[0].constraints.find((c) => c.argumentName === 'a')!;
    const b = policies[0].constraints.find((c) => c.argumentName === 'b')!;
    expect(a.required).toBe(true);
    expect(b.required).toBeUndefined();
  });

  it('should set notNull when no null values observed', () => {
    const observer = new Observer({ runs: 100 });
    observer.start();
    observer.recordRaw('tool', { a: 1 });
    observer.recordRaw('tool', { a: 2 });

    const policies = generator.generate(observer.getObservations());
    const constraint = policies[0].constraints.find((c) => c.argumentName === 'a')!;
    expect(constraint.notNull).toBe(true);
  });

  it('should not set notNull when null values observed', () => {
    const observer = new Observer({ runs: 100 });
    observer.start();
    observer.recordRaw('tool', { a: null });
    observer.recordRaw('tool', { a: 5 });

    const policies = generator.generate(observer.getObservations());
    const constraint = policies[0].constraints.find((c) => c.argumentName === 'a')!;
    expect(constraint.notNull).toBeUndefined();
  });

  it('should handle multiple tools', () => {
    const observer = new Observer({ runs: 100 });
    observer.start();
    observer.recordRaw('tool_a', { x: 1 });
    observer.recordRaw('tool_b', { y: 'hello' });
    observer.recordRaw('tool_a', { x: 5 });

    const policies = generator.generate(observer.getObservations());
    expect(policies).toHaveLength(2);
    expect(policies.map((p) => p.toolName).sort()).toEqual(['tool_a', 'tool_b']);
  });

  it('should generate no policies for zero observations', () => {
    const observer = new Observer({ runs: 100 });
    observer.start();

    const policies = generator.generate(observer.getObservations());
    expect(policies).toHaveLength(0);
  });

  it('should handle single value numeric range', () => {
    const observer = new Observer({ runs: 100 });
    observer.start();
    observer.recordRaw('tool', { amount: 50 });
    observer.recordRaw('tool', { amount: 50 });

    const policies = generator.generate(observer.getObservations());
    const constraint = policies[0].constraints.find((c) => c.argumentName === 'amount')!;
    expect(constraint.minimum).toBeLessThan(50);
    expect(constraint.maximum).toBeGreaterThan(50);
  });

  it('should handle zero value numeric range', () => {
    const observer = new Observer({ runs: 100 });
    observer.start();
    observer.recordRaw('tool', { amount: 0 });

    const policies = generator.generate(observer.getObservations());
    const constraint = policies[0].constraints.find((c) => c.argumentName === 'amount')!;
    expect(constraint.minimum).toBeLessThanOrEqual(0);
    expect(constraint.maximum).toBeGreaterThanOrEqual(0);
  });

  it('should respect custom margin', () => {
    const wideGenerator = new PolicyGenerator(0.5);
    const narrowGenerator = new PolicyGenerator(0.01);

    const observer = new Observer({ runs: 100 });
    observer.start();
    observer.recordRaw('tool', { val: 10 });
    observer.recordRaw('tool', { val: 100 });

    const widePolicies = wideGenerator.generate(observer.getObservations());
    const narrowPolicies = narrowGenerator.generate(observer.getObservations());

    const wide = widePolicies[0].constraints[0];
    const narrow = narrowPolicies[0].constraints[0];

    expect(wide.minimum!).toBeLessThan(narrow.minimum!);
    expect(wide.maximum!).toBeGreaterThan(narrow.maximum!);
  });
});

describe('parseDuration', () => {
  it('should parse milliseconds', () => {
    expect(parseDuration('500ms')).toBe(500);
  });

  it('should parse seconds', () => {
    expect(parseDuration('30s')).toBe(30000);
  });

  it('should parse minutes', () => {
    expect(parseDuration('10m')).toBe(600000);
  });

  it('should parse hours', () => {
    expect(parseDuration('1h')).toBe(3600000);
  });

  it('should parse decimal values', () => {
    expect(parseDuration('1.5h')).toBe(5400000);
  });

  it('should throw on invalid format', () => {
    expect(() => parseDuration('abc')).toThrow('Invalid duration format');
    expect(() => parseDuration('10x')).toThrow('Invalid duration format');
    expect(() => parseDuration('')).toThrow('Invalid duration format');
  });
});

describe('policiesToYaml', () => {
  it('should generate valid YAML structure', () => {
    const policies: GeneratedPolicy[] = [
      {
        toolName: 'send_email',
        mode: 'deterministic',
        constraints: [
          { argumentName: 'to', enabled: true, required: true, notNull: true, enum: ['admin@co.com', 'user@co.com'] },
          { argumentName: 'priority', enabled: true, minimum: 1, maximum: 5 },
        ],
      },
    ];

    const yaml = policiesToYaml(policies);
    expect(yaml).toContain('policies:');
    expect(yaml).toContain('send_email');
    expect(yaml).toContain('mode: deterministic');
    expect(yaml).toContain('required: true');
    expect(yaml).toContain('notNull: true');
    expect(yaml).toContain('enum:');
    expect(yaml).toContain('"admin@co.com"');
    expect(yaml).toContain('minimum: 1');
    expect(yaml).toContain('maximum: 5');
  });

  it('should include generation metadata', () => {
    const yaml = policiesToYaml([
      { toolName: 'tool', mode: 'deterministic', constraints: [{ argumentName: 'x', enabled: true }] },
    ]);
    expect(yaml).toContain('Auto-generated policies from veto learn');
    expect(yaml).toContain('Tools observed: 1');
  });

  it('should handle array constraints in YAML', () => {
    const policies: GeneratedPolicy[] = [
      {
        toolName: 'tag',
        mode: 'deterministic',
        constraints: [{ argumentName: 'items', enabled: true, minItems: 1, maxItems: 10 }],
      },
    ];

    const yaml = policiesToYaml(policies);
    expect(yaml).toContain('minItems: 1');
    expect(yaml).toContain('maxItems: 10');
  });

  it('should handle regex constraints', () => {
    const policies: GeneratedPolicy[] = [
      {
        toolName: 'validate',
        mode: 'deterministic',
        constraints: [{ argumentName: 'email', enabled: true, regex: '^[^@]+@[^@]+$' }],
      },
    ];

    const yaml = policiesToYaml(policies);
    expect(yaml).toContain('regex:');
    expect(yaml).toContain('^[^@]+@[^@]+$');
  });
});

describe('end-to-end: observe and generate', () => {
  it('should produce policies that match the observed data', () => {
    const observer = new Observer({ runs: 100 });
    observer.start();

    observer.recordRaw('send_email', { to: 'alice@co.com', subject: 'Hi', priority: 1 });
    observer.recordRaw('send_email', { to: 'bob@co.com', subject: 'Hey', priority: 3 });
    observer.recordRaw('send_email', { to: 'alice@co.com', subject: 'Re: Hi', priority: 2 });
    observer.recordRaw('read_file', { path: '/home/user/doc.txt' });
    observer.recordRaw('read_file', { path: '/home/user/notes.md' });
    observer.recordRaw('tag_item', { id: 'item-1', tags: ['urgent', 'review'] });
    observer.recordRaw('tag_item', { id: 'item-2', tags: ['done'] });

    const generator = new PolicyGenerator(0.1);
    const policies = generator.generate(observer.getObservations());

    expect(policies).toHaveLength(3);

    const emailPolicy = policies.find((p) => p.toolName === 'send_email')!;
    expect(emailPolicy).toBeDefined();

    const toConstraint = emailPolicy.constraints.find((c) => c.argumentName === 'to')!;
    expect(toConstraint.required).toBe(true);
    expect(toConstraint.enum).toBeDefined();
    expect(toConstraint.enum!).toContain('alice@co.com');
    expect(toConstraint.enum!).toContain('bob@co.com');

    const priorityConstraint = emailPolicy.constraints.find((c) => c.argumentName === 'priority')!;
    expect(priorityConstraint.minimum).toBeLessThanOrEqual(1);
    expect(priorityConstraint.maximum).toBeGreaterThanOrEqual(3);

    const readPolicy = policies.find((p) => p.toolName === 'read_file')!;
    const pathConstraint = readPolicy.constraints.find((c) => c.argumentName === 'path')!;
    expect(pathConstraint.enum).toBeDefined();
    expect(pathConstraint.enum!).toHaveLength(2);

    const tagPolicy = policies.find((p) => p.toolName === 'tag_item')!;
    const tagsConstraint = tagPolicy.constraints.find((c) => c.argumentName === 'tags')!;
    expect(tagsConstraint.minItems).toBeDefined();
    expect(tagsConstraint.maxItems).toBeDefined();
  });
});
