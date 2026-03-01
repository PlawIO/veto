# Linear ↔ GitHub Issues Sync

SDK and CLI issues from the shared Linear team (PLW) are synced here.

**Routing rule:** Linear issues whose title starts with `[sdk`, `[sdk-ts`, or `[cli` land in this repo. All other issues go to [PlawIO/veto-platform](https://github.com/PlawIO/veto-platform).

See [veto-platform/.github/LINEAR_SYNC.md](https://github.com/PlawIO/veto-platform/blob/main/.github/LINEAR_SYNC.md) for the full setup — routing, user map, onboarding a new team member, secrets, and anti-conflict details.

## Secrets required

| Secret | Purpose |
|---|---|
| `LINEAR_API_KEY` | read Linear, write back on close/assign |
