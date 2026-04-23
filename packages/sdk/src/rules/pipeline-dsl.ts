/**
 * Pipeline DSL — declarative, content-addressable spec for dynamic
 * policy feeds.
 *
 * A pipeline composes a small set of validated resolver operations into
 * a list-producing DAG. The LLM compiler emits pipelines by selecting
 * from a fixed catalog; it never writes executable code. Identity is
 * the sha256 of the canonicalized spec (minus `id`), so two callers
 * requesting "block gambling sites" share one pipeline.
 *
 * This module is pure OSS: runtime, scheduler, and resolver
 * implementations live in the platform. The SDK only exposes the
 * schema and validator so consumers can author, verify, and diff
 * pipeline specs without the platform.
 *
 * @module rules/pipeline-dsl
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';

const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/i, 'identifier must start with a letter and contain only [A-Za-z0-9_]');

const resolverName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/, 'resolver name must be lowercase kebab/snake');

const searchStep = z.object({
  kind: z.literal('search'),
  resolver: resolverName,
  query: z.string().min(1).max(2048),
  limit: z.number().int().min(1).max(1000).optional(),
  as: identifier.optional(),
});

const fetchStep = z.object({
  kind: z.literal('fetch'),
  resolver: resolverName,
  id_from: z.string().min(1).max(256),
  fields: z.array(z.string().min(1).max(128)).min(1).max(32),
  as: identifier.optional(),
});

const extractStep = z.object({
  kind: z.literal('extract'),
  from: z.string().min(1).max(256),
  selector: z.string().min(1).max(256),
  as: identifier,
});

const aggregateStep = z.object({
  kind: z.literal('aggregate'),
  source: z.string().min(1).max(256),
  op: z.enum(['unique', 'count', 'union', 'intersect']),
  as: identifier.optional(),
});

const diffStep = z.object({
  kind: z.literal('diff'),
  current: z.string().min(1).max(256),
  previous: z.string().min(1).max(256),
  emit: z.enum(['added', 'removed', 'changed']),
  as: identifier.optional(),
});

const leafStep = z.union([searchStep, fetchStep, extractStep, aggregateStep, diffStep]);

// `foreach` is the only step that can contain other steps. Depth 1 is
// sufficient for all compiled pipelines observed so far; deeper nesting
// is rejected to keep the cost model tractable and to block recursive
// prompt-injection patterns.
const foreachStep = z.object({
  kind: z.literal('foreach'),
  source: z.string().min(1).max(256),
  do: z.array(leafStep).min(1).max(16),
  as: identifier.optional(),
});

export const PipelineStepSchema = z.union([
  searchStep,
  fetchStep,
  extractStep,
  aggregateStep,
  diffStep,
  foreachStep,
]);
export type PipelineStep = z.infer<typeof PipelineStepSchema>;

export const PipelineScheduleSchema = z.union([
  z.object({
    kind: z.literal('interval'),
    every_sec: z.number().int().min(60).max(7 * 24 * 60 * 60),
  }),
  z.object({
    kind: z.literal('cron'),
    expr: z.string().min(1).max(128),
  }),
]);
export type PipelineSchedule = z.infer<typeof PipelineScheduleSchema>;

export const PipelineOutputSchema = z.object({
  shape: z.enum(['list_of_strings', 'list_of_objects']),
  schema: z.unknown().optional(),
});
export type PipelineOutput = z.infer<typeof PipelineOutputSchema>;

export const PipelineBudgetSchema = z.object({
  max_resolver_calls_per_run: z.number().int().min(1).max(10_000),
  max_tokens_per_run: z.number().int().min(0).max(1_000_000),
});
export type PipelineBudget = z.infer<typeof PipelineBudgetSchema>;

export const PipelineSpecSchema = z.object({
  dsl_version: z.literal(1),
  // id is the sha256 of the canonicalized spec-minus-id. Required at
  // load time; computed by `computePipelineId()` before persistence.
  id: z.string().regex(/^[0-9a-f]{64}$/, 'pipeline id must be a hex sha256'),
  description: z.string().max(512).optional(),
  schedule: PipelineScheduleSchema,
  steps: z.array(PipelineStepSchema).min(1).max(32),
  output: PipelineOutputSchema,
  budget: PipelineBudgetSchema,
  on_failure: z.enum(['skip', 'fail_open', 'fail_closed', 'last_known_good']),
});
export type PipelineSpec = z.infer<typeof PipelineSpecSchema>;

/**
 * Canonicalize an arbitrary JSON value to a deterministic string.
 *
 * Rules:
 * - Object keys sorted lexicographically.
 * - Arrays preserved in order (order is semantically meaningful in DSL).
 * - Numbers formatted with JSON.stringify default (no special handling).
 * - `undefined` removed (matches JSON.stringify behavior).
 *
 * Throws on non-plain-object container types (Date, Map, Set, RegExp,
 * class instances), BigInt, Symbol, and functions. These would either
 * hash-collide silently (Date → `{}`) or crash JSON.stringify (BigInt).
 * Pipeline specs validated by PipelineSpecSchema never contain such
 * values; the guard exists for callers who bypass Zod.
 *
 * Used only for content-hash identity; not a general-purpose serializer.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'bigint' || t === 'symbol' || t === 'function') {
    throw new TypeError(`canonicalizeJson: unsupported value of type ${t}`);
  }
  if (t !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalizeJson).join(',') + ']';
  }
  // Reject non-plain objects (Date, Map, Set, RegExp, class instances)
  // which would serialize to `{}` via Object.entries and collide on hash.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(
      'canonicalizeJson: non-plain object rejected (Date/Map/Set/RegExp/class instances are not allowed in pipeline specs)',
    );
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return (
    '{' +
    entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalizeJson(v)).join(',') +
    '}'
  );
}

/**
 * Compute the content-addressable pipeline id.
 *
 * The id is the hex sha256 of the canonicalized spec with the `id`
 * field stripped (the id cannot refer to itself). Two specs that
 * differ only in description still hash the same because the
 * description is intentionally included — a new description means
 * new monitoring semantics. Callers that want to reuse an existing
 * pipeline should pass the same description.
 */
export function computePipelineId(
  spec: Omit<PipelineSpec, 'id'> | PipelineSpec,
): string {
  const { ...rest } = spec as Record<string, unknown>;
  delete rest.id;
  const canonical = canonicalizeJson(rest);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Parse and validate an untrusted pipeline spec.
 *
 * Throws on any schema violation. Does NOT verify the `id` matches
 * the content hash — call `verifyPipelineId(spec)` for that.
 */
export function parsePipelineSpec(input: unknown): PipelineSpec {
  return PipelineSpecSchema.parse(input);
}

/**
 * Verify the `id` field equals the computed content hash.
 *
 * Use on load from any untrusted source (network, disk) to detect
 * tampering or stale ids after edits.
 */
export function verifyPipelineId(spec: PipelineSpec): boolean {
  return spec.id === computePipelineId(spec);
}

/**
 * Stamp the correct content-hash id onto a draft spec.
 *
 * Convenience for authors and compilers who produce specs without
 * pre-computing the id.
 */
export function stampPipelineId(
  draft: Omit<PipelineSpec, 'id'>,
): PipelineSpec {
  return { ...draft, id: computePipelineId(draft) };
}
