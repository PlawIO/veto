/**
 * Tool call history tracking.
 *
 * This module manages the history of tool calls for a Veto instance,
 * providing context to validators about previous calls.
 *
 * @module core/history
 */

import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  DecisionExportFormat,
  DecisionExportRecord,
  ToolCallHistoryEntry,
  ValidationResult,
} from '../types/config.js';
import type { Logger } from '../utils/logger.js';
import { computeChainHash, GENESIS_HASH } from '../audit/chain.js';

/**
 * Options for the history tracker.
 */
export interface HistoryTrackerOptions {
  /** Maximum number of entries to keep */
  maxSize: number;
  /** Logger instance */
  logger: Logger;
  /** Append-only audit log configuration */
  auditLog?: {
    enabled: boolean;
    /** Defaults to .veto/audit.log */
    path?: string;
  };
}

/**
 * Tracks the history of tool calls for context.
 */
export class HistoryTracker {
  private readonly entries: ToolCallHistoryEntry[] = [];
  private readonly maxSize: number;
  private readonly logger: Logger;
  private readonly auditLogPath: string | null;
  private prevHash: string = GENESIS_HASH;
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(options: HistoryTrackerOptions) {
    this.maxSize = options.maxSize;
    this.logger = options.logger;

    if (options.auditLog?.enabled) {
      this.auditLogPath = options.auditLog.path ?? '.veto/audit.log';
      try {
        mkdirSync(dirname(this.auditLogPath), { recursive: true });
      } catch {
        // If we can't create the dir, writes will fail and be caught per-record.
      }
      this.prevHash = this.recoverPrevHash();
    } else {
      this.auditLogPath = null;
    }
  }

  /**
   * Add an entry to the history.
   *
   * If the history exceeds maxSize, the oldest entry is removed.
   *
   * @param entry - The history entry to add
   */
  add(entry: ToolCallHistoryEntry): void {
    const snapshotEntry: ToolCallHistoryEntry = {
      ...entry,
      arguments: this.cloneArguments(entry.arguments),
    };

    this.entries.push(snapshotEntry);

    // Remove oldest entries if we exceed max size
    while (this.entries.length > this.maxSize) {
      const removed = this.entries.shift();
      if (removed) {
        this.logger.debug('History entry evicted due to size limit', {
          evictedTool: removed.toolName,
          historySize: this.entries.length,
        });
      }
    }

    this.logger.debug('History entry added', {
      toolName: snapshotEntry.toolName,
      decision: snapshotEntry.validationResult.decision,
      historySize: this.entries.length,
    });

    if (this.auditLogPath !== null) {
      this.appendAuditRecord(snapshotEntry);
    }
  }

  private entryToExportRecord(entry: ToolCallHistoryEntry): DecisionExportRecord {
    const metadata = entry.validationResult.metadata;
    return {
      timestamp: entry.timestamp.toISOString(),
      tool_name: entry.toolName,
      arguments: entry.arguments,
      policy_version: this.extractMetadataString(metadata, ['policyVersion', 'policy_version']),
      rule_id: this.extractMetadataString(metadata, ['ruleId', 'rule_id']),
      decision: entry.validationResult.decision,
      reason: entry.validationResult.reason ?? null,
    };
  }

  private appendAuditRecord(entry: ToolCallHistoryEntry): void {
    const record = this.entryToExportRecord(entry);
    const hash = computeChainHash(this.prevHash, record);
    this.prevHash = hash;

    this.pendingWrite = this.pendingWrite.then(() =>
      appendFile(
        this.auditLogPath!,
        JSON.stringify({ ...record, chain_hash: hash }) + '\n',
        'utf-8',
      ).catch((err) => {
        this.logger.warn('Audit log write failed — continuing without audit record', {
          error: err instanceof Error ? err.message : String(err),
          path: this.auditLogPath,
        });
      }),
    );
  }

  /** Await all pending audit log writes. Useful in tests and graceful shutdown. */
  async flushAuditLog(): Promise<void> {
    await this.pendingWrite;
  }

  private recoverPrevHash(): string {
    if (!this.auditLogPath || !existsSync(this.auditLogPath)) return GENESIS_HASH;
    try {
      const content = readFileSync(this.auditLogPath, 'utf-8');
      const lines = content.trimEnd().split('\n');
      const lastLine = lines[lines.length - 1];
      if (!lastLine) return GENESIS_HASH;
      const parsed = JSON.parse(lastLine) as Record<string, unknown>;
      if (typeof parsed['chain_hash'] === 'string') return parsed['chain_hash'];
    } catch {
      // Corrupted or empty file — start fresh
    }
    return GENESIS_HASH;
  }

  /**
   * Record a tool call in the history.
   *
   * Convenience method that creates a history entry.
   *
   * @param toolName - Name of the tool called
   * @param args - Arguments passed to the tool
   * @param result - Validation result
   * @param durationMs - Optional execution duration
   */
  record(
    toolName: string,
    args: Record<string, unknown>,
    result: ValidationResult,
    durationMs?: number
  ): void {
    this.add({
      toolName,
      arguments: args,
      validationResult: result,
      timestamp: new Date(),
      durationMs,
    });
  }

