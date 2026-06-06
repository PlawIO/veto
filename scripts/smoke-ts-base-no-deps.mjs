#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(new URL("..", import.meta.url).pathname);
const sdkDir = join(root, "packages", "sdk");
const deniedRuntimeDeps = new Set([
  "ajv",
  "picocolors",
  "veto-receipt-protocol",
  "yaml",
]);

function run(cmd, args, options = {}) {
  execFileSync(cmd, args, {
    cwd: options.cwd ?? root,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });
}

run("pnpm", ["--filter", "veto-receipt-protocol", "build"]);
run("pnpm", ["--filter", "veto-sdk", "build"]);

const tmp = mkdtempSync(join(tmpdir(), "veto-ts-base-"));
const packDir = join(tmp, "pack");
const appDir = join(tmp, "app");
mkdirSync(packDir);
mkdirSync(appDir);

run("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir], { cwd: sdkDir });

const tarballs = readdirSync(packDir).filter((entry) => entry.endsWith(".tgz"));
if (tarballs.length !== 1) {
  throw new Error(`expected one packed veto-sdk tarball, found ${tarballs.join(", ")}`);
}

run("npm", ["init", "-y"], { cwd: appDir });
run(
  "npm",
  [
    "install",
    "--ignore-scripts",
    "--omit=peer",
    "--omit=optional",
    "--no-audit",
    "--no-fund",
    join(packDir, tarballs[0]),
  ],
  { cwd: appDir }
);

const installedPackageJson = JSON.parse(
  readFileSync(join(appDir, "node_modules", "veto-sdk", "package.json"), "utf8")
);
const deps = Object.keys(installedPackageJson.dependencies ?? {});
const unexpectedManifestDeps = deps.filter((dep) => deniedRuntimeDeps.has(dep));
if (unexpectedManifestDeps.length > 0) {
  throw new Error(`veto-sdk base manifest has runtime deps: ${unexpectedManifestDeps.join(", ")}`);
}

const installedTopLevel = new Set(
  readdirSync(join(appDir, "node_modules")).filter((entry) => entry !== ".package-lock.json")
);
const unexpectedInstalledDeps = [...deniedRuntimeDeps].filter((dep) => installedTopLevel.has(dep));
if (unexpectedInstalledDeps.length > 0) {
  throw new Error(`base install pulled optional deps: ${unexpectedInstalledDeps.join(", ")}`);
}

const vetoBin = join(appDir, "node_modules", ".bin", "veto");
const mcpProxyBin = join(appDir, "node_modules", ".bin", "veto-mcp-proxy");
const helpOutput = execFileSync(vetoBin, ["--help"], { cwd: appDir, encoding: "utf8" });
if (!helpOutput.includes("Usage:")) {
  throw new Error("base veto --help did not print usage");
}

const versionOutput = execFileSync(vetoBin, ["version"], { cwd: appDir, encoding: "utf8" });
if (!/^veto v/.test(versionOutput.trim())) {
  throw new Error(`base veto version returned unexpected output: ${versionOutput}`);
}

const mcpProxyHelpOutput = execFileSync(mcpProxyBin, ["--help"], { cwd: appDir, encoding: "utf8" });
if (!mcpProxyHelpOutput.includes("Usage: veto-mcp-proxy")) {
  throw new Error("base veto-mcp-proxy --help did not print usage");
}

const initWithoutPeers = spawnSync(vetoBin, ["init"], {
  cwd: appDir,
  encoding: "utf8",
});
if (initWithoutPeers.status !== 1) {
  throw new Error(`base veto init should fail without CLI peers, got ${initWithoutPeers.status}`);
}
if (!initWithoutPeers.stderr.includes("optional CLI peer dependencies")) {
  throw new Error(`base veto init did not explain missing CLI peers: ${initWithoutPeers.stderr}`);
}
if (initWithoutPeers.stderr.includes("at ModuleJob") || initWithoutPeers.stderr.includes("Node.js v")) {
  throw new Error(`base veto init leaked a module stack trace: ${initWithoutPeers.stderr}`);
}

const sdk = await import(pathToFileURL(join(appDir, "node_modules", "veto-sdk", "dist", "index.js")));
const local = sdk.Veto.local({
  bundle: {
    rules: [
      {
        id: "deny-large-wire",
        name: "Deny large wire transfer",
        enabled: true,
        severity: "critical",
        action: "block",
        tools: ["wire_transfer"],
        conditions: [
          {
            field: "arguments.amount",
            operator: "greater_than",
            value: 1000,
          },
        ],
      },
    ],
  },
  logLevel: "silent",
});

const denied = await local.validate("wire_transfer", { amount: 2500 });
if (denied.decision !== "deny") {
  throw new Error(`expected deny decision, got ${denied.decision}`);
}

const allowed = await local.validate("wire_transfer", { amount: 25 });
if (allowed.decision !== "allow") {
  throw new Error(`expected allow decision, got ${allowed.decision}`);
}

if (typeof sdk.protect !== "function") {
  throw new Error("root protect export is missing");
}
