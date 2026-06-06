import type { Logger } from '../utils/logger.js';
import type { FeedProvider, OutputRule, RuleCondition } from '../rules/types.js';
import {
  buildOutputEvaluationContext,
  evaluateOutputRuleLift,
  type OutputValidationContext,
  type OutputValidationResult,
  type RedactionTrace,
} from './output-validator.js';
import {
  NVIDIA_GLINER_PII_PROVIDER,
  NvidiaGlinerPiiClient,
  NvidiaGlinerPiiError,
  type NvidiaGlinerPiiEntity,
} from '../pii/nvidia-gliner-pii.js';
import { isSemanticOutputRule } from './output-rule-detectors.js';

const DEFAULT_REDACT_WITH = '[REDACTED_PII]';
const DEFAULT_MAX_FIELDS = 32;
const DEFAULT_MAX_TEXT_CHARS = 8000;

export interface SemanticOutputValidatorOptions {
  logger: Logger;
  getRulesForTool: (toolName: string) => OutputRule[];
  piiClient?: NvidiaGlinerPiiClient | null;
  feedProvider?: FeedProvider;
  maxFields?: number;
  maxTextChars?: number;
}

interface ScanCandidate {
  field: string;
  path: PathSegment[];
  text: string;
}

interface RedactionPlan {
  candidate: ScanCandidate;
  labels: string[];
  spans: EntitySpan[];
}

interface EntitySpan {
  start: number;
  end: number;
}

type PathSegment = string | number;

export class SemanticOutputValidator {
  private readonly logger: Logger;
  private readonly getRulesForTool: (toolName: string) => OutputRule[];
  private readonly piiClient: NvidiaGlinerPiiClient | null;
  private readonly feedProvider?: FeedProvider;
  private readonly maxFields: number;
  private readonly maxTextChars: number;

  constructor(options: SemanticOutputValidatorOptions) {
    this.logger = options.logger;
    this.getRulesForTool = options.getRulesForTool;
    this.piiClient = options.piiClient ?? null;
    this.feedProvider = options.feedProvider;
    this.maxFields = normalizePositiveInteger(options.maxFields, DEFAULT_MAX_FIELDS);
    this.maxTextChars = normalizePositiveInteger(options.maxTextChars, DEFAULT_MAX_TEXT_CHARS);
  }

  async validate(
    toolName: string,
    syncResult: OutputValidationResult,
    validationContext: OutputValidationContext = {}
  ): Promise<OutputValidationResult> {
    const piiClient = this.piiClient;
    if (!piiClient || syncResult.decision === 'block') {
      return syncResult;
    }

    const rules = this.getRulesForTool(toolName).filter(isSemanticOutputRule);
    if (rules.length === 0) {
      return syncResult;
    }

    try {
      return await this.applyRules(toolName, syncResult, rules, validationContext);
    } catch (error) {
      const metadata: Record<string, unknown> = {
        tool: toolName,
        provider: NVIDIA_GLINER_PII_PROVIDER,
        model: piiClient.model,
      };

      if (error instanceof NvidiaGlinerPiiError) {
        metadata.errorCode = error.code;
        metadata.status = error.status;
      } else if (error instanceof Error) {
        metadata.errorName = error.name;
      }

      this.logger.warn('NVIDIA GLiNER PII output detector failed open', metadata);
      return syncResult;
    }
  }

