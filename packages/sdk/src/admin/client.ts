import type {
  VetoAdminOptions,
  Policy,
  CreatePolicyInput,
  UpdatePolicyInput,
  Decision,
  DecisionQuery,
  DecisionStats,
  PaginatedResult,
  Approval,
  Tool,
  PolicyDraft,
  CreatePolicyDraftInput,
  McpUpstream,
  CreateUpstreamInput,
  UpstreamTestResult,
  ApiKeyInfo,
  ApiKeyCreated,
  VetoAdminEvent,
  EventSubscription,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.veto.so';
const DEFAULT_TIMEOUT = 30_000;

export class VetoAdmin {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeout: number;

  constructor(options: VetoAdminOptions) {
    if (!options.apiKey) {
      throw new Error('VetoAdmin requires an apiKey');
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
  }

  // ---------------------------------------------------------------------------
  // Policies
  // ---------------------------------------------------------------------------

  async listPolicies(opts?: { projectId?: string }): Promise<Policy[]> {
    const params = new URLSearchParams();
    if (opts?.projectId) params.set('projectId', opts.projectId);
    const res = await this.request<{ data: Policy[] }>('GET', '/policies', params);
    return res.data;
  }

  async getPolicy(toolName: string): Promise<Policy> {
    return this.request<Policy>('GET', `/policies/${enc(toolName)}`);
  }

  async createPolicy(input: CreatePolicyInput): Promise<Policy> {
    return this.request<Policy>('POST', '/policies', undefined, input);
  }

  async updatePolicy(toolName: string, input: UpdatePolicyInput): Promise<Policy> {
    return this.request<Policy>('PUT', `/policies/${enc(toolName)}`, undefined, input);
  }

  async deletePolicy(toolName: string): Promise<void> {
    await this.request<void>('DELETE', `/policies/${enc(toolName)}`);
  }

  async activatePolicy(toolName: string): Promise<void> {
    await this.request<void>('POST', `/policies/${enc(toolName)}/activate`);
  }

  async deactivatePolicy(toolName: string): Promise<void> {
    await this.request<void>('POST', `/policies/${enc(toolName)}/deactivate`);
  }

  async exportPolicies(opts?: { projectId?: string; format?: string }): Promise<string> {
    const params = new URLSearchParams();
    if (opts?.projectId) params.set('projectId', opts.projectId);
    if (opts?.format) params.set('format', opts.format);
    const res = await this.rawRequest('GET', '/policies/export', params);
    return res.text();
  }

  // ---------------------------------------------------------------------------
  // Decisions
  // ---------------------------------------------------------------------------

  async listDecisions(query?: DecisionQuery): Promise<PaginatedResult<Decision>> {
    const params = new URLSearchParams();
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) params.set(k, String(v));
      }
    }
    return this.request<PaginatedResult<Decision>>('GET', '/decisions', params);
  }

  async getDecision(id: string): Promise<Decision> {
    return this.request<Decision>('GET', `/decisions/${enc(id)}`);
  }

  async getDecisionStats(opts?: { projectId?: string; startDate?: string; endDate?: string }): Promise<DecisionStats> {
    const params = new URLSearchParams();
    if (opts) {
      for (const [k, v] of Object.entries(opts)) {
        if (v !== undefined) params.set(k, String(v));
      }
    }
    return this.request<DecisionStats>('GET', '/decisions/stats', params);
  }

  async exportDecisions(opts?: { projectId?: string; format?: string; startDate?: string; endDate?: string }): Promise<string> {
    const params = new URLSearchParams();
    if (opts) {
      for (const [k, v] of Object.entries(opts)) {
        if (v !== undefined) params.set(k, String(v));
      }
    }
    const res = await this.rawRequest('GET', '/decisions/export', params);
    return res.text();
  }

  // ---------------------------------------------------------------------------
  // Approvals
  // ---------------------------------------------------------------------------

  async listApprovals(opts?: { status?: string }): Promise<Approval[]> {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    const res = await this.request<{ data: Approval[] }>('GET', '/approvals', params);
    return res.data;
  }

  async listPendingApprovals(): Promise<Approval[]> {
    const res = await this.request<{ data: Approval[] }>('GET', '/approvals/pending');
    return res.data;
  }

  async getApproval(id: string): Promise<Approval> {
    return this.request<Approval>('GET', `/approvals/${enc(id)}`);
  }

  async resolveApproval(id: string, action: 'approve' | 'deny', resolvedBy: string): Promise<Approval> {
    return this.request<Approval>('POST', `/approvals/${enc(id)}/resolve`, undefined, {
      action,
      resolvedBy,
    });
  }

  async batchResolveApprovals(
    approvals: { id: string; action: 'approve' | 'deny'; resolvedBy: string }[]
  ): Promise<{ data: { id: string; status: string; action?: string; error?: string }[] }> {
    return this.request('POST', '/approvals/batch-resolve', undefined, { approvals });
  }

  // ---------------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------------

  async listTools(): Promise<Tool[]> {
    const res = await this.request<{ data: Tool[] }>('GET', '/tools');
    return res.data;
  }

  async deleteTool(name: string): Promise<void> {
    await this.request<void>('DELETE', `/tools/${enc(name)}`);
  }

  // ---------------------------------------------------------------------------
  // Policy Drafts
  // ---------------------------------------------------------------------------

  async listPolicyDrafts(opts?: { status?: string; projectId?: string }): Promise<PolicyDraft[]> {
    const params = new URLSearchParams();
    if (opts?.status) params.set('status', opts.status);
    if (opts?.projectId) params.set('projectId', opts.projectId);
    const res = await this.request<{ data: PolicyDraft[] }>('GET', '/policy-drafts', params);
    return res.data;
  }

  async createPolicyDraft(input: CreatePolicyDraftInput): Promise<PolicyDraft> {
    return this.request<PolicyDraft>('POST', '/policy-drafts', undefined, input);
  }

  async getPolicyDraft(id: string): Promise<PolicyDraft> {
    return this.request<PolicyDraft>('GET', `/policy-drafts/${enc(id)}`);
  }

  async approvePolicyDraft(id: string): Promise<PolicyDraft> {
    return this.request<PolicyDraft>('POST', `/policy-drafts/${enc(id)}/approve`);
  }

  async rejectPolicyDraft(id: string, reason?: string): Promise<PolicyDraft> {
    return this.request<PolicyDraft>('POST', `/policy-drafts/${enc(id)}/reject`, undefined, reason ? { reason } : undefined);
  }

  // ---------------------------------------------------------------------------
  // MCP Gateway
  // ---------------------------------------------------------------------------

  async listUpstreams(): Promise<McpUpstream[]> {
    const res = await this.request<{ data: McpUpstream[] }>('GET', '/mcp/upstreams');
    return res.data;
  }

  async createUpstream(input: CreateUpstreamInput): Promise<McpUpstream> {
    return this.request<McpUpstream>('POST', '/mcp/upstreams', undefined, input);
  }

  async deleteUpstream(id: string): Promise<void> {
    await this.request<void>('DELETE', `/mcp/upstreams/${enc(id)}`);
  }

  async testUpstream(id: string): Promise<UpstreamTestResult> {
    return this.request<UpstreamTestResult>('POST', `/mcp/upstreams/${enc(id)}/test`);
  }

  // ---------------------------------------------------------------------------
  // API Keys
  // ---------------------------------------------------------------------------

  async listApiKeys(): Promise<ApiKeyInfo[]> {
    const res = await this.request<{ data: ApiKeyInfo[] }>('GET', '/api-keys');
    return res.data;
  }

  async createApiKey(input: { name: string; projectId?: string }): Promise<ApiKeyCreated> {
    return this.request<ApiKeyCreated>('POST', '/api-keys', undefined, input);
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.request<void>('DELETE', `/api-keys/${enc(id)}`);
  }

  // ---------------------------------------------------------------------------
  // Organizations (read-only via API key)
  // ---------------------------------------------------------------------------

  async listOrganizations(): Promise<{ data: unknown[] }> {
    return this.request('GET', '/organizations');
  }

  // ---------------------------------------------------------------------------
  // Projects (read-only via API key)
  // ---------------------------------------------------------------------------

  async listProjects(opts?: { organizationId?: string }): Promise<{ data: unknown[] }> {
    const params = new URLSearchParams();
    if (opts?.organizationId) params.set('organizationId', opts.organizationId);
    return this.request('GET', '/projects', params);
  }

  // ---------------------------------------------------------------------------
  // Events (SSE)
  // ---------------------------------------------------------------------------

  onEvent(
    type: string | string[],
    callback: (event: VetoAdminEvent) => void
  ): EventSubscription {
    const types = Array.isArray(type) ? type.join(',') : type;
    const params = new URLSearchParams();
    if (types) params.set('types', types);

    params.set('apiKey', this.apiKey);
    const url = this.buildUrl('/events/stream', params);
    if (typeof EventSource === 'undefined') {
      throw new VetoAdminError(
        'onEvent() requires Node.js >= 22 or a browser. Use subscribeEvents() instead.',
        0
      );
    }
    const es = new EventSource(url);

    const listener = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as VetoAdminEvent;
        callback(data);
      } catch {
        // malformed event, skip
      }
    };

    es.addEventListener('message', listener);
    es.addEventListener('event', listener);

    return {
      unsubscribe: () => es.close(),
    };
  }

  async *subscribeEvents(opts?: {
    types?: string[];
  }): AsyncIterable<VetoAdminEvent> {
    const params = new URLSearchParams();
    if (opts?.types?.length) params.set('types', opts.types.join(','));

    const url = this.buildUrl('/events/stream', params);
    const response = await this.fetchWithTimeout(url, {
      method: 'GET',
      headers: { ...this.getHeaders(), Accept: 'text/event-stream' },
    });

    if (!response.ok) {
      throw new VetoAdminError(
        `SSE connection failed: ${response.status}`,
        response.status
      );
    }

    const reader = response.body?.getReader();
    if (!reader) throw new VetoAdminError('No response body for SSE stream', 0);

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const payload = line.slice(6).trim();
            if (!payload || payload === ':ping') continue;
            try {
              yield JSON.parse(payload) as VetoAdminEvent;
            } catch {
              // malformed JSON, skip
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ---------------------------------------------------------------------------
  // Internal HTTP
  // ---------------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    params?: URLSearchParams,
    body?: unknown
  ): Promise<T> {
    const url = this.buildUrl(path, params);
    const init: RequestInit = {
      method,
      headers: this.getHeaders(),
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const response = await this.fetchWithTimeout(url, init);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new VetoAdminError(
        `${method} ${path} failed (${response.status}): ${text}`,
        response.status
      );
    }

    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  private async rawRequest(
    method: string,
    path: string,
    params?: URLSearchParams
  ): Promise<Response> {
    const url = this.buildUrl(path, params);
    const response = await this.fetchWithTimeout(url, {
      method,
      headers: this.getHeaders(),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new VetoAdminError(
        `${method} ${path} failed (${response.status}): ${text}`,
        response.status
      );
    }

    return response;
  }

  private buildUrl(path: string, params?: URLSearchParams): string {
    const query = params?.toString();
    return `${this.baseUrl}/v1${path}${query ? `?${query}` : ''}`;
  }

  private getHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Veto-API-Key': this.apiKey,
    };
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

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
        throw new VetoAdminError(`Request timed out after ${this.timeout}ms`, 0);
      }
      throw error;
    }
  }
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

export class VetoAdminError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'VetoAdminError';
    this.statusCode = statusCode;
  }
}
