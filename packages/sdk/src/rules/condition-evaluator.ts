import { isSafePattern } from '../deterministic/regex-safety.js';
import type {
  ConditionOperator,
  RuleCondition,
  TimeConditionDay,
} from './types.js';

export interface ConditionEvaluationOptions {
  evaluateExpression?: (expression: string, context: Record<string, unknown>) => boolean;
  allowNestedObjectStringSearch?: boolean;
  now?: Date;
}

interface TimeWindowValue {
  start: string;
  end: string;
  timezone: string;
  days: Set<TimeConditionDay> | null;
}

interface TimeWindowEvaluation {
  inScope: boolean;
  withinWindow: boolean;
}

const TIME_24H_REGEX = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAY_ORDER: readonly TimeConditionDay[] = [
  'sun',
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
];
const WEEKDAY_SET = new Set<TimeConditionDay>(WEEKDAY_ORDER);
const TIMEZONE_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function createBuiltInContext(now: Date): Record<string, unknown> {
  const day = WEEKDAY_ORDER[now.getDay()] ?? 'sun';
  return {
    time: now.toISOString(),
    day_of_week: day,
  };
}

function resolveDotPath(path: string, source: Record<string, unknown>): unknown {
  if (!path) {
    return source;
  }

  const parts = path.split('.');
  let current: unknown = source;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Resolve a dot-notation field path from an evaluation context.
 */
export function resolveFieldPath(
  field: string,
  context: Record<string, unknown>,
  builtInContext: Record<string, unknown> = createBuiltInContext(new Date())
): unknown {
  if (field === 'context') {
    return builtInContext;
  }

  if (field.startsWith('context.')) {
    const contextPath = field.slice('context.'.length);
    return resolveDotPath(contextPath, builtInContext);
  }

  return resolveDotPath(field, context);
}

/**
 * Compile a regex pattern only if it passes safety checks.
 */
export function createSafeRegex(
  pattern: string,
  flags?: string
): RegExp | null {
  const parsed = parseInlineRegexFlags(pattern);
  if (!parsed) {
    return null;
  }

  if (parsed.source.length > 256 || !isSafePattern(parsed.source)) {
    return null;
  }

  try {
    return new RegExp(parsed.source, mergeRegexFlags(parsed.flags, flags));
  } catch {
    return null;
  }
}

function parseInlineRegexFlags(
  pattern: string
): { source: string; flags: string } | null {
  const match = /^\(\?([a-z]+)\)/i.exec(pattern);
  if (!match) {
    return { source: pattern, flags: '' };
  }

  const inlineFlags = match[1].toLowerCase();
  const supportedFlags = new Set(['d', 'i', 'm', 's', 'u', 'v']);
  for (const flag of inlineFlags) {
    if (!supportedFlags.has(flag)) {
      return null;
    }
  }

  if (inlineFlags.includes('u') && inlineFlags.includes('v')) {
    return null;
  }

  return {
    source: pattern.slice(match[0].length),
    flags: inlineFlags,
  };
}

function mergeRegexFlags(...flagSets: Array<string | undefined>): string {
  const merged = new Set<string>();
  for (const flagSet of flagSets) {
    if (!flagSet) continue;
    for (const flag of flagSet) {
      merged.add(flag);
    }
  }

  return [...merged].join('');
}

function parseClockToMinutes(value: string): number | null {
  if (!TIME_24H_REGEX.test(value)) {
    return null;
  }

  const [hourString, minuteString] = value.split(':');
  const hour = Number(hourString);
  const minute = Number(minuteString);

  return (hour * 60) + minute;
}

function normalizeTimeDay(value: string): TimeConditionDay | null {
  const normalized = value.trim().toLowerCase().slice(0, 3) as TimeConditionDay;
  return WEEKDAY_SET.has(normalized) ? normalized : null;
}

function normalizeTimeWindowValue(raw: unknown): TimeWindowValue | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const value = raw as Record<string, unknown>;
  const start = value.start;
  const end = value.end;
  const timezone = value.timezone;

  if (typeof start !== 'string' || typeof end !== 'string' || typeof timezone !== 'string') {
    return null;
  }

  const startMinutes = parseClockToMinutes(start);
  const endMinutes = parseClockToMinutes(end);
  if (startMinutes === null || endMinutes === null) {
    return null;
  }

  const rawDays = value.days;
  let days: Set<TimeConditionDay> | null = null;

  if (rawDays !== undefined) {
    if (!Array.isArray(rawDays)) {
      return null;
    }
    days = new Set<TimeConditionDay>();
    for (const day of rawDays) {
      if (typeof day !== 'string') {
        return null;
      }
      const normalizedDay = normalizeTimeDay(day);
      if (!normalizedDay) {
        return null;
      }
      days.add(normalizedDay);
    }
  }

  return {
    start,
    end,
    timezone,
    days,
  };
}