  private async applyRules(
    toolName: string,
    syncResult: OutputValidationResult,
    rules: OutputRule[],
    validationContext: OutputValidationContext
  ): Promise<OutputValidationResult> {
    const piiClient = this.piiClient;
    if (!piiClient) {
      return syncResult;
    }

    let transformedOutput = syncResult.output;
    let mutableOutput = syncResult.output;
    let cloned = false;
    let redactions = syncResult.redactions;
    const matchedRuleIds = [...syncResult.matchedRuleIds];
    const liftedRuleIds = [...syncResult.liftedRuleIds];
    const trace = [...syncResult.trace];
    const liftTrace = [...syncResult.liftTrace];

    const ensureClone = (): unknown => {
      if (!cloned) {
        const clonedOutput = cloneOutput(transformedOutput);
        if (clonedOutput === null) {
          throw new Error('Unable to clone output for semantic redaction');
        }
        mutableOutput = clonedOutput;
        transformedOutput = clonedOutput;
        cloned = true;
      }

      return mutableOutput;
    };

    for (const rule of rules) {
      if (liftedRuleIds.includes(rule.id)) {
        continue;
      }

      const ruleLiftTrace = evaluateOutputRuleLift(
        rule,
        buildOutputEvaluationContext(toolName, transformedOutput, validationContext),
        {
          feedProvider: this.feedProvider,
          now: validationContext.now,
          nowMs: validationContext.nowMs,
        }
      );
      if (ruleLiftTrace) {
        appendUniqueInPlace(liftedRuleIds, rule.id);
        liftTrace.push(ruleLiftTrace);
        continue;
      }

      const fields = getScanFields(rule);
      const candidates = collectScanCandidates(transformedOutput, fields, this.maxFields, this.maxTextChars);
      if (candidates.length === 0) {
        continue;
      }

      const labelsOverride = getMetadataStringArray(rule.metadata, 'labels');
      const thresholdOverride = getMetadataNumber(rule.metadata, 'threshold');
      const plans: RedactionPlan[] = [];
      const matchedLabels = new Set<string>();
      let entityCount = 0;

      for (const candidate of candidates) {
        const entities = await piiClient.detect(candidate.text, {
          labels: labelsOverride,
          threshold: thresholdOverride,
        });
        const spans = normalizeSpans(entities, candidate.text.length);
        if (spans.length === 0) {
          continue;
        }

        const labels = uniqueLabels(entities);
        for (const label of labels) {
          matchedLabels.add(label);
        }
        entityCount += spans.length;

        if (rule.action === 'block') {
          const reason = rule.description ?? `Output blocked by rule: ${rule.name}`;
          this.logger.warn('Tool output blocked by NVIDIA GLiNER PII output rule', {
            tool: toolName,
            ruleId: rule.id,
            labels,
            entityCount: spans.length,
            model: piiClient.model,
          });
          return {
            decision: 'block',
            output: null,
            reason,
            matchedRuleIds: appendUnique(matchedRuleIds, rule.id),
            liftedRuleIds,
            redactions,
            trace,
            liftTrace,
          };
        }

        if (rule.action === 'redact') {
          plans.push({ candidate, labels, spans });
        }
      }

      if (entityCount === 0) {
        continue;
      }

      appendUniqueInPlace(matchedRuleIds, rule.id);
      const labels = [...matchedLabels].sort();

      if (rule.action === 'log') {
        this.logger.warn('Tool output matched NVIDIA GLiNER PII log-only output rule', {
          tool: toolName,
          ruleId: rule.id,
          ruleName: rule.name,
          labels,
          entityCount,
          model: piiClient.model,
        });
        continue;
      }

      if (rule.action !== 'redact' || plans.length === 0) {
        continue;
      }

      const clonedOutput = ensureClone();
      const replacement = rule.redact_with ?? DEFAULT_REDACT_WITH;
      let ruleRedactions = 0;
      const redactionResult = applyRedactionPlans(rule, clonedOutput, plans, replacement);
      mutableOutput = redactionResult.output;
      transformedOutput = redactionResult.output;

      for (const entry of redactionResult.trace) {
        ruleRedactions += entry.redactedCount;
      }

      redactions += ruleRedactions;
      trace.push(...redactionResult.trace);

      if (ruleRedactions > 0) {
        this.logger.info('Tool output redacted by NVIDIA GLiNER PII output rule', {
          tool: toolName,
          ruleId: rule.id,
          labels,
          redactions: ruleRedactions,
          model: piiClient.model,
        });
      }
    }

    return {
      decision: 'allow',
      output: transformedOutput,
      matchedRuleIds,
      liftedRuleIds,
      redactions,
      trace,
      liftTrace,
    };
  }
}

function getScanFields(rule: OutputRule): string[] {
  const metadataFields = getMetadataStringArray(rule.metadata, 'fields');
  if (metadataFields) {
    return [...new Set(metadataFields)];
  }

  const conditionFields = collectConditions(rule)
    .map((condition) => condition.field)
    .filter((field): field is string => typeof field === 'string' && field.startsWith('output'));

  return conditionFields.length > 0 ? [...new Set(conditionFields)] : ['output'];
}

function collectConditions(rule: OutputRule): RuleCondition[] {
  const direct = rule.output_conditions ?? [];
  const grouped = (rule.output_condition_groups ?? []).flatMap((group) => group);
  return [...direct, ...grouped];
}

function collectScanCandidates(
  output: unknown,
  fields: string[],
  maxFields: number,
  maxTextChars: number
): ScanCandidate[] {
  const candidates: ScanCandidate[] = [];

  for (const field of fields) {
    if (candidates.length >= maxFields) break;
    const normalized = normalizeOutputField(field);
    if (!normalized) continue;

    const value = normalized.path.length === 0
      ? output
      : getValueAtPath(output, normalized.path);
    collectStringLeaves(value, normalized.path, candidates, maxFields, maxTextChars);
  }

  return dedupeCandidates(candidates);
}

