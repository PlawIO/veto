#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cwd, exit } from "node:process";

const root = cwd();

const zones = [
  {
    id: "ts-sdk-runtime",
    description: "veto-sdk runtime dependencies are frozen until the zero-dep local kernel split lands.",
    file: "packages/sdk/package.json",
    type: "package-json",
    field: "dependencies",
    allowed: ["ajv", "picocolors", "veto-receipt-protocol", "yaml"],
  },
  {
    id: "ts-cli-runtime",
    description: "veto-cli may carry terminal/UI deps, but additions must be intentional.",
    file: "packages/cli/package.json",
    type: "package-json",
    field: "dependencies",
    allowed: ["@opentui/core", "ink", "picocolors", "react", "veto-sdk"],
  },
  {
    id: "receipt-protocol-runtime",
    description: "receipt protocol has an explicit audited dependency budget.",
    file: "packages/receipt-protocol/package.json",
    type: "package-json",
    field: "dependencies",
    allowed: ["@noble/hashes", "canonicalize"],
  },
  {
    id: "map-core-runtime",
    description: "MAP-Core protocol spine must stay dependency-free while it defines the trust-kernel contract.",
    file: "packages/map-core/package.json",
    type: "package-json",
    field: "dependencies",
    allowed: [],
  },
  {
    id: "rust-trust-kernel-runtime",
    description: "veto-core keeps Rust JSON/canonicalization/crypto dependencies explicit and audited.",
    file: "crates/veto-core/Cargo.toml",
    type: "cargo",
    field: "dependencies",
    allowed: ["serde", "serde_json", "sha2"],
  },
  {
    id: "spend-capsule-protocol-runtime",
    description: "spend capsule protocol keeps crypto/canonicalization dependencies explicit.",
    file: "packages/spend-capsule-protocol/package.json",
    type: "package-json",
    field: "dependencies",
    allowed: ["@noble/ed25519", "@noble/hashes", "@scure/base", "canonicalize", "jose", "veto-receipt-protocol"],
  },
  {
    id: "python-sdk-base",
    description: "Python base local enforcement must stay dependency-free; cloud/CLI/proxy/integration dependencies live in extras.",
    file: "packages/sdk-python/pyproject.toml",
    type: "pyproject",
    field: "project.dependencies",
    allowed: [],
  },
];