  private cloneArguments(args: Record<string, unknown>): Record<string, unknown> {
    const structuredCloneImpl = globalThis.structuredClone as
      | ((value: Record<string, unknown>) => Record<string, unknown>)
      | undefined;

    if (structuredCloneImpl) {
      try {
        return structuredCloneImpl(args);
      } catch {
        // Fall through to a safer but less expressive clone strategy.
      }
    }

    try {
      return JSON.parse(JSON.stringify(args)) as Record<string, unknown>;
    } catch {
      return { ...args };
    }
  }

  /**
   * Get all history entries.
   *
   * Returns a frozen copy to prevent external modification.
   */
  getAll(): readonly ToolCallHistoryEntry[] {
    return Object.freeze([...this.entries]);
  }

  /**
   * Get the last N entries.
   *
   * @param count - Number of entries to retrieve
   */
  getLast(count: number): readonly ToolCallHistoryEntry[] {
    return Object.freeze(this.entries.slice(-count));
  }

  /**
   * Get entries for a specific tool.
   *
   * @param toolName - Name of the tool to filter by
   */
  getByTool(toolName: string): readonly ToolCallHistoryEntry[] {
    return Object.freeze(
      this.entries.filter((entry) => entry.toolName === toolName)
    );
  }

  /**
   * Get entries within a time range.
   *
   * @param since - Start of the time range
   * @param until - End of the time range (defaults to now)
   */
  getByTimeRange(
    since: Date,
    until: Date = new Date()
  ): readonly ToolCallHistoryEntry[] {
    return Object.freeze(
      this.entries.filter(
        (entry) => entry.timestamp >= since && entry.timestamp <= until
      )
    );
  }

  /**
   * Get entries that were denied.
   */
  getDenied(): readonly ToolCallHistoryEntry[] {
    return Object.freeze(
      this.entries.filter((entry) => entry.validationResult.decision === 'deny')
    );
  }

  /**
   * Get the count of entries.
   */
  size(): number {
    return this.entries.length;
  }

  /**
   * Clear all history entries.
   */
  clear(): void {
    const previousSize = this.entries.length;
    this.entries.length = 0;
    this.logger.debug('History cleared', { previousSize });
  }

  /**
   * Get statistics about the history.
   */
  getStats(): HistoryStats {
    const toolCounts: Record<string, number> = {};
    let allowedCount = 0;
    let deniedCount = 0;
    let modifiedCount = 0;

    for (const entry of this.entries) {
      toolCounts[entry.toolName] = (toolCounts[entry.toolName] ?? 0) + 1;

      switch (entry.validationResult.decision) {
        case 'allow':
          allowedCount++;
          break;
        case 'deny':
          deniedCount++;
          break;
        case 'modify':
          modifiedCount++;
          break;
      }
    }

    return {
      totalCalls: this.entries.length,
      allowedCalls: allowedCount,
      deniedCalls: deniedCount,
      modifiedCalls: modifiedCount,
      callsByTool: toolCounts,
    };
  }

  /**
   * Export decision history as JSON or CSV.
   */
  exportDecisions(format: DecisionExportFormat = 'json'): string {
    const records = this.toExportRecords();

    if (format === 'json') {
      return JSON.stringify(records, null, 2);
    }

    if (format === 'csv') {
      return this.toCsv(records);
    }

    throw new Error(`Unsupported decision export format: ${String(format)}`);
  }

  private toExportRecords(): DecisionExportRecord[] {
    let prevHash = GENESIS_HASH;
    return this.entries.map((entry) => {
      const record = this.entryToExportRecord(entry);
      const hash = computeChainHash(prevHash, record);
      prevHash = hash;
      return { ...record, chain_hash: hash };
    });
  }

  private extractMetadataString(
    metadata: Record<string, unknown> | undefined,
    keys: string[]
  ): string | null {
    if (!metadata) {
      return null;
    }

    for (const key of keys) {
      const value = metadata[key];

      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }

      if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
    }

    return null;
  }

  private toCsv(records: DecisionExportRecord[]): string {
    const header = [
      'timestamp',
      'tool_name',
      'arguments',
      'policy_version',
      'rule_id',
      'decision',
      'reason',
    ];

    const rows = records.map((record) => [
      record.timestamp,
      record.tool_name,
      JSON.stringify(record.arguments),
      record.policy_version ?? '',
      record.rule_id ?? '',
      record.decision,
      record.reason ?? '',
    ]);

    return [header, ...rows]
      .map((row) => row.map((value) => this.escapeCsvCell(value)).join(','))
      .join('\n');
  }

  private escapeCsvCell(value: string): string {
    if (
      value.includes(',')
      || value.includes('"')
      || value.includes('\n')
      || value.includes('\r')
    ) {
      return `"${value.replace(/"/g, '""')}"`;
    }

    return value;
  }
}

/**
 * Statistics about tool call history.
 */
export interface HistoryStats {
  /** Total number of tool calls */
  totalCalls: number;
  /** Number of allowed calls */
  allowedCalls: number;
  /** Number of denied calls */
  deniedCalls: number;
  /** Number of modified calls */
  modifiedCalls: number;
  /** Count of calls per tool */
  callsByTool: Record<string, number>;
}
