const MAX_PATTERN_LENGTH = 256;
// Detect quantifier inside group followed by quantifier on the group: (a+)+, (a*){2,}, etc.
const NESTED_QUANTIFIER_ON_GROUP = /[+*}]\s*\)+\s*[+*{]/;
// Detect directly adjacent quantifiers: a++, a*+, etc.
const ADJACENT_QUANTIFIERS = /[+*}]\s*[+*{]/;
const OVERLAPPING_ALTERNATION = /\.\*.*\|.*\.\*/;
// Detect alternation inside quantified group, including nested: (a|a)+, (a|(b|c))+
const QUANTIFIED_ALTERNATION = /\((?:[^()]*|\([^()]*\))*\|(?:[^()]*|\([^()]*\))*\)\s*[+*{]/;
// Detect lazy quantifier inside quantified group: (.+?)+
const LAZY_IN_QUANTIFIED_GROUP = /\([^)]*[+*][?][^)]*\)\s*[+*{]/;

export function isSafePattern(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return false;
  if (NESTED_QUANTIFIER_ON_GROUP.test(pattern)) return false;
  if (ADJACENT_QUANTIFIERS.test(pattern)) return false;
  if (OVERLAPPING_ALTERNATION.test(pattern)) return false;
  if (QUANTIFIED_ALTERNATION.test(pattern)) return false;
  if (LAZY_IN_QUANTIFIED_GROUP.test(pattern)) return false;
  return true;
}
