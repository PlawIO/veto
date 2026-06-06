#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const outputDir = mkdtempSync(join(tmpdir(), 'veto-finance-demo-'));
const demoPath = join(root, 'examples', 'finance-grade-agent', 'finance-demo.mjs');
const cliPath = join(root, 'packages', 'sdk', 'dist', 'cli', 'bin.js');

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      ...options.env,
    },
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

try {
  run('pnpm', ['--filter', 'veto-receipt-protocol', 'build'], { stdio: 'inherit' });
  run('pnpm', ['--filter', 'veto-sdk', 'build'], { stdio: 'inherit' });

  const demoOutput = run(process.execPath, [demoPath], {
    env: {
      VETO_FINANCE_DEMO_OUT: outputDir,
    },
  });
  process.stdout.write(demoOutput);

  const summaryPath = join(outputDir, 'summary.json');
  const receiptsPath = join(outputDir, 'receipts.ndjson');
  const approvalPath = join(outputDir, 'approval-request.json');
  const summary = readJson(summaryPath);

  assert(summary.ok === true, 'summary.ok must be true');
  assert(summary.receiptCount === 3, `expected 3 receipts, got ${summary.receiptCount}`);
  assert(summary.verified?.ok === true, 'summary.verified.ok must be true');
  assert(existsSync(receiptsPath), 'receipts.ndjson was not written');
  assert(existsSync(approvalPath), 'approval-request.json was not written');

  const decisions = summary.decisions.map((decision) => decision.decision);
  assert(
    JSON.stringify(decisions) === JSON.stringify(['allow', 'deny', 'require_approval']),
    `unexpected decision sequence: ${decisions.join(', ')}`,
  );

  const verifyResult = JSON.parse(
    run(process.execPath, [cliPath, 'receipts', 'verify', receiptsPath, '--json']),
  );
  assert(verifyResult.ok === true, 'CLI receipt verification failed');
  assert(verifyResult.data?.count === 3, `CLI verified ${verifyResult.data?.count} receipts`);

  const finalDecision = summary.decisions[summary.decisions.length - 1];
  const showResult = JSON.parse(
    run(process.execPath, [
      cliPath,
      'receipts',
      'show',
      finalDecision.receiptId,
      '--input',
      receiptsPath,
      '--json',
    ]),
  );
  assert(showResult.ok === true, 'CLI receipts show failed');
  assert(
    showResult.data?.receipt?.decision === 'require_approval',
    `expected final receipt to require approval, got ${showResult.data?.receipt?.decision}`,
  );

  console.log(`Finance demo smoke passed: ${receiptsPath}`);
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
