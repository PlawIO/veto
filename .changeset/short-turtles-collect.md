---
"veto-sdk": minor
---

Add a browser-compatible SDK path for Chrome extensions, web workers, and MV3 service workers.

Highlights:

- Add `Veto.fromRules()` and `Veto.fromCloud()` factories for browser-safe initialization.
- Add `veto-sdk/browser` entrypoint with browser-safe exports and action wrappers.
- Add browser-specific tests and cloud reporting support without filesystem dependencies.
- Add lifecycle cleanup for cloud refresh intervals and resilient decision logging retries.
