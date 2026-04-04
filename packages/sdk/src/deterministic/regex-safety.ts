const MAX_PATTERN_LENGTH = 256;
// Detect quantifier inside group followed by quantifier on the group: (a+)+, (a*){2,}, etc.
const NESTED_QUANTIFIER_ON_GROUP = /[+*}]\s*\)+\s*[+*{]/;
// Detect directly adjacent quantifiers: a++, a*+, etc.
const ADJACENT_QUANTIFIERS = /[+*}]\s*[+*{]/;
const OVERLAPPING_ALTERNATION = /\.\*.*\|.*\.\*/;
// Detect lazy quantifier inside quantified group: (.+?)+
const LAZY_IN_QUANTIFIED_GROUP = /\([^)]*[+*][?][^)]*\)\s*[+*{]/;

function isQuantifier(ch: string | undefined): boolean {
  return ch === '+' || ch === '*' || ch === '{';
}

// Linear scan to detect alternation inside a quantified group,
// including nested groups: (a|a)+, (a|(b|c))+, ((a|b))+
function hasQuantifiedAlternation(pattern: string): boolean {
  let depth = 0;
  let hasAlt = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '(') {
      if (depth === 0) hasAlt = false;
      depth++;
    } else if (ch === '|' && depth > 0) {
      hasAlt = true;
    } else if (ch === ')') {
      depth--;
      if (depth === 0 && hasAlt) {
        let j = i + 1;
        while (j < pattern.length && pattern[j] === ' ') j++;
        if (isQuantifier(pattern[j])) return true;
      }
    }
  }
  return false;
}

export function isSafePattern(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_LENGTH) return false;
  if (NESTED_QUANTIFIER_ON_GROUP.test(pattern)) return false;
  if (ADJACENT_QUANTIFIERS.test(pattern)) return false;
  if (OVERLAPPING_ALTERNATION.test(pattern)) return false;
  if (hasQuantifiedAlternation(pattern)) return false;
  if (LAZY_IN_QUANTIFIED_GROUP.test(pattern)) return false;
  return true;
}
