---
"veto-sdk": patch
---

Harden SDK fail-closed behavior: core and browser `protect()` now fail closed on initialization errors by default, while retaining the explicit unsafe `allowAllOnInitError` opt-in; Claude Code hooks now fail closed for configured projects on malformed payloads or guard failures, with `VETO_HOOK_FAIL_OPEN=1` as the explicit unsafe legacy opt-in.
