#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { getAgtComparison } from './agt-adapter.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_EVALUATOR = resolve(ROOT, 'packages/sdk/dist/rules/local-evaluator.js');
const PACK_DIR = resolve(ROOT, 'packages/sdk/packs');
const requireFromSdk = createRequire(resolve(ROOT, 'packages/sdk/package.json'));

const DEFAULTS = {
  pr: {
    localIterations: 50_000,
    serverIterations: 250,
  },
  full: {
    localIterations: 1_000_000,
    serverIterations: 10_000,
  },
};

const THRESHOLDS = {
  'single-rule-local': 0.05,
  'hundred-rule-local': 0.5,
  'server-loopback': 30,
};

function parseArgs(argv) {
  const args = {
    mode: 'pr',
    gate: false,
    baselineDir: resolve(ROOT, 'benchmark/baselines'),
    output: resolve(ROOT, 'benchmark/results/latest.json'),
    serverUrl: process.env.VETO_BENCHMARK_SERVER_URL ?? 'http://localhost:3001',
    includeServer: process.env.VETO_BENCHMARK_SERVER === '1',
  };

  for (const arg of argv) {
    if (arg === '--gate') args.gate = true;
    else if (arg === '--include-server') args.includeServer = true;
    else if (arg.startsWith('--mode=')) args.mode = arg.slice('--mode='.length);
    else if (arg.startsWith('--baseline-dir=')) args.baselineDir = resolve(ROOT, arg.slice('--baseline-dir='.length));
    else if (arg.startsWith('--output=')) args.output = resolve(ROOT, arg.slice('--output='.length));
    else if (arg.startsWith('--server-url=')) args.serverUrl = arg.slice('--server-url='.length);
    else if (arg.startsWith('--local-iterations=')) args.localIterations = Number(arg.slice('--local-iterations='.length));
    else if (arg.startsWith('--server-iterations=')) args.serverIterations = Number(arg.slice('--server-iterations='.length));
  }

  if (!DEFAULTS[args.mode]) {
    throw new Error(`Unknown --mode=${args.mode}; expected pr or full`);
  }

  args.localIterations ??= DEFAULTS[args.mode].localIterations;
  args.serverIterations ??= DEFAULTS[args.mode].serverIterations;
  return args;
}

function percentile(sorted, pct) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return sorted[index];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    p50_ms: percentile(sorted, 50),
    p95_ms: percentile(sorted, 95),
    p99_ms: percentile(sorted, 99),
    min_ms: sorted[0] ?? null,
    max_ms: sorted.at(-1) ?? null,
  };
}

function nowMs() {
  return performance.now();
}

function buildSingleRule() {
  return [
    {
      id: 'bench-block-rm-rf',
      name: 'Benchmark block rm -rf',
      enabled: true,
      severity: 'critical',
      action: 'block',
      tools: ['bash'],
      conditions: [
        { field: 'arguments.command', operator: 'contains', value: 'rm -rf' },
      ],
    },
  ];
}

async function loadPackRules() {
  const { parse: parseYaml } = await import(pathToFileURL(requireFromSdk.resolve('yaml')).href);
  const packFiles = ['coding-agent.yaml', 'financial.yaml', 'crypto-trading.yaml'];
  const rules = [];
  for (const file of packFiles) {
    const raw = await readFile(resolve(PACK_DIR, file), 'utf8');
    const parsed = parseYaml(raw);
    if (parsed && Array.isArray(parsed.rules)) {
      for (const rule of parsed.rules) {
        rules.push({ ...rule, source_pack: file });
      }
    }
  }
  return rules;
}

function buildHundredRuleCorpus(packRules) {
  if (packRules.length === 0) {
    throw new Error('No pack rules loaded for 100-rule benchmark');
  }

  const corpus = [];
  for (let i = 0; i < 100; i += 1) {
    const source = packRules[i % packRules.length];
    corpus.push({
      ...source,
      id: `${source.id ?? 'pack-rule'}__bench_${i}`,
      name: `${source.name ?? 'pack rule'} benchmark ${i}`,
      enabled: true,
      severity: source.severity ?? 'medium',
      action: i === 99 ? 'block' : source.action ?? 'warn',
      tools: ['benchmark_pack_tool'],
      conditions: i === 99
        ? [{ field: 'arguments.command', operator: 'contains', value: 'rm -rf' }]
        : [{ field: 'arguments.command', operator: 'contains', value: `never-match-${i}` }],
    });
  }
  return corpus;
}

async function runLocalWorkload({ id, name, iterations, rules, toolName, args, evaluateRulesLocally }) {
  for (let i = 0; i < 2_000; i += 1) {
    evaluateRulesLocally(rules, toolName, args);
  }

  const samples = new Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    const start = nowMs();
    evaluateRulesLocally(rules, toolName, args);
    samples[i] = nowMs() - start;
  }

  return {
    id,
    name,
    kind: 'local',
    iterations,
    threshold_p99_ms: THRESHOLDS[id],
    ...summarize(samples),
  };
}

