/**
 * `veto replay` — replay recorded tool calls against a policy to show
 * what would be allowed, denied, or require approval.
 *
 * Pure deterministic evaluation. No LLM calls, no cloud calls, no network.
 *
 * @module cli/replay
 */

import { resolve } from 'node:path';
import {
  parseReplayLog,
  loadPolicySnapshot,
  replayCalls,
  countDecisions,
  type ReplayCall,
  type ReplayDecision,
  type DecisionCounts,
  type PolicySnapshot,
} from './replay-engine.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ReportFormat = 'text' | 'json';

export interface ReplayOptions {
  policy: string;
  log: string;
  diff?: boolean;
  format?: ReportFormat;
  quiet?: boolean;
}

export interface ReplayChangedCall {
  index: number;
  line: number;
  tool: string;
  arguments: Record<string, unknown>;
  timestamp: string;
  originalDecision: string;
  replayedDecision: string;
  ruleId?: string;
  ruleName?: string;
  reason?: string;
}

export interface ReplayDeniedGroup {
  tool: string;
  count: number;
  reason?: string;
}

export interface ReplayReport {
  timestamp: string;
  policySource: string;
  logSource: string;
  totalCalls: number;
  invalidLines: number;
  decisions: DecisionCounts;
  topDenied: ReplayDeniedGroup[];
  topRequireApproval: ReplayDeniedGroup[];
  changed: {
    total: number;
    calls: ReplayChangedCall[];
  };
  hasOriginalDecisions: boolean;
}