const sourceBoundaryRules = [
  {
    id: "map-core-no-app-imports",
    description: "MAP-Core must not import SDK, CLI, cloud, provider, or integration modules.",
    rootDir: "packages/map-core/src",
    extensions: [".ts"],
    forbidden: [
      /from\s+['"](?:veto-sdk|veto-cli|@veto\/)/,
      /^import\s+['"](?:veto-sdk|veto-cli|@veto\/)/m,
      /from\s+['"][^'"]*\/(?:cli|cloud|providers?|integrations?)\//,
    ],
  },
  {
    id: "ts-core-no-cli-imports",
    description: "TS core/local code must not import CLI modules.",
    rootDir: "packages/sdk/src/core",
    extensions: [".ts"],
    forbidden: [/from\s+['"]\.\.\/cli\//, /from\s+['"]\.\.\/.*\/cli\//],
  },
  {
    id: "python-core-no-cli-proxy-imports",
    description: "Python core/local code must not import CLI or proxy server modules.",
    rootDir: "packages/sdk-python/veto/core",
    extensions: [".py"],
    forbidden: [
      /^from veto\.cli import /m,
      /^import veto\.cli/m,
      /^from veto\.proxy import /m,
      /^from veto\.proxy\.server import /m,
      /^import veto\.proxy/m,
    ],
  },
  {
    id: "ts-sdk-no-legacy-receipt-shape",
    description: "TS SDK public surfaces must use veto.receipt/1 helpers, not legacy spend-capsule receipt chains.",
    rootDir: "packages/sdk/src",
    extensions: [".ts"],
    forbidden: [
      /(?:^|\s)from\s+['"]veto-spend-capsule-protocol['"]/m,
      /(?:^|\s)from\s+['"]@veto\/spend-capsule-protocol['"]/m,
      /\bverifyReceiptChain\b/,
      /\bprev_receipt_hash\b/,
    ],
  },
  {
    id: "python-sdk-no-legacy-receipt-shape",
    description: "Python SDK public surfaces must not expose legacy spend-capsule receipt chain fields.",
    rootDir: "packages/sdk-python/veto",
    extensions: [".py"],
    ignoreDirs: ["packages/sdk-python/veto/capsule"],
    forbidden: [
      /\bverifyReceiptChain\b/,
      /\bprev_receipt_hash\b/,
    ],
  },
];

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function dependencyNamesFromPackageJson(zone) {
  const json = readJson(zone.file);
  return Object.keys(json[zone.field] ?? {}).sort();
}

function parseTomlArrayItems(raw) {
  const items = [];
  const itemPattern = /"([^"]+)"/g;
  let match;
  while ((match = itemPattern.exec(raw)) !== null) {
    items.push(match[1]);
  }
  return items;
}

function basePythonPackageName(requirement) {
  const normalized = requirement.split(";")[0].trim().toLowerCase();
  const match = normalized.match(/^([a-z0-9_.-]+)/);
  return match ? match[1].replace(/_/g, "-") : normalized;
}

function dependencyNamesFromPyproject(zone) {
  const text = readFileSync(join(root, zone.file), "utf8");
  const match = text.match(/\[project\][\s\S]*?\ndependencies\s*=\s*\[([\s\S]*?)\]\n/);
  if (!match) {
    throw new Error(`${zone.file}: could not find [project] dependencies array`);
  }
  return parseTomlArrayItems(match[1]).map(basePythonPackageName).sort();
}

function dependencyNamesFromCargoToml(zone) {
  const text = readFileSync(join(root, zone.file), "utf8");
  const match = text.match(/\[dependencies\]\n([\s\S]*?)(?:\n\[|$)/);
  if (!match) {
    throw new Error(`${zone.file}: could not find [dependencies] table`);
  }
  const names = [];
  for (const rawLine of match[1].split("\n")) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const depMatch = line.match(/^([A-Za-z0-9_-]+)\s*=/);
    if (depMatch) names.push(depMatch[1]);
  }
  return names.sort();
}

function dependencyNames(zone) {
  if (zone.type === "package-json") return dependencyNamesFromPackageJson(zone);
  if (zone.type === "pyproject") return dependencyNamesFromPyproject(zone);
  if (zone.type === "cargo") return dependencyNamesFromCargoToml(zone);
  throw new Error(`Unknown zone type: ${zone.type}`);
}

function ignoredByRule(path, rule) {
  const relative = path.slice(root.length + 1);
  return (rule.ignoreDirs ?? []).some((ignored) => relative === ignored || relative.startsWith(`${ignored}/`));
}

function listFiles(rule) {
  const out = [];
  function walk(current) {
    if (ignoredByRule(current, rule)) return;
    for (const entry of readdirSync(current)) {
      if (entry === "__pycache__" || entry === "node_modules" || entry === "dist") continue;
      const path = join(current, entry);
      if (ignoredByRule(path, rule)) continue;
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (rule.extensions.some((extension) => path.endsWith(extension))) out.push(path);
    }
  }
  walk(join(root, rule.rootDir));
  return out;
}

const failures = [];

for (const zone of zones) {
  const actual = dependencyNames(zone);
  const allowed = [...zone.allowed].sort();
  const extra = actual.filter((dep) => !allowed.includes(dep));
  const missing = allowed.filter((dep) => !actual.includes(dep));

  if (extra.length > 0 || missing.length > 0) {
    failures.push([
      `${zone.id}: ${zone.description}`,
      extra.length > 0 ? `  unexpected: ${extra.join(", ")}` : null,
      missing.length > 0 ? `  budget missing from manifest: ${missing.join(", ")}` : null,
      `  file: ${zone.file}`,
    ].filter(Boolean).join("\n"));
  }
}

for (const rule of sourceBoundaryRules) {
  for (const file of listFiles(rule)) {
    const text = readFileSync(file, "utf8");
    for (const pattern of rule.forbidden) {
      if (pattern.test(text)) {
        failures.push(`${rule.id}: ${rule.description}\n  forbidden import matched ${pattern}\n  file: ${file}`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error("Dependency zone check failed:\n");
  console.error(failures.join("\n\n"));
  exit(1);
}

console.log("Dependency zone check passed.");
