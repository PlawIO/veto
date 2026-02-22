import { describe, expect, it } from 'vitest';
import { evaluateCondition } from '../../src/rules/condition-evaluator.js';
import type { RuleCondition } from '../../src/rules/types.js';

describe('Time-based condition operators', () => {
  it('matches outside_hours during off-hours', () => {
    const condition: RuleCondition = {
      field: 'context.time',
      operator: 'outside_hours',
      value: {
        start: '09:00',
        end: '17:00',
        timezone: 'UTC',
      },
    };

    const matched = evaluateCondition(condition, {}, {
      now: new Date('2025-01-06T22:00:00.000Z'),
    });

    expect(matched).toBe(true);
  });

  it('matches within_hours during working hours', () => {
    const condition: RuleCondition = {
      field: 'context.time',
      operator: 'within_hours',
      value: {
        start: '09:00',
        end: '17:00',
        timezone: 'UTC',
      },
    };

    const matched = evaluateCondition(condition, {}, {
      now: new Date('2025-01-06T10:15:00.000Z'),
    });

    expect(matched).toBe(true);
  });

  it('converts timestamps across timezones before evaluating', () => {
    const now = new Date('2025-01-06T18:30:00.000Z');

    const losAngelesCondition: RuleCondition = {
      field: 'context.time',
      operator: 'within_hours',
      value: {
        start: '09:00',
        end: '17:00',
        timezone: 'America/Los_Angeles',
      },
    };

    const tokyoCondition: RuleCondition = {
      field: 'context.time',
      operator: 'within_hours',
      value: {
        start: '09:00',
        end: '17:00',
        timezone: 'Asia/Tokyo',
      },
    };

    expect(evaluateCondition(losAngelesCondition, {}, { now })).toBe(true);
    expect(evaluateCondition(tokyoCondition, {}, { now })).toBe(false);
  });

  it('respects weekday day filters', () => {
    const condition: RuleCondition = {
      field: 'context.time',
      operator: 'outside_hours',
      value: {
        start: '09:00',
        end: '17:00',
        timezone: 'UTC',
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      },
    };

    const saturdayOffHours = evaluateCondition(condition, {}, {
      now: new Date('2025-01-11T22:00:00.000Z'),
    });

    expect(saturdayOffHours).toBe(false);
  });

  it('supports context.day_of_week with existing in operator', () => {
    const condition: RuleCondition = {
      field: 'context.day_of_week',
      operator: 'in',
      value: ['sat', 'sun'],
    };

    const saturdayMatch = evaluateCondition(condition, {}, {
      now: new Date('2025-01-11T12:00:00.000Z'),
    });
    const mondayMatch = evaluateCondition(condition, {}, {
      now: new Date('2025-01-13T12:00:00.000Z'),
    });

    expect(saturdayMatch).toBe(true);
    expect(mondayMatch).toBe(false);
  });

  it('applies when days filter is omitted', () => {
    const condition: RuleCondition = {
      field: 'context.time',
      operator: 'within_hours',
      value: {
        start: '09:00',
        end: '17:00',
        timezone: 'UTC',
      },
    };

    const sundayWithinHours = evaluateCondition(condition, {}, {
      now: new Date('2025-01-12T10:00:00.000Z'),
    });

    expect(sundayWithinHours).toBe(true);
  });

  it('handles overnight windows that cross midnight', () => {
    const condition: RuleCondition = {
      field: 'context.time',
      operator: 'within_hours',
      value: {
        start: '22:00',
        end: '06:00',
        timezone: 'UTC',
      },
    };

    const lateNight = evaluateCondition(condition, {}, {
      now: new Date('2025-01-06T23:30:00.000Z'),
    });
    const earlyMorning = evaluateCondition(condition, {}, {
      now: new Date('2025-01-07T03:30:00.000Z'),
    });
    const daytime = evaluateCondition(condition, {}, {
      now: new Date('2025-01-07T12:00:00.000Z'),
    });

    expect(lateNight).toBe(true);
    expect(earlyMorning).toBe(true);
    expect(daytime).toBe(false);
  });

  it('applies overnight day filters to the window start day', () => {
    const condition: RuleCondition = {
      field: 'context.time',
      operator: 'within_hours',
      value: {
        start: '22:00',
        end: '06:00',
        timezone: 'UTC',
        days: ['fri'],
      },
    };

    const saturdayEarlyMorning = evaluateCondition(condition, {}, {
      now: new Date('2025-01-11T03:00:00.000Z'),
    });
    const sundayEarlyMorning = evaluateCondition(condition, {}, {
      now: new Date('2025-01-12T03:00:00.000Z'),
    });

    expect(saturdayEarlyMorning).toBe(true);
    expect(sundayEarlyMorning).toBe(false);
  });

  it('returns false for invalid timezone values', () => {
    const condition: RuleCondition = {
      field: 'context.time',
      operator: 'within_hours',
      value: {
        start: '09:00',
        end: '17:00',
        timezone: 'Invalid/Timezone',
      },
    };

    const matched = evaluateCondition(condition, {}, {
      now: new Date('2025-01-06T12:00:00.000Z'),
    });

    expect(matched).toBe(false);
  });
});