function parseTimestamp(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
}

function getTimeZoneFormatter(timezone: string): Intl.DateTimeFormat | null {
  const cached = TIMEZONE_FORMATTER_CACHE.get(timezone);
  if (cached) {
    return cached;
  }

  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    TIMEZONE_FORMATTER_CACHE.set(timezone, formatter);
    return formatter;
  } catch {
    return null;
  }
}

function getZonedDayAndMinute(
  timestamp: Date,
  timezone: string
): { day: TimeConditionDay; minuteOfDay: number } | null {
  const formatter = getTimeZoneFormatter(timezone);
  if (!formatter) {
    return null;
  }

  try {
    const parts = formatter.formatToParts(timestamp);
    const weekday = parts.find((part) => part.type === 'weekday')?.value;
    const hourRaw = parts.find((part) => part.type === 'hour')?.value;
    const minuteRaw = parts.find((part) => part.type === 'minute')?.value;

    if (!weekday || !hourRaw || !minuteRaw) {
      return null;
    }

    const day = normalizeTimeDay(weekday);
    if (!day) {
      return null;
    }

    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
      return null;
    }

    return {
      day,
      minuteOfDay: (hour * 60) + minute,
    };
  } catch {
    return null;
  }
}

function previousDay(day: TimeConditionDay): TimeConditionDay {
  const index = WEEKDAY_ORDER.indexOf(day);
  const previousIndex = (index + WEEKDAY_ORDER.length - 1) % WEEKDAY_ORDER.length;
  return WEEKDAY_ORDER[previousIndex];
}

function isDayAllowed(day: TimeConditionDay, allowedDays: Set<TimeConditionDay> | null): boolean {
  return allowedDays === null || allowedDays.has(day);
}

export function evaluateTimeWindow(
  fieldValue: unknown,
  expected: unknown
): TimeWindowEvaluation | null {
  const parsedWindow = normalizeTimeWindowValue(expected);
  if (!parsedWindow) {
    return null;
  }

  const timestamp = parseTimestamp(fieldValue);
  if (!timestamp) {
    return null;
  }

  const zoned = getZonedDayAndMinute(timestamp, parsedWindow.timezone);
  if (!zoned) {
    return null;
  }

  const startMinutes = parseClockToMinutes(parsedWindow.start);
  const endMinutes = parseClockToMinutes(parsedWindow.end);
  if (startMinutes === null || endMinutes === null) {
    return null;
  }

  const relevantDay = startMinutes > endMinutes && zoned.minuteOfDay < endMinutes
    ? previousDay(zoned.day)
    : zoned.day;

  if (!isDayAllowed(relevantDay, parsedWindow.days)) {
    return {
      inScope: false,
      withinWindow: false,
    };
  }

  if (startMinutes === endMinutes) {
    return {
      inScope: true,
      withinWindow: true,
    };
  }

  if (startMinutes < endMinutes) {
    return {
      inScope: true,
      withinWindow: zoned.minuteOfDay >= startMinutes && zoned.minuteOfDay < endMinutes,
    };
  }

  return {
    inScope: true,
    withinWindow: zoned.minuteOfDay >= startMinutes || zoned.minuteOfDay < endMinutes,
  };
}

