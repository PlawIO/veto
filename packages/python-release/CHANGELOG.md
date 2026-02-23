# @veto/python-release

## 0.1.0

### Minor Changes

- [#126](https://github.com/VulnZap/veto/pull/126) [`521d540`](https://github.com/VulnZap/veto/commit/521d540bfbc80995c94438db7ad3e83be3882f04) Thanks [@yazcaleb](https://github.com/yazcaleb)! - Add a top-level async `protect()` one-liner API to TypeScript and Python SDKs.

  Highlights:

  - Introduce `protect()` as the primary onboarding entrypoint (`protect(tools)` and `protect(tool)`).
  - Add source auto-detection (rules/api key/endpoint/config/local), heuristic pack selection, and allow-all fallback.
  - Add module-level instance caching so repeated calls reuse initialized Veto state when options match.
  - Add browser entrypoint support for `protect()` with safe allow-all fallback behavior.
  - Add Python `Veto.from_rules()` parity helper and top-level `protect` export.
