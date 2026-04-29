---
"veto-sdk": patch
---

Harden proxy streaming and benchmark dataset parsing.

- stop OpenAI streaming proxy responses after a synthetic blocked event so clients receive only one terminal `[DONE]`
- preserve `tools: []` as an empty tool list when loading benchmark dataset rules
- add focused proxy and benchmark regression coverage for these runtime paths