async function canReachServer(serverUrl) {
  try {
    const response = await fetch(`${serverUrl}/health`, { method: 'GET', signal: AbortSignal.timeout(500) });
    return response.ok || response.status < 500;
  } catch {
    try {
      const response = await fetch(`${serverUrl}/v1/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ toolName: 'bash', arguments: { command: 'echo warmup' } }),
        signal: AbortSignal.timeout(500),
      });
      return response.status < 500;
    } catch {
      return false;
    }
  }
}

async function runServerWorkload({ iterations, serverUrl }) {
  if (!(await canReachServer(serverUrl))) {
    return {
      id: 'server-loopback',
      name: 'localhost PDP server eval',
      kind: 'server',
      iterations: 0,
      skipped: true,
      skip_reason: `No PDP reachable at ${serverUrl}. Start one and rerun with --include-server --server-url=${serverUrl}.`,
      threshold_p99_ms: THRESHOLDS['server-loopback'],
      p50_ms: null,
      p95_ms: null,
      p99_ms: null,
    };
  }

  const payload = JSON.stringify({ toolName: 'bash', arguments: { command: 'echo hello' } });
  const samples = new Array(iterations);
  for (let i = 0; i < iterations; i += 1) {
    const start = nowMs();
    const response = await fetch(`${serverUrl}/v1/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    await response.arrayBuffer();
    samples[i] = nowMs() - start;
  }

  return {
    id: 'server-loopback',
    name: 'localhost PDP server eval',
    kind: 'server',
    iterations,
    threshold_p99_ms: THRESHOLDS['server-loopback'],
    ...summarize(samples),
  };
}

async function loadBaselines(dir) {
  const ids = ['single-rule-local', 'hundred-rule-local', 'server-loopback'];
  const baselines = new Map();
  for (const id of ids) {
    const path = resolve(dir, `${id}.json`);
    if (!existsSync(path)) continue;
    baselines.set(id, JSON.parse(await readFile(path, 'utf8')));
  }
  return baselines;
}

function checkGate(results, baselines) {
  const failures = [];
  for (const result of results) {
    if (result.skipped || result.p99_ms === null) continue;
    const baseline = baselines.get(result.id);
    if (!baseline) {
      failures.push(`${result.id}: missing baseline`);
      continue;
    }
    const baselineP99 = Number(baseline.p99_ms);
    const allowed = baselineP99 * 1.10;
    if (result.p99_ms > allowed) {
      failures.push(`${result.id}: p99 ${result.p99_ms.toFixed(6)}ms > ${allowed.toFixed(6)}ms (baseline ${baselineP99}ms +10%)`);
    }
    if (result.threshold_p99_ms !== undefined && result.p99_ms > result.threshold_p99_ms) {
      failures.push(`${result.id}: p99 ${result.p99_ms.toFixed(6)}ms > threshold ${result.threshold_p99_ms}ms`);
    }
  }
  return failures;
}

function printTable(results) {
  console.log('| Workload | Iterations | p50 ms | p95 ms | p99 ms | Threshold p99 |');
  console.log('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const r of results) {
    const fmt = (v) => v === null || v === undefined ? 'skipped' : v.toFixed(6);
    console.log(`| ${r.name}${r.skipped ? ' (skipped)' : ''} | ${r.iterations} | ${fmt(r.p50_ms)} | ${fmt(r.p95_ms)} | ${fmt(r.p99_ms)} | ${r.threshold_p99_ms} |`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(DIST_EVALUATOR)) {
    throw new Error(`Missing ${DIST_EVALUATOR}. Run: pnpm --filter veto-sdk build`);
  }

  const { evaluateRulesLocally } = await import(pathToFileURL(DIST_EVALUATOR).href);
  const packRules = await loadPackRules();
  const hundredRules = buildHundredRuleCorpus(packRules);

  const results = [];
  results.push(await runLocalWorkload({
    id: 'single-rule-local',
    name: 'single-rule local eval',
    iterations: args.localIterations,
    rules: buildSingleRule(),
    toolName: 'bash',
    args: { arguments: { command: 'rm -rf /tmp/veto-bench' } },
    evaluateRulesLocally,
  }));
  results.push(await runLocalWorkload({
    id: 'hundred-rule-local',
    name: '100-rule local eval from merged packs',
    iterations: args.localIterations,
    rules: hundredRules,
    toolName: 'benchmark_pack_tool',
    args: { arguments: { command: 'rm -rf /tmp/veto-bench' } },
    evaluateRulesLocally,
  }));

  if (args.includeServer || args.mode === 'full') {
    results.push(await runServerWorkload({ iterations: args.serverIterations, serverUrl: args.serverUrl }));
  } else {
    results.push({
      id: 'server-loopback',
      name: 'localhost PDP server eval',
      kind: 'server',
      iterations: 0,
      skipped: true,
      skip_reason: 'Skipped in PR mode unless --include-server or VETO_BENCHMARK_SERVER=1 is set.',
      threshold_p99_ms: THRESHOLDS['server-loopback'],
      p50_ms: null,
      p95_ms: null,
      p99_ms: null,
    });
  }

  const report = {
    generated_at: new Date().toISOString(),
    mode: args.mode,
    hardware: {
      runner: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
      os: process.platform,
      arch: process.arch,
      node: process.version,
    },
    methodology: {
      local_iterations: args.localIterations,
      server_iterations: args.serverIterations,
      local_evaluator: 'packages/sdk/dist/rules/local-evaluator.js evaluateRulesLocally',
      hundred_rule_packs: ['coding-agent.yaml', 'financial.yaml', 'crypto-trading.yaml'],
      hundred_rule_note: 'Merged pack rules are expanded deterministically to 100 rules for a fixed corpus; final rule matches after scanning prior rules.',
    },
    results,
    competitors: [getAgtComparison()],
  };

  await mkdir(dirname(args.output), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`);
  printTable(results);
  console.log(`Wrote ${args.output}`);

  if (args.gate) {
    const baselines = await loadBaselines(args.baselineDir);
    const failures = checkGate(results, baselines);
    if (failures.length > 0) {
      console.error('Benchmark gate failed:');
      for (const failure of failures) console.error(`- ${failure}`);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
