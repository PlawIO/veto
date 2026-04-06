import re

MAX_PATTERN_LENGTH = 256

_NESTED_QUANTIFIER_ON_GROUP = re.compile(r'[+*}]\s*\)\s*[+*{]')
_ADJACENT_QUANTIFIERS = re.compile(r'[+*}]\s*[+*{]')
_OVERLAPPING_ALTERNATION = re.compile(r'\.\*.*\|.*\.\*')
_LAZY_IN_QUANTIFIED_GROUP = re.compile(r'\([^)]*[+*][?][^)]*\)\s*[+*{]')


def _has_quantified_alternation(pattern: str) -> bool:
    """Linear scan for alternation inside a quantified group: (a|b)+, ((a|b))+"""
    depth = 0
    has_alt = False
    i = 0
    while i < len(pattern):
        ch = pattern[i]
        if ch == '\\':
            i += 2
            continue
        if ch == '(':
            if depth == 0:
                has_alt = False
            depth += 1
        elif ch == '|' and depth > 0:
            has_alt = True
        elif ch == ')':
            depth -= 1
            if depth == 0 and has_alt:
                j = i + 1
                while j < len(pattern) and pattern[j] == ' ':
                    j += 1
                if j < len(pattern) and pattern[j] in ('+', '*', '{'):
                    return True
        i += 1
    return False


def is_safe_pattern(pattern: str) -> bool:
    if len(pattern) > MAX_PATTERN_LENGTH:
        return False
    if _NESTED_QUANTIFIER_ON_GROUP.search(pattern):
        return False
    if _ADJACENT_QUANTIFIERS.search(pattern):
        return False
    if _OVERLAPPING_ALTERNATION.search(pattern):
        return False
    if _has_quantified_alternation(pattern):
        return False
    if _LAZY_IN_QUANTIFIED_GROUP.search(pattern):
        return False
    return True
