import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  formatReceiptNdjson,
  hashDecisionReceipt,
  parseReceiptNdjson,
  verifyDecisionReceiptChain,
  type DecisionReceiptPayload,
} from 'veto-receipt-protocol';
import type { HeadlessResult } from './headless.js';

export const DEFAULT_RECEIPTS_PATH = '.veto/receipts.ndjson';

export interface ReceiptsExportOptions {
  inputPath?: string;
  outputPath?: string;
  format?: string;
  baseUrl?: string;
  apiKey?: string;
  projectId?: string;
  startDate?: string;
  endDate?: string;
  cursor?: string | number;
  limit?: string | number;
}

export interface ReceiptsVerifyOptions {
  inputPath?: string;
}

export interface ReceiptsExportResult {
  source: 'local' | 'cloud';
  inputPath?: string;
  outputPath?: string;
  count: number;
  ndjson?: string;
}

export interface ReceiptsVerifyResult {
  path: string;
  count: number;
  finalReceiptHash: string | null;
}

function ok<T>(data: T): HeadlessResult<T> {
  return { ok: true, data };
}

function fail<T>(code: string, message: string, details?: unknown): HeadlessResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      details,
    },
  };
}

function resolveReceiptsPath(pathValue: string | undefined): string {
  return resolve(pathValue ?? DEFAULT_RECEIPTS_PATH);
}

function writeOutput(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

function buildExportUrl(options: ReceiptsExportOptions, cursor?: string): URL {
  const baseUrl = (options.baseUrl ?? '').trim().replace(/\/$/, '');
  if (!baseUrl) {
    throw new Error('--base-url is required for cloud receipt export');
  }
  const url = new URL('/v1/receipts/export', baseUrl);
  url.searchParams.set('format', 'ndjson');
  if (options.projectId) url.searchParams.set('projectId', options.projectId);
  if (options.startDate) url.searchParams.set('startDate', options.startDate);
  if (options.endDate) url.searchParams.set('endDate', options.endDate);
  if (cursor !== undefined) {
    url.searchParams.set('cursor', cursor);
  } else if (options.cursor !== undefined) {
    url.searchParams.set('cursor', parseBoundedInteger(options.cursor, 'cursor', 0, Number.MAX_SAFE_INTEGER));
  }
  if (options.limit !== undefined) url.searchParams.set('limit', parseBoundedInteger(options.limit, 'limit', 1, 10_000));
  return url;
}

function parseBoundedInteger(
  value: string | number,
  name: string,
  min: number,
  max: number,
): string {
  const raw = typeof value === 'number' ? String(value) : value.trim();
  if (!/^\d+$/.test(raw)) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  return String(parsed);
}

async function fetchCloudReceipts(options: ReceiptsExportOptions): Promise<string> {
  const apiKey = (options.apiKey ?? process.env.VETO_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new Error('--api-key or VETO_API_KEY is required for cloud receipt export');
  }

  let cursor = options.cursor === undefined
    ? undefined
    : parseBoundedInteger(options.cursor, 'cursor', 0, Number.MAX_SAFE_INTEGER);
  const chunks: string[] = [];

  while (true) {
    const response = await fetch(buildExportUrl(options, cursor), {
      headers: {
        'x-veto-api-key': apiKey,
        accept: 'application/x-ndjson, text/plain',
      },
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`receipt export returned ${response.status}: ${body}`);
    }

    chunks.push(body);
    const nextCursor = response.headers.get('x-veto-next-cursor');
    if (!nextCursor) {
      break;
    }
    cursor = parseBoundedInteger(nextCursor, 'cursor', 0, Number.MAX_SAFE_INTEGER);
  }

  return chunks.join('');
}

function normalizeReceiptExport(content: string): { receipts: DecisionReceiptPayload[]; ndjson: string } {
  const receipts = parseReceiptNdjson(content);
  const verified = verifyDecisionReceiptChain(receipts);
  if (!verified.ok) {
    throw new Error(verified.reason ?? `receipt chain failed at index ${verified.breakAt ?? '?'}`);
  }
  return {
    receipts,
    ndjson: formatReceiptNdjson(receipts),
  };
}

export async function runReceiptsExportCommand(
  options: ReceiptsExportOptions = {},
): Promise<HeadlessResult<ReceiptsExportResult>> {
  try {
    if (options.format && options.format !== 'ndjson') {
      throw new Error(`Unsupported receipt export format '${options.format}'. Expected ndjson.`);
    }

    const cloudExport = Boolean(options.baseUrl);
    const inputPath = cloudExport ? undefined : resolveReceiptsPath(options.inputPath);
    if (inputPath && !existsSync(inputPath)) {
      return fail('receipts_not_found', `Receipt log not found: ${inputPath}`);
    }

    const raw = cloudExport ? await fetchCloudReceipts(options) : readFileSync(inputPath!, 'utf-8');
    const normalized = normalizeReceiptExport(raw);
    const outputPath = options.outputPath ? resolve(options.outputPath) : undefined;
    if (outputPath) {
      writeOutput(outputPath, normalized.ndjson);
    }

    return ok({
      source: cloudExport ? 'cloud' : 'local',
      inputPath,
      outputPath,
      count: normalized.receipts.length,
      ndjson: outputPath ? undefined : normalized.ndjson,
    });
  } catch (error) {
    return fail('receipts_export_failed', 'Failed to export receipts.', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export function runReceiptsVerifyCommand(
  options: ReceiptsVerifyOptions = {},
): HeadlessResult<ReceiptsVerifyResult> {
  try {
    const path = resolveReceiptsPath(options.inputPath);
    if (!existsSync(path)) {
      return fail('receipts_not_found', `Receipt log not found: ${path}`);
    }

    const receipts = parseReceiptNdjson(readFileSync(path, 'utf-8'));
    const verified = verifyDecisionReceiptChain(receipts);
    if (!verified.ok) {
      return fail('receipts_chain_broken', verified.reason ?? 'Receipt chain is broken.', {
        breakAt: verified.breakAt,
      });
    }

    return ok({
      path,
      count: receipts.length,
      finalReceiptHash: receipts.length > 0 ? hashDecisionReceipt(receipts[receipts.length - 1]!) : null,
    });
  } catch (error) {
    return fail('receipts_verify_failed', 'Failed to verify receipts.', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
