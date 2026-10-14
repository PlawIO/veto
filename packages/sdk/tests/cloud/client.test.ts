import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  VetoCloudClient,
  ApprovalTimeoutError,
  RuntimeActionTimeoutError,
} from '../../src/cloud/client.js';
import type { Logger } from '../../src/utils/logger.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

const receiptSummary = {
  receipt_id: 'rcp_000000000000000000000001',
  receipt_hash: `sha256:${'1'.repeat(64)}`,
  previous_receipt_hash: `sha256:${'0'.repeat(64)}`,
  merkle_root: `sha256:${'2'.repeat(64)}`,
};

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('VetoCloudClient', () => {
  let logger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    logger = createLogger();
  });

  describe('validate', () => {
    it('should return allow decision', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'allow', reason: 'Allowed', receipt: receiptSummary }),
        text: async () => '',
      });

      const client = new VetoCloudClient({
        config: { apiKey: 'test-key', baseUrl: 'http://localhost:3001', retries: 0 },
        logger,
      });

      const result = await client.validate('send_email', { to: 'test@test.com' });

      expect(result.decision).toBe('allow');
      expect(result.reason).toBe('Allowed');
      expect(result.receipt).toEqual(receiptSummary);
    });

    it('should parse outputRules from validation responses', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'allow',
          reason: 'Allowed',
          outputRules: [
            {
              id: 'redact-acme',
              name: 'Hide Acme',
              enabled: true,
              severity: 'high',
              action: 'redact',
              tools: ['google_sheets_read'],
              output_conditions: [
                {
                  field: 'output',
                  operator: 'matches',
                  value: '(?i)\\bacme\\b',
                },
              ],
              redact_with: '[REDACTED]',
            },
          ],
        }),
        text: async () => '',
      });

      const client = new VetoCloudClient({
        config: { apiKey: 'test-key', baseUrl: 'http://localhost:3001', retries: 0 },
        logger,
      });

      const result = await client.validate('google_sheets_read', {});

      expect(result.outputRules).toHaveLength(1);
      expect(result.outputRules?.[0]).toMatchObject({
        id: 'redact-acme',
        action: 'redact',
      });
    });

    it('should return deny decision', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'deny',
          reason: 'Blocked by policy',
          failed_constraints: [
            { parameter: 'amount', constraint_type: 'range', expected: '<=1000', actual: 5000, message: 'Amount exceeds limit' },
          ],
        }),
        text: async () => '',
      });

      const client = new VetoCloudClient({
        config: { apiKey: 'test-key', baseUrl: 'http://localhost:3001', retries: 0 },
        logger,
      });

      const result = await client.validate('transfer', { amount: 5000 });

      expect(result.decision).toBe('deny');
      expect(result.reason).toBe('Blocked by policy');
      expect(result.failed_constraints).toHaveLength(1);
      expect(result.failed_constraints![0].parameter).toBe('amount');
    });

    it('should return require_approval decision with approval_id', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'require_approval',
          reason: 'Needs human review',
          approval_id: 'appr-123',
        }),
        text: async () => '',
      });

      const client = new VetoCloudClient({
        config: { apiKey: 'test-key', baseUrl: 'http://localhost:3001', retries: 0 },
        logger,
      });

      const result = await client.validate('delete_user', { userId: '42' });

      expect(result.decision).toBe('require_approval');
      expect(result.approval_id).toBe('appr-123');
      expect(result.reason).toBe('Needs human review');
    });

    it('should send X-Veto-API-Key header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'allow' }),
        text: async () => '',
      });

      const client = new VetoCloudClient({
        config: { apiKey: 'my-api-key', baseUrl: 'http://localhost:3001', retries: 0 },
        logger,
      });

      await client.validate('test', {});

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/tools/validate',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'X-Veto-API-Key': 'my-api-key',
          }),
        })
      );
    });

    it('should return deny on API failure with retries exhausted', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));

      const client = new VetoCloudClient({
        config: { apiKey: 'test-key', baseUrl: 'http://localhost:3001', retries: 1, retryDelay: 10 },
        logger,
      });

      const result = await client.validate('test', {});

      expect(result.decision).toBe('deny');
      expect(result.metadata).toEqual({ api_error: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('pollApproval', () => {
    it('should return immediately when approval is resolved', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'appr-123',
          status: 'approved',
          resolvedBy: 'admin@example.com',
          toolName: 'delete_user',
        }),
        text: async () => '',
      });

      const client = new VetoCloudClient({
        config: { apiKey: 'test-key', baseUrl: 'http://localhost:3001' },
        logger,
      });

      const result = await client.pollApproval('appr-123');

      expect(result.status).toBe('approved');
      expect(result.resolvedBy).toBe('admin@example.com');
    });

    it('should poll multiple times until resolved', async () => {
      // First poll: pending
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'appr-123', status: 'pending', toolName: 'test' }),
        text: async () => '',
      });
      // Second poll: approved
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'appr-123', status: 'approved', resolvedBy: 'user', toolName: 'test' }),
        text: async () => '',
      });

      const client = new VetoCloudClient({
        config: { apiKey: 'test-key', baseUrl: 'http://localhost:3001' },
        logger,
      });

      const result = await client.pollApproval('appr-123', { pollInterval: 10 });

      expect(result.status).toBe('approved');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should return denied status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'appr-123', status: 'denied', resolvedBy: 'admin', toolName: 'test' }),
        text: async () => '',
      });

      const client = new VetoCloudClient({
        config: { apiKey: 'test-key', baseUrl: 'http://localhost:3001' },
        logger,
      });

      const result = await client.pollApproval('appr-123');

      expect(result.status).toBe('denied');
    });

    it('should throw ApprovalTimeoutError on timeout', async () => {
      // Always return pending
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'appr-123', status: 'pending', toolName: 'test' }),
        text: async () => '',
      });

      const client = new VetoCloudClient({
        config: { apiKey: 'test-key', baseUrl: 'http://localhost:3001' },
        logger,
      });

      await expect(
        client.pollApproval('appr-123', { pollInterval: 10, timeout: 50 })
      ).rejects.toThrow(ApprovalTimeoutError);
    });

    it('should continue polling on network errors', async () => {
      // First: error
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      // Second: resolved
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'appr-123', status: 'approved', resolvedBy: 'user', toolName: 'test' }),
        text: async () => '',
      });

      const client = new VetoCloudClient({
        config: { apiKey: 'test-key', baseUrl: 'http://localhost:3001' },
        logger,
      });

      const result = await client.pollApproval('appr-123', { pollInterval: 10 });

      expect(result.status).toBe('approved');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('runtime actions', () => {
    it('creates a runtime action for the iOS approval wallet', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          id: 'pending-123',
          approvalId: 'approval-123',
          decisionId: 'decision-123',
          status: 'pending',
          agentId: 'refund-agent',
          actionIntent: 'Refund $500',
          toolName: 'refund_customer',
          payloadHash: 'sha256:abc123',
          expiresAtMs: Date.now() + 120_000,
        }),
      });

      const client = new VetoCloudClient({
        config: { apiKey: 'test-key', baseUrl: 'http://localhost:3001', retries: 0 },
        logger,
      });

      const result = await client.createRuntimeAction({
        agentId: 'refund-agent',
        agentName: 'Refund Agent',
        actionIntent: 'Refund $500',
        toolName: 'refund_customer',
        toolCallPayload: { amount: 500, currency: 'USD' },
        timeoutSeconds: 120,
        sessionId: 'session-1',
        metadata: { traceId: 'trace-1' },
      });

      expect(result).toMatchObject({
        id: 'pending-123',
        approvalId: 'approval-123',
        decisionId: 'decision-123',
        status: 'pending',
        payloadHash: 'sha256:abc123',
      });
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/runtime/actions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'X-Veto-API-Key': 'test-key',
          }),
          body: JSON.stringify({
            agentId: 'refund-agent',
            agentName: 'Refund Agent',
            actionIntent: 'Refund $500',
            toolName: 'refund_customer',
            toolCallPayload: { amount: 500, currency: 'USD' },
            timeoutSeconds: 120,
            sessionId: 'session-1',
            metadata: { traceId: 'trace-1' },
          }),
        }),
      );
    });

    it('waits until a runtime action reaches a terminal state', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'pending-123',
            status: 'pending',
            agentId: 'refund-agent',
            actionIntent: 'Refund $500',
            toolName: 'refund_customer',
          }),
          text: async () => '',
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: 'pending-123',
            status: 'approved',
            agentId: 'refund-agent',
            actionIntent: 'Refund $500',
            toolName: 'refund_customer',
            resolvedBy: 'user-1',
          }),
          text: async () => '',
        });

      const client = new VetoCloudClient({
        config: { apiKey: 'test-key', baseUrl: 'http://localhost:3001' },
        logger,
      });

      const result = await client.waitRuntimeAction('pending-123', {
        pollInterval: 10,
        timeout: 5_000,
      });

      expect(result.status).toBe('approved');
      expect(result.resolvedBy).toBe('user-1');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringMatching(/^http:\/\/localhost:3001\/v1\/runtime\/actions\/pending-123\/wait\?timeoutMs=\d+$/),
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('throws RuntimeActionTimeoutError when a runtime action remains pending', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'pending-123',
          status: 'pending',
          agentId: 'refund-agent',
          actionIntent: 'Refund $500',
          toolName: 'refund_customer',
        }),
        text: async () => '',
      });

      const client = new VetoCloudClient({
        config: { apiKey: 'test-key', baseUrl: 'http://localhost:3001' },
        logger,
      });

      await expect(
        client.waitRuntimeAction('pending-123', { pollInterval: 10, timeout: 50 })
      ).rejects.toThrow(RuntimeActionTimeoutError);
    });
  });

  describe('registerTools', () => {
    it('should register tools and cache them', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: 'Registered' }),
        text: async () => '',
      });

      const client = new VetoCloudClient({
        config: { apiKey: 'test-key', baseUrl: 'http://localhost:3001', retries: 0 },
        logger,
      });

      const result = await client.registerTools([
        { name: 'tool1', parameters: [] },
        { name: 'tool2', parameters: [] },
      ]);

      expect(result.success).toBe(true);
      expect(result.registered_tools).toEqual(['tool1', 'tool2']);
      expect(client.isToolRegistered('tool1')).toBe(true);
      expect(client.isToolRegistered('tool2')).toBe(true);
    });

    it('should skip already registered tools', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ message: 'ok' }),
        text: async () => '',
      });

      const client = new VetoCloudClient({
        config: { apiKey: 'test-key', baseUrl: 'http://localhost:3001', retries: 0 },
        logger,
      });

      await client.registerTools([{ name: 'tool1', parameters: [] }]);
      mockFetch.mockClear();

      const result = await client.registerTools([{ name: 'tool1', parameters: [] }]);

      expect(result.success).toBe(true);
      expect(result.registered_tools).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('logDecision', () => {
    it('should include redaction trace payloads', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
        text: async () => '',
      });

      const client = new VetoCloudClient({
        config: { apiKey: 'test-key', baseUrl: 'http://localhost:3001', retries: 0 },
        logger,
      });

      client.logDecision({
        tool_name: 'google_sheets_read',
        arguments: { spreadsheetId: 'sheet-1' },
        decision: 'allow',
        mode: 'deterministic',
        latency_ms: 12,
        source: 'client',
        redactions: [
          {
            ruleId: 'redact-acme',
            ruleName: 'Hide Acme',
            field: 'output',
            pattern: '(?i)\\bacme\\b',
            redactedCount: 2,
            replacement: '[REDACTED]',
          },
        ],
      });

      await Promise.resolve();

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3001/v1/decisions',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            tool_name: 'google_sheets_read',
            arguments: { spreadsheetId: 'sheet-1' },
            decision: 'allow',
            mode: 'deterministic',
            latency_ms: 12,
            source: 'client',
            redactions: [
              {
                ruleId: 'redact-acme',
                ruleName: 'Hide Acme',
                field: 'output',
                pattern: '(?i)\\bacme\\b',
                redactedCount: 2,
                replacement: '[REDACTED]',
              },
            ],
          }),
        })
      );
    });
  });
});