function getLengthComparableValue(value: unknown): number | null {
  if (Array.isArray(value)) {
    return value.length;
  }

  if (value instanceof Set || value instanceof Map) {
    return value.size;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return 0;
    }

    if (value.includes(',') || value.includes(';')) {
      return value
        .split(/[;,]/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .length;
    }

    return 1;
  }

  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      return Object.keys(value as Record<string, unknown>).length;
    }
  }

  return null;
}

function collectNestedStrings(
  value: unknown,
  seen: Set<object> = new Set()
): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  if (seen.has(value)) {
    return [];
  }

  seen.add(value);

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectNestedStrings(entry, seen));
  }

  return Object.values(value as Record<string, unknown>)
    .flatMap((entry) => collectNestedStrings(entry, seen));
}

/**
 * Evaluate a single legacy field/operator/value condition.
 */
export function evaluateLegacyCondition(
  fieldValue: unknown,
  operator: ConditionOperator,
  expected: unknown,
  options: Pick<ConditionEvaluationOptions, 'allowNestedObjectStringSearch'> = {}
): boolean {
  const allowNestedObjectStringSearch = options.allowNestedObjectStringSearch === true;

  switch (operator) {
    case 'equals':
      if (typeof fieldValue === 'string' && typeof expected === 'string') {
        return fieldValue.toLowerCase() === expected.toLowerCase();
      }
      return fieldValue === expected;
    case 'not_equals':
      if (typeof fieldValue === 'string' && typeof expected === 'string') {
        return fieldValue.toLowerCase() !== expected.toLowerCase();
      }
      return fieldValue !== expected;
    case 'contains':
      if (typeof fieldValue === 'string' && typeof expected === 'string') {
        return fieldValue.toLowerCase().includes(expected.toLowerCase());
      }
      if (Array.isArray(fieldValue)) {
        if (typeof expected === 'string') {
          const lower = expected.toLowerCase();
          return fieldValue.some((e: unknown) => typeof e === 'string' ? e.toLowerCase() === lower : e === expected);
        }
        return fieldValue.includes(expected);
      }
      if (allowNestedObjectStringSearch && typeof expected === 'string') {
        const lower = expected.toLowerCase();
        return collectNestedStrings(fieldValue)
          .some((value) => value.toLowerCase().includes(lower));
      }
      return false;
    case 'not_contains':
      if (typeof fieldValue === 'string' && typeof expected === 'string') {
        return !fieldValue.toLowerCase().includes(expected.toLowerCase());
      }
      if (Array.isArray(fieldValue)) {
        if (typeof expected === 'string') {
          const lower = expected.toLowerCase();
          return !fieldValue.some((e: unknown) => typeof e === 'string' ? e.toLowerCase() === lower : e === expected);
        }
        return !fieldValue.includes(expected);
      }
      if (allowNestedObjectStringSearch && typeof expected === 'string') {
        const lower = expected.toLowerCase();
        return collectNestedStrings(fieldValue)
          .every((value) => !value.toLowerCase().includes(lower));
      }
      return true;
    case 'starts_with':
      return typeof fieldValue === 'string' && typeof expected === 'string'
        && fieldValue.toLowerCase().startsWith(expected.toLowerCase());
    case 'ends_with':
      return typeof fieldValue === 'string' && typeof expected === 'string'
        && fieldValue.toLowerCase().endsWith(expected.toLowerCase());
    case 'matches': {
      if (typeof expected !== 'string') {
        return false;
      }
      if (typeof fieldValue === 'string') {
        return createSafeRegex(expected, 'i')?.test(fieldValue) ?? false;
      }

      if (!allowNestedObjectStringSearch) {
        return false;
      }

      const regex = createSafeRegex(expected, 'i');
      if (!regex) {
        return false;
      }

      return collectNestedStrings(fieldValue)
        .some((value) => regex.test(value));
    }
    case 'greater_than': {
      const a = Number(fieldValue), b = Number(expected);
      return Number.isFinite(a) && Number.isFinite(b) && a > b;
    }
    case 'less_than': {
      const a = Number(fieldValue), b = Number(expected);
      return Number.isFinite(a) && Number.isFinite(b) && a < b;
    }
    case 'length_greater_than': {
      const fieldLength = getLengthComparableValue(fieldValue);
      if (fieldLength === null) {
        return false;
      }

      const expectedLength = Number(expected);
      if (Number.isNaN(expectedLength)) {
        return false;
      }

      return fieldLength > expectedLength;
    }
    case 'in':
      if (!Array.isArray(expected)) return false;
      if (typeof fieldValue === 'string') {
        const lower = fieldValue.toLowerCase();
        return expected.some((e: unknown) => typeof e === 'string' ? e.toLowerCase() === lower : e === fieldValue);
      }
      return expected.includes(fieldValue);
    case 'not_in':
      if (!Array.isArray(expected)) return false;
      if (typeof fieldValue === 'string') {
        const lower = fieldValue.toLowerCase();
        return !expected.some((e: unknown) => typeof e === 'string' ? e.toLowerCase() === lower : e === fieldValue);
      }
      return !expected.includes(fieldValue);
    case 'within_hours': {
      const result = evaluateTimeWindow(fieldValue, expected);
      return result !== null && result.inScope && result.withinWindow;
    }
    case 'outside_hours': {
      const result = evaluateTimeWindow(fieldValue, expected);
      return result !== null && result.inScope && !result.withinWindow;
    }
    default:
      return false;
  }
}

