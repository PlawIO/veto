---
"veto-sdk": patch
"@veto/python-release": patch
---

Cross-SDK regex parity + small cleanups.

- TS expression-DSL `matches` operator is now case-insensitive by default, matching the Python SDK. Same policy expression now produces the same decision in both SDKs. Opt back into case-sensitive matching with an inline `(?-i)` prefix at the start of the pattern.
- Removed duplicate `len > MAX_PATTERN_LENGTH` checks in `create_safe_regex` (Python) and `createSafeRegex` (TS) — `is_safe_pattern` / `isSafePattern` already enforces the cap.

Behaviour change: TS-only policies that depended on case-sensitive `matches` will need `(?-i)` added to the pattern.
