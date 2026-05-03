# Benchmarks

This directory is for deterministic policy evaluation latency benchmarks. It is separate from `packages/sdk/src/benchmark`, which is model/kernel accuracy benchmarking.

## Commands

PR/CI mode:

```bash
pnpm --filter veto-sdk build
node benchmark/run.mjs --mode=pr --gate --baseline-dir=benchmark/baselines --output=benchmark/results/pr.json
```

Measured baseline refresh, including loopback PDP fixture:

```bash
pnpm --filter veto-sdk build
node benchmark/pdp-fixture.mjs &
node benchmark/run.mjs --mode=pr --include-server --gate --baseline-dir=benchmark/baselines --output=benchmark/results/baseline.json
```

Full local mode:

```bash
pnpm --filter veto-sdk build
node benchmark/run.mjs --mode=full --include-server --server-url=http://localhost:3001 --output=benchmark/results/full.json
```

For product-server latency, start the self-host PDP and point the benchmark at it:

```bash
docker compose up
node benchmark/run.mjs --mode=full --include-server --server-url=http://localhost:3001 --output=benchmark/results/server.json
```

## Hardware fields

Each run writes runner, OS, architecture, Node.js version, and timestamp. Current checked-in PR-mode local-eval baselines are measured from GitHub Actions output, not faster local hardware:

- runner: GitHub Actions
- os: linux
- arch: x64
- node: 20.x via `actions/setup-node@v4`
- source run: PR #208 `Policy eval latency` failure log
- command: `node benchmark/run.mjs --mode=pr --gate --baseline-dir=benchmark/baselines --output=benchmark/results/pr.json`

The `server-loopback` baseline is separate: it is measured against `benchmark/pdp-fixture.mjs` on local loopback because PR mode skips server latency unless a PDP is explicitly started.

## Workloads

| ID                   | Workload                                                                                                                           | Full iterations | PR/baseline iterations | p99 threshold |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------: | ---------------------: | ------------: |
| `single-rule-local`  | One deterministic local rule matching `bash` + `rm -rf`                                                                            |       1,000,000 |                 50,000 |     <= 0.05ms |
| `hundred-rule-local` | 100-rule deterministic local corpus built from merged `coding-agent.yaml`, `financial.yaml`, and `crypto-trading.yaml` pack shapes |       1,000,000 |                 50,000 |      <= 0.5ms |
| `server-loopback`    | HTTP `POST /v1/validate` against `localhost:3001` PDP                                                                              |          10,000 |                    250 |       <= 30ms |

The 100-rule corpus is deterministic: the benchmark loads the three named packs, cycles their rule shapes into exactly 100 rules, and makes the final rule match after scanning the prior rules. This keeps the workload stable while preserving realistic pack condition structures.

`server-loopback` baselines are measured against `benchmark/pdp-fixture.mjs`, a PDP-compatible HTTP endpoint that uses the SDK local evaluator over loopback. To publish product-server numbers, run the same workload against the self-hosted server and keep the source field explicit.

## Measured checked-in baselines

Baselines live in `benchmark/baselines/*.json`. They are actual measured Veto harness output; thresholds are separate fields. CI fails when a measured non-skipped workload has p99 latency greater than the checked-in measured baseline by more than 10%, or above the absolute threshold.

| Runtime | Workload                              | Iterations |        p50 |        p95 |        p99 | p99 threshold | Source                                                                        |
| ------- | ------------------------------------- | ---------: | ---------: | ---------: | ---------: | ------------: | ----------------------------------------------------------------------------- |
| Veto    | single-rule local eval                |     50,000 | 0.000260ms | 0.001092ms | 0.002594ms |        0.05ms | GitHub Actions PR-mode, `benchmark/baselines/single-rule-local.json`          |
| Veto    | 100-rule local eval from merged packs |     50,000 | 0.027471ms | 0.028653ms | 0.052098ms |         0.5ms | GitHub Actions PR-mode, `benchmark/baselines/hundred-rule-local.json`         |
| Veto    | localhost PDP server eval             |        250 | 0.402051ms | 0.841651ms | 2.092263ms |          30ms | local `benchmark/pdp-fixture.mjs`, `benchmark/baselines/server-loopback.json` |

## AGT comparison

`benchmark/agt-adapter.mjs` records AGT comparison metadata. The AGT values below are published comparison numbers from the charter and are not reproduced by this CI harness.

| Runtime | Published metric                   |        Value | Source    | Reproduced |
| ------- | ---------------------------------- | -----------: | --------- | ---------- |
| AGT     | policy eval latency per rule       | 0.012ms/rule | published | no         |
| AGT     | throughput at 50 concurrent agents |  35K ops/sec | published | no         |

Do not mark AGT values as reproduced unless an adapter runs in CI with pinned install instructions and records the reproduced output.
