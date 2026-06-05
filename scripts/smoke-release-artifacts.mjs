#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = process.cwd();
const args = new Set(process.argv.slice(2).filter((arg) => arg !== "--"));
for (const arg of args) {
  if (!["--npm", "--python"].includes(arg)) {
    throw new Error(`Unknown argument ${arg}. Expected --npm, --python, or no arguments.`);
  }
}
const runNpm = args.size === 0 || args.has("--npm");
const runPython = args.size === 0 || args.has("--python");
const python = process.env.PYTHON ?? "python";

function run(command, commandArgs, options = {}) {
  execFileSync(command, commandArgs, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: "inherit",
  });
}

function output(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
  }).trim();
}

function findOne(dir, pattern, label) {
  const matches = readdirSync(dir)
    .filter((entry) => pattern.test(entry))
    .map((entry) => join(dir, entry))
    .sort();
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${label} in ${dir}, found ${matches.length}`);
  }
  return matches[0];
}

function pythonExecutable(venvDir) {
  const relative = process.platform === "win32" ? "Scripts/python.exe" : "bin/python";
  return join(venvDir, relative);
}

function smokeNpm(tmpRoot) {
  const packDir = join(tmpRoot, "npm-pack");
  const installDir = join(tmpRoot, "npm-install");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });

  run("pnpm", ["--dir", "packages/receipt-protocol", "pack", "--pack-destination", packDir]);
  run("pnpm", ["--dir", "packages/spend-capsule-protocol", "pack", "--pack-destination", packDir]);
  run("pnpm", ["--dir", "packages/sdk", "pack", "--pack-destination", packDir]);
  run("pnpm", ["--dir", "packages/cli", "pack", "--pack-destination", packDir]);

  const receiptTarball = findOne(packDir, /^veto-receipt-protocol-.*\.tgz$/, "veto-receipt-protocol tarball");
  const capsuleTarball = findOne(
    packDir,
    /^veto-spend-capsule-protocol-.*\.tgz$/,
    "veto-spend-capsule-protocol tarball",
  );
  const sdkTarball = findOne(packDir, /^veto-sdk-.*\.tgz$/, "veto-sdk tarball");
  const cliTarball = findOne(packDir, /^veto-cli-.*\.tgz$/, "veto-cli tarball");

  writeFileSync(join(installDir, "package.json"), '{"type":"module","private":true}\n');
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      receiptTarball,
      capsuleTarball,
      sdkTarball,
      cliTarball,
    ],
    { cwd: installDir },
  );

  run(
    "node",
    [
      "--input-type=module",
      "-e",
      [
        "const sdk = await import('veto-sdk');",
        "const cli = await import('veto-sdk/cli-runner');",
        "const receipts = await import('veto-receipt-protocol');",
        "const capsules = await import('veto-spend-capsule-protocol');",
        "if (typeof sdk.Veto !== 'function') throw new Error('veto-sdk Veto export missing');",
        "if (typeof sdk.protect !== 'function') throw new Error('veto-sdk protect export missing');",
        "if (typeof cli.runCli !== 'function') throw new Error('veto-sdk/cli-runner runCli export missing');",
        "if (typeof receipts.verifyDecisionReceiptChain !== 'function') throw new Error('receipt verifier export missing');",
        "if (typeof capsules.verifyCapsule !== 'function') throw new Error('capsule verifier export missing');",
      ].join("\n"),
    ],
    { cwd: installDir },
  );

  run("node", [join(installDir, "node_modules/veto-cli/dist/bin.js"), "version"]);
}

function smokePython(tmpRoot) {
  const distDir = join(tmpRoot, "python-dist");
  const venvDir = join(tmpRoot, "python-venv");

  run(python, ["-m", "pip", "install", "--upgrade", "pip", "build"]);
  run(python, ["-m", "build", "--outdir", distDir, "packages/sdk-python"]);

  const wheel = findOne(distDir, /^veto-.*\.whl$/, "Python wheel");
  run(python, ["-m", "venv", venvDir]);
  const venvPython = pythonExecutable(venvDir);
  if (!existsSync(venvPython)) {
    throw new Error(`Python venv did not create ${venvPython}`);
  }

  run(venvPython, ["-m", "pip", "install", "--upgrade", "pip"]);
  run(venvPython, ["-m", "pip", "install", wheel]);
  run(venvPython, [
    "-c",
    [
      "import veto",
      "from veto import Veto, protect, verify_receipt_chain",
      "assert Veto is not None",
      "assert callable(protect)",
      "assert callable(verify_receipt_chain)",
    ].join("; "),
  ]);

  const version = output(venvPython, ["-c", "import importlib.metadata; print(importlib.metadata.version('veto'))"]);
  console.log(`Python wheel smoke installed veto ${version}`);
}

const tmpRoot = mkdtempSync(join(tmpdir(), "veto-release-smoke-"));

try {
  if (runNpm) {
    smokeNpm(tmpRoot);
  }
  if (runPython) {
    smokePython(tmpRoot);
  }
  console.log("Release artifact smoke checks passed.");
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
