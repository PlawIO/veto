import { describe, it, expect } from 'vitest';
import { isSafePattern } from '../../src/deterministic/regex-safety.js';

describe('isSafePattern', () => {
  it('should accept simple patterns', () => {
    expect(isSafePattern('^[a-z]+$')).toBe(true);
    expect(isSafePattern('^\\d{3}-\\d{4}$')).toBe(true);
    expect(isSafePattern('^https?://.*')).toBe(true);
    expect(isSafePattern('[A-Za-z0-9_]+')).toBe(true);
  });

  it('should reject patterns longer than 256 characters', () => {
    const longPattern = 'a'.repeat(257);
    expect(isSafePattern(longPattern)).toBe(false);
  });

  it('should accept patterns at exactly 256 characters', () => {
    const exactPattern = 'a'.repeat(256);
    expect(isSafePattern(exactPattern)).toBe(true);
  });

  it('should reject nested quantifiers', () => {
    expect(isSafePattern('(a+)+')).toBe(false);
    expect(isSafePattern('(a*)*')).toBe(false);
    expect(isSafePattern('(a{1,3})*')).toBe(false);
    expect(isSafePattern('(a+){2,}')).toBe(false);
  });

  it('should reject overlapping alternation with wildcards', () => {
    expect(isSafePattern('.*foo|.*bar')).toBe(false);
  });

  it('should accept safe alternation', () => {
    expect(isSafePattern('foo|bar|baz')).toBe(true);
  });

  it('should accept empty pattern', () => {
    expect(isSafePattern('')).toBe(true);
  });

  it('rejects overlapping alternation in quantified group: (a|a)+', () => {
    expect(isSafePattern('(a|a)+')).toBe(false);
  });

  it('rejects lazy quantifier in quantified group: (.+?)+', () => {
    expect(isSafePattern('(.+?)+')).toBe(false);
  });

  it('accepts simple safe patterns', () => {
    expect(isSafePattern('^[a-z]+$')).toBe(true);
    expect(isSafePattern('\\d{3}-\\d{4}')).toBe(true);
    expect(isSafePattern('foo|bar|baz')).toBe(true);
  });

  it('accepts alternation without quantified group', () => {
    expect(isSafePattern('(a|b)')).toBe(true);
  });
});
