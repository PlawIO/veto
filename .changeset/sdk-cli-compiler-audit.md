---
"veto-sdk": patch
---

Improve CLI policy generation and clean-build reliability.

- make local `veto policy generate --tool ...` consistently target the requested tool
- make `veto guard check --mode local` report real SDK approval decisions
- honor `veto init --directory ...`
- harden optional-provider and LangChain imports so clean-container builds succeed without extra packages installed
