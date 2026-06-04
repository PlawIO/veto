import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  buildDecisionReceipt,
  formatReceiptNdjson,
  hashCanonical,
  parseReceiptNdjson,
  type DecisionReceiptPayload,
} from 'veto-receipt-protocol';
import { runMcpImportCommand } from '../../src/cli/mcp-import.js';
import { runReceiptsExportCommand, runReceiptsVerifyCommand } from '../../src/cli/receipts.js';

const TMP_ROOT = `/tmp/veto-receipts-cli-test-${Date.now()}`;
const DIGEST_ZERO = `sha256:${'0'.repeat(64)}`;

function tmpPath(name: string): string {
  return join(TMP_ROOT, name);
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

function receipt(
  index: number,
  previous: DecisionReceiptPayload | null,
  decision: 'allow' | 'deny' = 'allow',
): DecisionReceiptPayload {
  return buildDecisionReceipt({
    previous,
    draft: {
      receipt_id: `rcp_${String(index).padStart(24, '0')}`,
      organization_id: 'org-1',
      project_id: 'project-1',
      decision_id: `decision-${index}`,
      approval_id: null,
      session_id: null,
      agent_id: 'agent-1',
      client_id: null,
      connection_id: null,
      upstream_id: null,
      tool_name: 'approve_invoice',
      tool_schema_hash: null,
      policy_id: 'policy-1',
      policy_version: '1',
      policy_hash: hashCanonical({ policy: 1 }),
      decision,
      reason_code: decision,
      reason_detail: decision === 'allow' ? 'Allowed' : 'Denied',
      redacted_arguments: { amount: 120 },
      argument_hash: hashCanonical({ amount: 120 }),
      result_hash: decision === 'allow' ? DIGEST_ZERO : null,
      approval_hash: null,
      timestamp: new Date(Date.UTC(2026, 0, index, 0, 0, 0)).toISOString(),
      trace_id: null,
    },
  });
}

describe('receipt and MCP import CLI commands', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(TMP_ROOT)) {
      rmSync(TMP_ROOT, { recursive: true, force: true });
    }
  });

  it('exports, verifies, and rejects tampered receipt NDJSON', async () => {
    const first = receipt(1, null);
    const second = receipt(2, first);
    const inputPath = tmpPath('receipts.ndjson');
    const outputPath = tmpPath('out/receipts.ndjson');
    write(inputPath, formatReceiptNdjson([first, second]));

    const exported = await runReceiptsExportCommand({ inputPath, outputPath });
    expect(exported.ok).toBe(true);
    expect(exported.data?.count).toBe(2);
    expect(existsSync(outputPath)).toBe(true);

    const verified = runReceiptsVerifyCommand({ inputPath: outputPath });
    expect(verified.ok).toBe(true);
    expect(verified.data?.count).toBe(2);
    expect(verified.data?.finalReceiptHash).toMatch(/^sha256:[0-9a-f]{64}$/);

    const tampered = parseReceiptNdjson(readFileSync(outputPath, 'utf-8'));
    tampered[0] = { ...tampered[0]!, reason_detail: 'Tampered' };
    const tamperedPath = tmpPath('tampered.ndjson');
    write(tamperedPath, formatReceiptNdjson(tampered));

    const failed = runReceiptsVerifyCommand({ inputPath: tamperedPath });
    expect(failed.ok).toBe(false);
    expect(failed.error?.code).toBe('receipts_chain_broken');
  });

  it('rejects invalid cloud receipt export pagination locally', async () => {
    const exported = await runReceiptsExportCommand({
      baseUrl: 'https://api.veto.example',
      apiKey: 'veto_test',
      limit: 'abc',
    });

    expect(exported.ok).toBe(false);
    expect(exported.error?.code).toBe('receipts_export_failed');
    expect(exported.error?.details).toMatchObject({
      reason: '--limit must be an integer between 1 and 10000',
    });
  });

  it('exports cloud receipts from the v1 endpoint across cursor pages', async () => {
    const first = receipt(1, null);
    const second = receipt(2, first);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(formatReceiptNdjson([first]), {
        headers: { 'X-Veto-Next-Cursor': '1' },
      }),
    ).mockResolvedValueOnce(
      new Response(formatReceiptNdjson([second])),
    );

    const exported = await runReceiptsExportCommand({
      baseUrl: 'https://api.veto.example',
      apiKey: 'veto_test',
      projectId: 'project-1',
      limit: 1,
    });

    expect(exported.ok).toBe(true);
    expect(exported.data?.source).toBe('cloud');
    expect(exported.data?.count).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toBe('https://api.veto.example/v1/receipts/export?format=ndjson&projectId=project-1&limit=1');
    expect(urls[1]).toBe('https://api.veto.example/v1/receipts/export?format=ndjson&projectId=project-1&cursor=1&limit=1');
  });

  it('imports generic MCP JSON with dry-run, backup, and restore support', () => {
    const projectDir = tmpPath('project');
    const clientPath = join(projectDir, 'mcp.json');
    const original = {
      mcpServers: {
        filesystem: {
          command: 'mcp-filesystem',
          args: ['--root', '/workspace'],
        },
      },
    };
    write(clientPath, JSON.stringify(original, null, 2));

    const dryRun = runMcpImportCommand({
      directory: projectDir,
      inputPath: 'mcp.json',
      dryRun: true,
      serverName: 'veto-local',
    });
    expect(dryRun.ok).toBe(true);
    expect(dryRun.data?.clients[0]?.importedServers).toEqual(['filesystem']);
    expect(JSON.parse(readFileSync(clientPath, 'utf-8'))).toEqual(original);
    expect(existsSync(join(projectDir, 'veto', 'mcp.config.yaml'))).toBe(false);

    const imported = runMcpImportCommand({
      directory: projectDir,
      inputPath: 'mcp.json',
      serverName: 'veto-local',
    });
    expect(imported.ok).toBe(true);
    expect(imported.data?.gatewayConfigUpdated).toBe(true);
    expect(imported.data?.clients[0]?.backupPath).toBeTruthy();
    expect(existsSync(imported.data!.clients[0]!.backupPath!)).toBe(true);

    const rewired = JSON.parse(readFileSync(clientPath, 'utf-8')) as {
      mcpServers?: Record<string, { command?: string; args?: string[] }>;
    };
    expect(Object.keys(rewired.mcpServers ?? {})).toEqual(['veto-local']);
    expect(rewired.mcpServers?.['veto-local']?.command).toBe('veto-mcp-proxy');
    expect(readFileSync(join(projectDir, 'veto', 'mcp.config.yaml'), 'utf-8')).toContain('filesystem');

    const restored = runMcpImportCommand({
      directory: projectDir,
      inputPath: 'mcp.json',
      restore: true,
    });
    expect(restored.ok).toBe(true);
    expect(JSON.parse(readFileSync(clientPath, 'utf-8'))).toEqual(original);
  });
});
