/**
 * Veto Cloud API client.
 *
 * Handles communication with the Veto Cloud API for:
 * - Tool registration (sends tool signatures for policy template generation)
 * - Tool call validation (validates tool calls against cloud-managed policies)
 * - Approval polling (polls approval records until resolved)
 *
 * @module cloud/client
 */

import type { Logger } from '../utils/logger.js';
import type {
  VetoCloudConfig,
  ResolvedCloudConfig,
  CloudToolRegistration,
  CloudToolRegistrationResponse,
  CloudValidationResponse,
  CloudPolicyResponse,
  CloudPoliciesResponse,
  LogDecisionRequest,
  ApprovalData,
  ApprovalPollOptions,
} from './types.js';
import type { Rule, OutputRule } from '../rules/types.js';

export interface VetoCloudClientOptions {
  config?: VetoCloudConfig;
  logger: Logger;
}

const DEFAULT_BASE_URL = 'https://api.runveto.com';

export class VetoCloudClient {
  private readonly config: ResolvedCloudConfig;
  private readonly logger: Logger;
  private readonly registeredTools = new Set<string>();

  constructor(options: VetoCloudClientOptions) {
    this.logger = options.logger;
    this.config = this.resolveConfig(options.config ?? {});
  }

  private resolveConfig(config: VetoCloudConfig): ResolvedCloudConfig {
    return {
      apiKey: config.apiKey,
      baseUrl: (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, ''),
      timeout: config.timeout ?? 30000,
      retries: config.retries ?? 2,
      retryDelay: config.retryDelay ?? 1000,
    };
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['X-Veto-API-Key'] = this.config.apiKey;
    }
    return headers;
  }

  async registerTools(
    tools: CloudToolRegistration[]
  ): Promise<CloudToolRegistrationResponse> {
    const newTools = tools.filter((t) => !this.registeredTools.has(t.name));

    if (newTools.length === 0) {
      return {
        success: true,
        registered_tools: [],
        message: 'All tools already registered',
      };
    }

    const url = `${this.config.baseUrl}/v1/tools/register`;
    const payload = {
      tools: newTools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters.map((p) => ({
          name: p.name,
          type: p.type,
          description: p.description,
          required: p.required,
          enum: p.enum,
          minimum: p.minimum,
          maximum: p.maximum,
          pattern: p.pattern,
        })),
      })),
    };

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      try {
        const response = await this.fetchWithTimeout(url, {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw new Error(
            `API returned status ${response.status}: ${errorText}`
          );
        }

        const data = (await response.json()) as Record<string, unknown>;

        for (const tool of newTools) {
          this.registeredTools.add(tool.name);
        }

        this.logger.info('Tools registered successfully', {
          tools: newTools.map((t) => t.name),
        });

        return {
          success: true,
          registered_tools: newTools.map((t) => t.name),
          message: data.message as string | undefined,
        };
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error(String(error));

        if (attempt < this.config.retries) {
          this.logger.warn('Tool registration failed, retrying', {
            attempt: attempt + 1,
            error: lastError.message,
          });
          await this.delay(this.config.retryDelay);
        }
      }
    }

    this.logger.error(
      'Tool registration failed',
      { error: lastError?.message },
      lastError
    );

    return {
      success: false,
      registered_tools: [],
      message: `Registration failed: ${lastError?.message}`,
    };
  }

  async validate(
    toolName: string,
    args: Record<string, unknown>,
    context?: Record<string, unknown>
  ): Promise<CloudValidationResponse> {
    const url = `${this.config.baseUrl}/v1/tools/validate`;

    const payload: Record<string, unknown> = {
      tool_name: toolName,
      arguments: args,
    };
    if (context) {
      payload.context = context;
    }

    this.logger.debug('Validating tool call with cloud', {
      tool: toolName,
    });

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.retries; attempt++) {
      try {
        const response = await this.fetchWithTimeout(url, {
          method: 'POST',
          headers: this.getHeaders(),
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw new Error(
            `API returned status ${response.status}: ${errorText}`
          );
        }

        const data = (await response.json()) as Record<string, unknown>;

        const decision = (data.decision as string) ?? 'deny';

        const failedConstraints = Array.isArray(data.failed_constraints)
          ? (data.failed_constraints as Array<Record<string, unknown>>).map(
              (fc) => ({
                parameter: (fc.parameter as string) ?? '',
                constraint_type: (fc.constraint_type as string) ?? '',
                expected: fc.expected,
                actual: fc.actual,
                message: (fc.message as string) ?? '',
              })
            )
          : undefined;

        this.logger.debug('Cloud validation result', {
          tool: toolName,
          decision,
        });

        return {
          decision: decision as CloudValidationResponse['decision'],
          reason: data.reason as string | undefined,
          failed_constraints: failedConstraints,
          metadata: data.metadata as Record<string, unknown> | undefined,
          approval_id: data.approval_id as string | undefined,
        };
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error(String(error));

        if (attempt < this.config.retries) {
          this.logger.warn('Cloud validation request failed, retrying', {
            attempt: attempt + 1,
            error: lastError.message,
          });
          await this.delay(this.config.retryDelay);
        }
      }
    }

    this.logger.error(
      'Cloud validation request failed',
      { tool: toolName, error: lastError?.message },
      lastError
    );

    return {
      decision: 'deny',
      reason: `Validation failed: ${lastError?.message}`,
      metadata: { api_error: true },
    };
  }

  async pollApproval(
    approvalId: string,
    options?: ApprovalPollOptions
  ): Promise<ApprovalData> {
    const pollInterval = options?.pollInterval ?? 2000;
    const timeout = options?.timeout ?? 300_000;

    const url = `${this.config.baseUrl}/v1/approvals/${approvalId}`;
    const deadline = Date.now() + timeout;

    this.logger.info('Polling for approval resolution', {
      approval_id: approvalId,
      timeout,
    });

    while (true) {
      try {
        const response = await this.fetchWithTimeout(url, {
          method: 'GET',
          headers: this.getHeaders(),
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          this.logger.warn('Approval poll request failed', {
            status: response.status,
            error: errorText,
          });
        } else {
          const data = (await response.json()) as ApprovalData;
          const status = data.status ?? 'pending';

          if (status !== 'pending') {
            this.logger.info('Approval resolved', {
              approval_id: approvalId,
              status,
            });
            return data;
          }
        }
      } catch (error) {
        this.logger.warn('Approval poll error', {
          approval_id: approvalId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      const remainingTime = deadline - Date.now();
      if (remainingTime <= 0) {
        throw new ApprovalTimeoutError(approvalId, timeout);
      }

      await this.delay(Math.min(pollInterval, remainingTime));
    }
  }

  async fetchPolicy(toolName: string): Promise<CloudPolicyResponse | null> {
    const url = `${this.config.baseUrl}/v1/policies/${encodeURIComponent(toolName)}`;

    try {
      const response = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers: this.getHeaders(),
      });

      if (!response.ok) {
        return null;
      }

      return (await response.json()) as CloudPolicyResponse;
    } catch {
      return null;
    }
  }

  async fetchPolicies(): Promise<CloudPoliciesResponse> {
    const url = `${this.config.baseUrl}/v1/policies`;

    const response = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`API returned status ${response.status}: ${errorText}`);
    }

    const payload = await response.json() as unknown;
    return this.normalizePoliciesResponse(payload);
  }

  logDecision(request: LogDecisionRequest): void {
    const url = `${this.config.baseUrl}/v1/decisions`;

    this.fetchWithTimeout(url, {
      method: 'POST',
      headers: this.getHeaders(),
      body: JSON.stringify(request),
    }).catch(() => {
      // Fire-and-forget: errors are intentionally swallowed
    });
  }

  isToolRegistered(toolName: string): boolean {
    return this.registeredTools.has(toolName);
  }

  clearRegistrationCache(): void {
    this.registeredTools.clear();
  }

  private normalizePoliciesResponse(payload: unknown): CloudPoliciesResponse {
    const objectPayload = (payload && typeof payload === 'object' && !Array.isArray(payload))
      ? payload as Record<string, unknown>
      : {};

    const rules = this.extractArray<Rule>(
      objectPayload.policies,
      objectPayload.rules,
      objectPayload.data
    );
    const outputRules = this.extractArray<OutputRule>(
      objectPayload.outputRules,
      objectPayload.output_rules
    );

    return {
      policies: rules,
      outputRules,
    };
  }

  private extractArray<T>(...candidates: unknown[]): T[] {
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        return candidate as T[];
      }
    }

    return [];
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timed out after ${this.config.timeout}ms`);
      }
      throw error;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Error thrown when an approval poll times out.
 */
export class ApprovalTimeoutError extends Error {
  readonly approvalId: string;
  readonly timeoutMs: number;

  constructor(approvalId: string, timeoutMs: number) {
    super(
      `Approval ${approvalId} was not resolved within ${timeoutMs}ms`
    );
    this.name = 'ApprovalTimeoutError';
    this.approvalId = approvalId;
    this.timeoutMs = timeoutMs;
  }
}
