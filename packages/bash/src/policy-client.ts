import type { ApprovalPollOptions, ApprovalRecord, DenialDetails, PolicyClientLike, ValidationDecision } from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeDecision(value: unknown): ValidationDecision['decision'] {
  if (value === 'allow' || value === 'deny' || value === 'require_approval') {
    return value;
  }
  return 'deny';
}

function parseDenial(value: unknown): DenialDetails | undefined {
  const denial = asObject(value);
  if (!denial) {
    return undefined;
  }

  return {
    policyId: typeof denial.policyId === 'string' ? denial.policyId : undefined,
    policyName: typeof denial.policyName === 'string' ? denial.policyName : undefined,
    severity: denial.severity === 'deny' || denial.severity === 'require_approval'
      ? denial.severity
      : undefined,
    matchedCondition: typeof denial.matchedCondition === 'string' ? denial.matchedCondition : undefined,
    suggestedFixes: Array.isArray(denial.suggestedFixes)
      ? denial.suggestedFixes.filter((item): item is string => typeof item === 'string')
      : undefined,
    docsUrl: typeof denial.docsUrl === 'string' ? denial.docsUrl : undefined,
    input: asObject(denial.input),
  };
}

export class PolicyNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyNetworkError';
  }
}

export class PolicyHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseText: string
  ) {
    super(`Policy API returned ${status}${responseText ? `: ${responseText}` : ''}`);
    this.name = 'PolicyHttpError';
  }
}

export class ApprovalTimeoutError extends Error {
  constructor(
    public readonly approvalId: string,
    public readonly timeoutMs: number
  ) {
    super(`Approval ${approvalId} was not resolved within ${timeoutMs}ms`);
    this.name = 'ApprovalTimeoutError';
  }
}

export class BashPolicyClient implements PolicyClientLike {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly options: {
      apiKey: string;
      apiUrl: string;
      timeoutMs?: number;
      fetch?: typeof fetch;
    }
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async validate(
    toolName: string,
    args: Record<string, unknown>,
    context?: Record<string, unknown>
  ): Promise<ValidationDecision> {
    const response = await this.fetchWithTimeout(`${this.options.apiUrl}/v1/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Veto-API-Key': this.options.apiKey,
      },
      body: JSON.stringify({
        toolName,
        arguments: args,
        context,
      }),
    });

    if (!response.ok) {
      const responseText = await response.text().catch(() => '');
      throw new PolicyHttpError(response.status, responseText);
    }

    const body = await response.json() as Record<string, unknown>;
    return {
      decision: normalizeDecision(body.decision),
      reason: typeof body.reason === 'string' ? body.reason : undefined,
      approvalId: typeof body.approval_id === 'string' ? body.approval_id : undefined,
      denial: parseDenial(body.denial),
      metadata: asObject(body.metadata),
    };
  }

  async pollApproval(approvalId: string, options: ApprovalPollOptions = {}): Promise<ApprovalRecord> {
    const pollIntervalMs = options.pollIntervalMs ?? 2_000;
    const timeoutMs = options.timeoutMs ?? 300_000;
    const deadline = Date.now() + timeoutMs;

    while (true) {
      try {
        const response = await this.fetchWithTimeout(`${this.options.apiUrl}/v1/approvals/${approvalId}`, {
          method: 'GET',
          headers: {
            'X-Veto-API-Key': this.options.apiKey,
          },
        });

        if (response.ok) {
          const body = await response.json() as Record<string, unknown>;
          const status = body.status;
          if (status === 'approved' || status === 'denied' || status === 'expired') {
            return {
              id: typeof body.id === 'string' ? body.id : approvalId,
              toolName: typeof body.toolName === 'string' ? body.toolName : undefined,
              arguments: asObject(body.arguments),
              status,
              expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : undefined,
              resolvedBy: typeof body.resolvedBy === 'string' ? body.resolvedBy : undefined,
              resolvedAt: typeof body.resolvedAt === 'string' ? body.resolvedAt : undefined,
              createdAt: typeof body.createdAt === 'string' ? body.createdAt : undefined,
            };
          }
        }
      } catch (error) {
        if (!(error instanceof PolicyNetworkError) && !(error instanceof PolicyHttpError)) {
          throw error;
        }
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new ApprovalTimeoutError(approvalId, timeoutMs);
      }

      await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)));
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof PolicyHttpError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new PolicyNetworkError(`Request timed out after ${this.timeoutMs}ms`);
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new PolicyNetworkError(message);
    } finally {
      clearTimeout(timer);
    }
  }
}
