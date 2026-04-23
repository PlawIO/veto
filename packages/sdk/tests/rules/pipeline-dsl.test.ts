import { describe, it, expect } from 'vitest';
import {
  canonicalizeJson,
  computePipelineId,
  parsePipelineSpec,
  stampPipelineId,
  verifyPipelineId,
  PipelineSpecSchema,
} from '../../src/rules/pipeline-dsl.js';

const validDraft = {
  dsl_version: 1 as const,
  description: 'gambling block list',
  schedule: { kind: 'interval' as const, every_sec: 3600 },
  steps: [
    {
      kind: 'search' as const,
      resolver: 'exa',
      query: 'gambling website',
      limit: 100,
      as: 'raw',
    },
    {
      kind: 'aggregate' as const,
      source: 'raw',
      op: 'unique' as const,
      as: 'urls',
    },
  ],
  output: { shape: 'list_of_strings' as const },
  budget: { max_resolver_calls_per_run: 5, max_tokens_per_run: 0 },
  on_failure: 'last_known_good' as const,
};

describe('canonicalizeJson', () => {
  it('sorts object keys deterministically', () => {
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe(canonicalizeJson({ a: 2, b: 1 }));
  });

  it('preserves array order', () => {
    expect(canonicalizeJson([1, 2, 3])).not.toBe(canonicalizeJson([3, 2, 1]));
  });

  it('drops undefined values', () => {
    expect(canonicalizeJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('handles null + primitives', () => {
    expect(canonicalizeJson(null)).toBe('null');
    expect(canonicalizeJson('x')).toBe('"x"');
    expect(canonicalizeJson(42)).toBe('42');
  });

  it('rejects non-plain objects to prevent silent hash collisions', () => {
    expect(() => canonicalizeJson(new Date(0))).toThrow(TypeError);
    expect(() => canonicalizeJson(new Map())).toThrow(TypeError);
    expect(() => canonicalizeJson(new Set([1]))).toThrow(TypeError);
    expect(() => canonicalizeJson(/regex/)).toThrow(TypeError);
    class Thing {}
    expect(() => canonicalizeJson(new Thing())).toThrow(TypeError);
  });

  it('rejects unserializable primitives', () => {
    expect(() => canonicalizeJson(10n)).toThrow(TypeError);
    expect(() => canonicalizeJson(Symbol('x'))).toThrow(TypeError);
    expect(() => canonicalizeJson(() => 1)).toThrow(TypeError);
  });

  it('accepts null-prototype objects', () => {
    const obj = Object.create(null);
    obj.a = 1;
    obj.b = 2;
    expect(canonicalizeJson(obj)).toBe('{"a":1,"b":2}');
  });
});

describe('computePipelineId', () => {
  it('produces a deterministic 64-char hex sha256', () => {
    const id = computePipelineId(validDraft);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(computePipelineId(validDraft)).toBe(id);
  });

  it('is invariant to key ordering inside nested objects', () => {
    const reordered = {
      on_failure: 'last_known_good' as const,
      budget: { max_tokens_per_run: 0, max_resolver_calls_per_run: 5 },
      output: { shape: 'list_of_strings' as const },
      steps: validDraft.steps,
      schedule: { every_sec: 3600, kind: 'interval' as const },
      description: 'gambling block list',
      dsl_version: 1 as const,
    };
    expect(computePipelineId(reordered)).toBe(computePipelineId(validDraft));
  });

  it('differs when semantic content differs', () => {
    const mutated = {
      ...validDraft,
      schedule: { kind: 'interval' as const, every_sec: 7200 },
    };
    expect(computePipelineId(mutated)).not.toBe(computePipelineId(validDraft));
  });

  it('ignores the id field itself', () => {
    const stamped = stampPipelineId(validDraft);
    const withOtherId = { ...stamped, id: 'a'.repeat(64) };
    expect(computePipelineId(stamped)).toBe(computePipelineId(withOtherId));
  });
});

describe('parsePipelineSpec', () => {
  it('accepts a well-formed spec', () => {
    const spec = stampPipelineId(validDraft);
    expect(() => parsePipelineSpec(spec)).not.toThrow();
  });

  it('rejects an id that is not 64 hex chars', () => {
    const bad = { ...validDraft, id: 'not-a-hash' };
    expect(() => PipelineSpecSchema.parse(bad)).toThrow();
  });

  it('rejects unknown step kinds', () => {
    const bad = stampPipelineId({
      ...validDraft,
      steps: [
        {
          // @ts-expect-error intentionally invalid kind
          kind: 'exec_arbitrary_code',
          resolver: 'exa',
          query: 'x',
        },
      ],
    });
    expect(() => parsePipelineSpec(bad)).toThrow();
  });

  it('rejects interval < 60s', () => {
    const bad = stampPipelineId({
      ...validDraft,
      schedule: { kind: 'interval' as const, every_sec: 1 },
    });
    expect(() => parsePipelineSpec(bad)).toThrow();
  });

  it('rejects empty steps array', () => {
    const bad = stampPipelineId({ ...validDraft, steps: [] });
    expect(() => parsePipelineSpec(bad)).toThrow();
  });
});

describe('verifyPipelineId', () => {
  it('returns true for a correctly stamped spec', () => {
    expect(verifyPipelineId(stampPipelineId(validDraft))).toBe(true);
  });

  it('detects tampering', () => {
    const stamped = stampPipelineId(validDraft);
    const tampered = {
      ...stamped,
      schedule: { kind: 'interval' as const, every_sec: 300 },
    };
    expect(verifyPipelineId(tampered)).toBe(false);
  });
});
