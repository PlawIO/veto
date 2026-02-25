---
"veto-sdk": patch
"veto-cli": patch
---

fix(cli): lazy-load Studio renderers so Ink import failures fall back to ANSI instead of crashing on startup (for example on Node 22.12).