export interface ReplayResult {
  success: boolean;
  report: ReplayReport | null;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

function groupByToolAndReason(
  calls: readonly ReplayCall[],
  decisions: readonly ReplayDecision[],
  targetDecision: 'deny' | 'require_approval'
): ReplayDeniedGroup[] {
  const groups = new Map<string, { count: number; reason?: string }>();

  for (let i = 0; i < calls.length; i++) {
    if (decisions[i].decision !== targetDecision) continue;

    const key = `${calls[i].tool}::${decisions[i].reason ?? ''}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(key, { count: 1, reason: decisions[i].reason });
    }
  }

  return [...groups.entries()]
    .map(([key, { count, reason }]) => ({
      tool: key.split('::')[0],
      count,
      reason: reason || undefined,
    }))
    .sort((a, b) => b.count - a.count);
}

function buildChangedCalls(
  calls: readonly ReplayCall[],
  decisions: readonly ReplayDecision[]
): ReplayChangedCall[] {
  const changed: ReplayChangedCall[] = [];

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (!call.decision) continue;
    if (call.decision === decisions[i].decision) continue;

    changed.push({
      index: call.index,
      line: call.line,
      tool: call.tool,
      arguments: call.arguments,
      timestamp: call.timestamp,
      originalDecision: call.decision,
      replayedDecision: decisions[i].decision,
      ruleId: decisions[i].ruleId,
      ruleName: decisions[i].ruleName,
      reason: decisions[i].reason,
    });
  }

  return changed;
}

function buildReport(
  snapshot: PolicySnapshot,
  logPath: string,
  calls: readonly ReplayCall[],
  decisions: readonly ReplayDecision[]
): ReplayReport {
  const counts = countDecisions(decisions);
  const hasOriginalDecisions = calls.some((c) => c.decision !== undefined);
  const changed = hasOriginalDecisions ? buildChangedCalls(calls, decisions) : [];

  return {
    timestamp: new Date().toISOString(),
    policySource: snapshot.source,
    logSource: resolve(logPath),
    totalCalls: calls.length,
    invalidLines: 0,
    decisions: counts,
    topDenied: groupByToolAndReason(calls, decisions, 'deny'),
    topRequireApproval: groupByToolAndReason(calls, decisions, 'require_approval'),
    changed: {
      total: changed.length,
      calls: changed,
    },
    hasOriginalDecisions,
  };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function pct(n: number, total: number): string {
  if (total === 0) return '0.0';
  return ((n / total) * 100).toFixed(1);
}

function truncateArgs(args: Record<string, unknown>, maxLen = 60): string {
  const str = JSON.stringify(args);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

function formatTextReport(report: ReplayReport, diffOnly: boolean): string {
  const lines: string[] = [];
  const { totalCalls, decisions } = report;

  lines.push('');
  lines.push(`Replaying ${totalCalls.toLocaleString()} tool calls against policy '${report.policySource}':`);
  lines.push('');
  lines.push(`  ${decisions.allow.toLocaleString().padStart(6)} allowed (${pct(decisions.allow, totalCalls)}%)`);
  lines.push(`  ${decisions.deny.toLocaleString().padStart(6)} denied (${pct(decisions.deny, totalCalls)}%)`);
  lines.push(`  ${decisions.require_approval.toLocaleString().padStart(6)} require approval (${pct(decisions.require_approval, totalCalls)}%)`);

  if (report.topDenied.length > 0 && !diffOnly) {
    lines.push('');
    lines.push('Top denied:');
    for (const group of report.topDenied.slice(0, 10)) {
      const reasonSuffix = group.reason ? ` \u2014 ${group.reason}` : '';
      lines.push(`  ${group.tool} \u2014 ${group.count} call${group.count > 1 ? 's' : ''}${reasonSuffix}`);
    }
  }

  if (report.topRequireApproval.length > 0 && !diffOnly) {
    lines.push('');
    lines.push('Top require approval:');
    for (const group of report.topRequireApproval.slice(0, 10)) {
      const reasonSuffix = group.reason ? ` \u2014 ${group.reason}` : '';
      lines.push(`  ${group.tool} \u2014 ${group.count} call${group.count > 1 ? 's' : ''}${reasonSuffix}`);
    }
  }

  if (report.hasOriginalDecisions && report.changed.total > 0) {
    lines.push('');
    lines.push(`Changed decisions: ${report.changed.total}`);
    for (const call of report.changed.calls) {
      const ruleInfo = call.ruleName ? ` (rule: ${call.ruleName})` : '';
      lines.push(`  CHANGED: ${call.tool}(${truncateArgs(call.arguments)}) ${call.originalDecision} \u2192 ${call.replayedDecision}${ruleInfo}`);
    }
  } else if (report.hasOriginalDecisions && report.changed.total === 0 && !diffOnly) {
    lines.push('');
    lines.push('No decision changes \u2014 policy matches all historical decisions.');
  }

  if (!report.hasOriginalDecisions && !diffOnly) {
    lines.push('');
    lines.push('Tip: Include "decision" in your log entries to see what changed.');
  }

  if (report.invalidLines > 0) {
    lines.push('');
    lines.push(`Warning: ${report.invalidLines} invalid line${report.invalidLines > 1 ? 's' : ''} skipped.`);
  }

  lines.push('');
  return lines.join('\n');
}

function formatDiffOnlyText(report: ReplayReport): string {
  if (!report.hasOriginalDecisions) {
    return '\nNo original decisions in log \u2014 cannot compute diff.\nInclude "decision" in your log entries to use --diff.\n';
  }

  if (report.changed.total === 0) {
    return '\nNo decision changes \u2014 policy matches all historical decisions.\n';
  }

  const lines: string[] = [];
  lines.push('');
  lines.push(`${report.changed.total} decision${report.changed.total > 1 ? 's' : ''} changed:`);
  lines.push('');
  for (const call of report.changed.calls) {
    const ruleInfo = call.ruleName ? ` (rule: ${call.ruleName})` : '';
    lines.push(`  CHANGED: ${call.tool}(${truncateArgs(call.arguments)}) ${call.originalDecision} \u2192 ${call.replayedDecision}${ruleInfo}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function replay(options: ReplayOptions): Promise<ReplayResult> {
  const errors: string[] = [];

  if (!options.policy) {
    return { success: false, report: null, errors: ['--policy is required'] };
  }
  if (!options.log) {
    return { success: false, report: null, errors: ['--log is required'] };
  }

  let snapshot: PolicySnapshot;
  try {
    snapshot = loadPolicySnapshot(options.policy);
  } catch (err) {
    return { success: false, report: null, errors: [`Failed to load policy: ${(err as Error).message}`] };
  }

  let parsedLog: ReturnType<typeof parseReplayLog>;
  try {
    parsedLog = parseReplayLog(options.log);
  } catch (err) {
    return { success: false, report: null, errors: [`Failed to parse log: ${(err as Error).message}`] };
  }

  const decisions = replayCalls(snapshot, parsedLog.calls);
  const report = buildReport(snapshot, options.log, parsedLog.calls, decisions);
  report.invalidLines = parsedLog.invalidLines;

  const format = options.format === 'json' ? 'json' : 'text';

  if (!options.quiet) {
    if (format === 'json') {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else if (options.diff) {
      process.stdout.write(formatDiffOnlyText(report));
    } else {
      process.stdout.write(formatTextReport(report, false));
    }
  }

  return { success: true, report, errors };
}