function collectStringLeaves(
  value: unknown,
  basePath: PathSegment[],
  candidates: ScanCandidate[],
  maxFields: number,
  maxTextChars: number,
  seen: Set<object> = new Set()
): void {
  if (candidates.length >= maxFields) {
    return;
  }

  if (typeof value === 'string') {
    candidates.push({
      field: formatOutputField(basePath),
      path: basePath,
      text: value.slice(0, maxTextChars),
    });
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectStringLeaves(value[index], [...basePath, index], candidates, maxFields, maxTextChars, seen);
      if (candidates.length >= maxFields) break;
    }
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    collectStringLeaves(child, [...basePath, key], candidates, maxFields, maxTextChars, seen);
    if (candidates.length >= maxFields) break;
  }
}

function dedupeCandidates(candidates: ScanCandidate[]): ScanCandidate[] {
  const seen = new Set<string>();
  const deduped: ScanCandidate[] = [];

  for (const candidate of candidates) {
    const key = candidate.path.join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }

  return deduped;
}

function normalizeOutputField(field: string): { path: PathSegment[] } | null {
  const trimmed = field.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed === 'output') {
    return { path: [] };
  }

  if (trimmed.startsWith('output.')) {
    return { path: trimmed.slice('output.'.length).split('.').filter((part) => part.length > 0) };
  }

  return { path: trimmed.split('.').filter((part) => part.length > 0) };
}

function formatOutputField(path: PathSegment[]): string {
  if (path.length === 0) {
    return 'output';
  }

  return `output.${path.map((segment) => String(segment)).join('.')}`;
}

function getValueAtPath(root: unknown, path: PathSegment[]): unknown {
  let current = root;
  for (const segment of path) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[String(segment)];
  }

  return current;
}

function setValueAtPath(root: unknown, path: PathSegment[], value: string): unknown {
  if (path.length === 0) {
    return value;
  }

  let current = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    if (!current || typeof current !== 'object') {
      return root;
    }
    current = (current as Record<string, unknown>)[String(path[index])];
  }

  if (current && typeof current === 'object') {
    (current as Record<string, unknown>)[String(path[path.length - 1])] = value;
  }

  return root;
}

function applyRedactionPlans(
  rule: OutputRule,
  output: unknown,
  plans: RedactionPlan[],
  replacement: string
): { output: unknown; trace: RedactionTrace[] } {
  let transformedOutput = output;
  const trace: RedactionTrace[] = [];

  for (const plan of plans) {
    const current = getValueAtPath(transformedOutput, plan.candidate.path);
    if (typeof current !== 'string') {
      continue;
    }

    const redacted = redactSpans(current, plan.spans, replacement);
    transformedOutput = setValueAtPath(transformedOutput, plan.candidate.path, redacted);

    trace.push({
      ruleId: rule.id,
      ruleName: rule.name,
      field: plan.candidate.field,
      pattern: `${NVIDIA_GLINER_PII_PROVIDER}:${plan.labels.sort().join(',')}`,
      redactedCount: plan.spans.length,
      replacement,
    });
  }

  return { output: transformedOutput, trace };
}

function redactSpans(value: string, spans: EntitySpan[], replacement: string): string {
  let redacted = value;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    redacted = `${redacted.slice(0, span.start)}${replacement}${redacted.slice(span.end)}`;
  }

  return redacted;
}

function normalizeSpans(entities: NvidiaGlinerPiiEntity[], textLength: number): EntitySpan[] {
  const spans = entities
    .map((entity) => ({
      start: Math.max(0, Math.min(textLength, entity.start)),
      end: Math.max(0, Math.min(textLength, entity.end)),
    }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const merged: EntitySpan[] = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (!previous || span.start >= previous.end) {
      merged.push({ ...span });
      continue;
    }
    previous.end = Math.max(previous.end, span.end);
  }

  return merged;
}

function uniqueLabels(entities: NvidiaGlinerPiiEntity[]): string[] {
  return [...new Set(
    entities
      .map((entity) => entity.label.trim())
      .filter((label) => label.length > 0)
  )].sort();
}

function getMetadataStringArray(
  metadata: Record<string, unknown> | undefined,
  key: string
): string[] | undefined {
  const raw = metadata?.[key];
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const values = raw
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return values.length > 0 ? values : undefined;
}

function getMetadataNumber(
  metadata: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  const raw = metadata?.[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

function appendUnique(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}

function appendUniqueInPlace(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function cloneOutput(output: unknown): unknown | null {
  try {
    return structuredClone(output);
  } catch {
    try {
      return JSON.parse(JSON.stringify(output)) as unknown;
    } catch {
      return null;
    }
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}