/**
 * Evaluate a single condition, supporting expression-based and legacy conditions.
 */
export function evaluateCondition(
  condition: RuleCondition,
  context: Record<string, unknown>,
  options: ConditionEvaluationOptions = {}
): boolean {
  const evaluationTime = options.now ?? new Date();
  const builtInContext = createBuiltInContext(evaluationTime);

  if (condition.expression) {
    if (!options.evaluateExpression) return false;
    return options.evaluateExpression(condition.expression, context);
  }

  if (condition.field && condition.operator) {
    const fieldValue = resolveFieldPath(condition.field, context, builtInContext);

    if (condition.operator === 'percent_of') {
      if (typeof condition.reference !== 'string') {
        return false;
      }

      const referenceValue = resolveFieldPath(condition.reference, context, builtInContext);
      const resolvedFieldValue = Number(fieldValue);
      const resolvedExpectedValue = Number(condition.value);
      const resolvedReferenceValue = Number(referenceValue);

      if (
        Number.isNaN(resolvedFieldValue)
        || Number.isNaN(resolvedExpectedValue)
        || Number.isNaN(resolvedReferenceValue)
      ) {
        return false;
      }

      return resolvedFieldValue > (resolvedReferenceValue * resolvedExpectedValue / 100);
    }

    return evaluateLegacyCondition(fieldValue, condition.operator, condition.value, {
      allowNestedObjectStringSearch: options.allowNestedObjectStringSearch,
    });
  }

  return false;
}

/**
 * Evaluate a rule-like condition collection:
 * - `conditions`: AND semantics
 * - `conditionGroups`: OR semantics, each group is AND
 */
export function evaluateConditionCollections(
  conditions: RuleCondition[] | undefined,
  conditionGroups: RuleCondition[][] | undefined,
  context: Record<string, unknown>,
  options: ConditionEvaluationOptions = {}
): boolean {
  const normalizedOptions: ConditionEvaluationOptions = {
    ...options,
    now: options.now ?? new Date(),
  };

  if (conditions && conditions.length > 0) {
    return conditions.every((condition) => evaluateCondition(condition, context, normalizedOptions));
  }

  if (conditionGroups && conditionGroups.length > 0) {
    return conditionGroups.some((group) =>
      group.every((condition) => evaluateCondition(condition, context, normalizedOptions))
    );
  }

  return true;
}
