import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Veto } from '../../src/core/veto.js';

const TEST_DIR = '/tmp/veto-test-' + Date.now();
const VETO_DIR = join(TEST_DIR, 'veto');
const RULES_DIR = join(VETO_DIR, 'rules');

// Mock fetch for API tests
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('Veto', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Create test directory structure
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(RULES_DIR, { recursive: true });

    // Create default config
    writeFileSync(
      join(VETO_DIR, 'veto.config.yaml'),
      `
version: "1.0"
mode: "strict"
validation:
  mode: "api"
api:
  baseUrl: "http://localhost:8080"
  endpoint: "/tool/call/check"
  timeout: 5000
  retries: 0
logging:
  level: "silent"
rules:
  directory: "./rules"
`,
      'utf-8'
    );
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  describe('init', () => {
    it('should initialize with config from directory', async () => {
      const veto = await Veto.init({ configDir: VETO_DIR });
      expect(veto).toBeInstanceOf(Veto);
    });

    it('should handle missing config gracefully', async () => {
      rmSync(join(VETO_DIR, 'veto.config.yaml'));
      const veto = await Veto.init({ configDir: VETO_DIR });
      expect(veto).toBeInstanceOf(Veto);
    });

    it('should default to local mode with no config and make zero network calls', async () => {
      rmSync(join(VETO_DIR, 'veto.config.yaml'));

      writeFileSync(
        join(RULES_DIR, 'local.yaml'),
        `
version: "1.0"
name: local-rules
rules:
  - id: local-block
    name: Local Block
    enabled: true
    action: block
    tools: [local_tool]
    conditions:
      - field: arguments.path
        operator: starts_with
        value: /tmp/blocked
`,
        'utf-8'
      );

      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      const handler = vi.fn();
      const veto = await Veto.init({ configDir: VETO_DIR });
      const wrapped = veto.wrap([{ name: 'local_tool', handler, inputSchema: {} }]);

      await expect(wrapped[0].handler({ path: '/tmp/blocked/file.txt' })).rejects.toThrow('Tool call denied');

      expect(handler).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Veto running in local mode'));
      infoSpy.mockRestore();
    });

    it('should prevent argument collisions from overriding local reserved fields', async () => {
      rmSync(join(VETO_DIR, 'veto.config.yaml'));

      writeFileSync(
        join(RULES_DIR, 'collision.yaml'),
        `
version: "1.0"
name: collision-rules
rules:
  - id: collision-block
    name: Collision Block
    enabled: true
    action: block
    tools: [collision_tool]
    conditions:
      - field: tool_name
        operator: equals
        value: collision_tool
`,
        'utf-8'
      );

      const handler = vi.fn();
      const veto = await Veto.init({ configDir: VETO_DIR });
      const wrapped = veto.wrap([{ name: 'collision_tool', handler, inputSchema: {} }]);

      await expect(wrapped[0].handler({ tool_name: 'spoofed_name' })).rejects.toThrow('Tool call denied');
      expect(handler).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should auto-detect cloud mode when apiKey is provided', async () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'allow', reason: 'Allowed' }),
        text: async () => '',
      });

      const veto = await Veto.init({
        configDir: VETO_DIR,
        apiKey: 'veto_test_key',
        logLevel: 'info',
      });

      const tools = [{ name: 'cloud_tool', handler: vi.fn().mockResolvedValue('ok'), inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      await wrapped[0].handler({ query: 'test' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('https://api.veto.dev/v1/tools/validate'),
        expect.any(Object)
      );
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Veto running in cloud mode'));
      infoSpy.mockRestore();
    });

    it('should auto-detect self-hosted mode when endpoint is provided', async () => {
      const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'allow', reason: 'Allowed' }),
        text: async () => '',
      });

      const endpoint = 'https://self-hosted.example.com';
      const veto = await Veto.init({
        configDir: VETO_DIR,
        endpoint,
        logLevel: 'info',
      });

      const tools = [{ name: 'self_hosted_tool', handler: vi.fn().mockResolvedValue('ok'), inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      await wrapped[0].handler({ query: 'test' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`${endpoint}/v1/tools/validate`),
        expect.any(Object)
      );
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('Veto running in self-hosted mode'));
      infoSpy.mockRestore();
    });

    it('should warn and use self-hosted mode when endpoint and apiKey are both provided', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'allow', reason: 'Allowed' }),
        text: async () => '',
      });

      const endpoint = 'https://self-hosted.example.com';
      const veto = await Veto.init({
        configDir: VETO_DIR,
        endpoint,
        apiKey: 'veto_test_key',
        logLevel: 'warn',
      });

      const tools = [{ name: 'mixed_mode_tool', handler: vi.fn().mockResolvedValue('ok'), inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      await wrapped[0].handler({ query: 'test' });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining(`${endpoint}/v1/tools/validate`),
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Veto-API-Key': 'veto_test_key',
          }),
        })
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Both endpoint and apiKey provided. Using self-hosted mode')
      );
      warnSpy.mockRestore();
    });

    it('should load rules from directory', async () => {
      // Create a rule
      writeFileSync(
        join(RULES_DIR, 'test.yaml'),
        `
version: "1.0"
name: test-rules
rules:
  - id: test-rule
    name: Test Rule
    enabled: true
    action: block
    tools: [test_tool]
`,
        'utf-8'
      );

      const veto = await Veto.init({ configDir: VETO_DIR });
      // Logic for verifying rules loaded is indirect via usage below
    });
  });

  describe('wrap', () => {
    it('should wrap tools and preserve execution', async () => {
      const handler = vi.fn().mockResolvedValue('result');
      const tools = [{
        name: 'test_tool',
        description: 'Test tool',
        handler,
        inputSchema: {}
      }];

      const veto = await Veto.init({ configDir: VETO_DIR });
      const wrapped = veto.wrap(tools);

      expect(wrapped).toHaveLength(1);
      expect(wrapped[0].name).toBe('test_tool');

      // Execute
      const result = await wrapped[0].handler({});
      expect(result).toBe('result');
      expect(handler).toHaveBeenCalled();
    });

    it('should block execution when rule matches and API blocks', async () => {
      // Setup rule
      const rulePath = join(RULES_DIR, 'block.yaml');
      writeFileSync(
        rulePath,
        `
version: "1.0"
name: block-rules
rules:
  - id: block-rule
    name: Block Rule
    enabled: true
    action: block
    tools: [blocked_tool]
`,
        'utf-8'
      );

      // Mock API block response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'block',
          reasoning: 'Blocked by test',
          should_block_weight: 1
        }),
      });

      const handler = vi.fn();
      const tools = [{
        name: 'blocked_tool',
        description: 'Blocked',
        handler,
        inputSchema: {}
      }];

      const veto = await Veto.init({
        configDir: VETO_DIR,
        logLevel: 'debug'
      });
      const wrapped = veto.wrap(tools);

      // Execute -> Should throw
      try {
        await wrapped[0].handler({});
        // If we reach here, fail
        expect(true).toBe(false);
      } catch (error: any) {
        expect(error.message).toContain('Tool call denied');
      }
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('history', () => {
    it('should track allowed and blocked calls', async () => {
      // Setup: 1 allow, 1 block
      const rulePath = join(RULES_DIR, 'history-rules.yaml');
      writeFileSync(
        rulePath,
        `
version: "1.0"
name: history-rules
rules:
  - id: block
    name: Block
    enabled: true
    action: block
    tools: [blocked_tool]
`,
        'utf-8'
      );

      // Call 1: Allow (no rules for allowed_tool)
      // Call 2: Block (rule for blocked_tool + API block)

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'block',
          reasoning: 'blocked',
          should_block_weight: 1
        })
      });

      const tools = [
        { name: 'allowed_tool', handler: async () => 'ok', inputSchema: {} },
        { name: 'blocked_tool', handler: async () => 'ok', inputSchema: {} }
      ];

      const veto = await Veto.init({ configDir: VETO_DIR, logLevel: 'debug' });
      const wrapped = veto.wrap(tools);

      await wrapped[0].handler(); // Should pass

      try {
        await wrapped[1].handler();
      } catch (e) {
        // Expected to throw
      }

      const stats = veto.getHistoryStats();
      console.log('History stats:', stats);

      // allowed_tool allows -> 1 allowed
      // blocked_tool denies -> 1 denied
      expect(stats.totalCalls).toBe(2);
      expect(stats.allowedCalls).toBe(1);
      expect(stats.deniedCalls).toBe(1);
    });

    it('should clear history', async () => {
      const veto = await Veto.init({ configDir: VETO_DIR });
      const tools = [{ name: 't', handler: async () => 'ok', inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      await wrapped[0].handler();
      expect(veto.getHistoryStats().totalCalls).toBe(1);

      veto.clearHistory();
      expect(veto.getHistoryStats().totalCalls).toBe(0);
    });
  });

  describe('Integration: Kernel Mode', () => {
    it('should use kernel client for validation', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "kernel"
logging:
  level: "debug"
rules:
  directory: "./rules"
`,
        'utf-8'
      );

      // Create rule to trigger validation
      const rulePath = join(RULES_DIR, 'k-rule.yaml');
      writeFileSync(rulePath, `
version: "1.0"
name: kernel-rules
rules:
  - id: k-rule
    name: K Rule
    enabled: true
    action: block
    tools: [k_tool]
`);

      const mockKernelClient = {
        evaluate: vi.fn().mockResolvedValue({
          decision: 'block',
          reasoning: 'Kernel blocked',
          block_weight: 1.0,
          pass_weight: 0.0
        }),
        healthCheck: vi.fn().mockResolvedValue(true)
      };

      const veto = await Veto.init({
        configDir: VETO_DIR,
        kernelClient: mockKernelClient as never
      });

      const tools = [{ name: 'k_tool', handler: vi.fn(), inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      try {
        await wrapped[0].handler({});
        expect(true).toBe(false); // Fail if no throw
      } catch (error: any) {
        expect(error.message).toContain('Kernel blocked') // Or 'Tool call denied'
      }
      expect(mockKernelClient.evaluate).toHaveBeenCalled();
    });
  });

  describe('Integration: Cloud Mode', () => {
    it('should allow tool call when cloud returns allow', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
cloud:
  baseUrl: "http://localhost:3001"
  apiKey: "test-key"
logging:
  level: "silent"
`,
        'utf-8'
      );

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'allow', reason: 'Allowed' }),
        text: async () => '',
      });

      const veto = await Veto.init({ configDir: VETO_DIR });
      const tools = [{ name: 'test_tool', handler: vi.fn().mockResolvedValue('ok'), inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      const result = await wrapped[0].handler({ query: 'test' });
      expect(result).toBe('ok');
    });

    it('should deny tool call when cloud returns deny', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
cloud:
  baseUrl: "http://localhost:3001"
  apiKey: "test-key"
  retries: 0
logging:
  level: "silent"
`,
        'utf-8'
      );

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ decision: 'deny', reason: 'Blocked by policy' }),
        text: async () => '',
      });

      const veto = await Veto.init({ configDir: VETO_DIR });
      const handler = vi.fn();
      const tools = [{ name: 'blocked', handler, inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      await expect(wrapped[0].handler({})).rejects.toThrow('Tool call denied');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should poll approval and allow when approved', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
cloud:
  baseUrl: "http://localhost:3001"
  apiKey: "test-key"
  retries: 0
approval:
  pollInterval: 10
  timeout: 5000
logging:
  level: "silent"
`,
        'utf-8'
      );

      // First fetch: validate returns require_approval
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'require_approval',
          reason: 'Needs review',
          approval_id: 'appr-001',
        }),
        text: async () => '',
      });

      // Second fetch: poll returns approved
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'appr-001',
          status: 'approved',
          resolvedBy: 'admin@corp.com',
          toolName: 'sensitive_tool',
        }),
        text: async () => '',
      });

      const veto = await Veto.init({ configDir: VETO_DIR });
      const handler = vi.fn().mockResolvedValue('executed');
      const tools = [{ name: 'sensitive_tool', handler, inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      const result = await wrapped[0].handler({ data: 'sensitive' });
      expect(result).toBe('executed');
      expect(handler).toHaveBeenCalled();
    });

    it('should poll approval and deny when denied', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
cloud:
  baseUrl: "http://localhost:3001"
  apiKey: "test-key"
  retries: 0
approval:
  pollInterval: 10
  timeout: 5000
logging:
  level: "silent"
`,
        'utf-8'
      );

      // validate returns require_approval
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'require_approval',
          reason: 'Needs review',
          approval_id: 'appr-002',
        }),
        text: async () => '',
      });

      // poll returns denied
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'appr-002',
          status: 'denied',
          resolvedBy: 'admin',
          toolName: 'dangerous',
        }),
        text: async () => '',
      });

      const veto = await Veto.init({ configDir: VETO_DIR });
      const handler = vi.fn();
      const tools = [{ name: 'dangerous', handler, inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      await expect(wrapped[0].handler({})).rejects.toThrow('Tool call denied');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should deny when approval times out', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
cloud:
  baseUrl: "http://localhost:3001"
  apiKey: "test-key"
  retries: 0
approval:
  pollInterval: 10
  timeout: 50
logging:
  level: "silent"
`,
        'utf-8'
      );

      // validate returns require_approval
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'require_approval',
          reason: 'Review needed',
          approval_id: 'appr-003',
        }),
        text: async () => '',
      });

      // Poll always returns pending
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'appr-003',
          status: 'pending',
          toolName: 'test',
        }),
        text: async () => '',
      });

      const veto = await Veto.init({ configDir: VETO_DIR });
      const handler = vi.fn();
      const tools = [{ name: 'test', handler, inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      await expect(wrapped[0].handler({})).rejects.toThrow('Tool call denied');
      expect(handler).not.toHaveBeenCalled();
    });

    it('should fire onApprovalRequired hook', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
cloud:
  baseUrl: "http://localhost:3001"
  apiKey: "test-key"
  retries: 0
approval:
  pollInterval: 10
logging:
  level: "silent"
`,
        'utf-8'
      );

      // validate returns require_approval
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'require_approval',
          reason: 'Needs human',
          approval_id: 'appr-004',
        }),
        text: async () => '',
      });

      // poll returns approved
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 'appr-004',
          status: 'approved',
          resolvedBy: 'user',
          toolName: 'tool',
        }),
        text: async () => '',
      });

      const onApprovalRequired = vi.fn();

      const veto = await Veto.init({
        configDir: VETO_DIR,
        onApprovalRequired,
      });

      const tools = [{ name: 'tool', handler: vi.fn().mockResolvedValue('ok'), inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      await wrapped[0].handler({});

      expect(onApprovalRequired).toHaveBeenCalledOnce();
      expect(onApprovalRequired).toHaveBeenCalledWith(
        expect.objectContaining({ toolName: 'tool' }),
        'appr-004'
      );
    });
  });

  describe('wrapMCPTools', () => {
    it('should wrap MCP tools and validate before calling server', async () => {
      const mcpTools = [
        {
          name: 'read_file',
          description: 'Read a file',
          inputSchema: {
            type: 'object' as const,
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ];

      const mockServerClient = {
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'file contents' }],
        }),
      };

      const veto = await Veto.init({ configDir: VETO_DIR });
      const { tools, callTool } = veto.wrapMCPTools(mcpTools, mockServerClient);

      // Original tools are returned unmodified
      expect(tools).toBe(mcpTools);
      expect(tools).toHaveLength(1);

      // callTool validates and forwards
      const result = await callTool({ name: 'read_file', arguments: { path: '/tmp/test.txt' } });
      expect(result.content[0].text).toBe('file contents');
      expect(mockServerClient.callTool).toHaveBeenCalledWith({
        name: 'read_file',
        arguments: { path: '/tmp/test.txt' },
      });
    });

    it('should block MCP tool call when validation denies', async () => {
      const rulePath = join(RULES_DIR, 'mcp-block.yaml');
      writeFileSync(rulePath, `
version: "1.0"
name: mcp-block
rules:
  - id: block-read
    name: Block read_file
    enabled: true
    action: block
    tools: [read_file]
`);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'block',
          reasoning: 'Blocked by policy',
          should_block_weight: 1,
        }),
      });

      const mcpTools = [
        {
          name: 'read_file',
          inputSchema: { type: 'object' as const },
        },
      ];

      const mockServerClient = {
        callTool: vi.fn(),
      };

      const veto = await Veto.init({ configDir: VETO_DIR });
      const { callTool } = veto.wrapMCPTools(mcpTools, mockServerClient);

      await expect(callTool({ name: 'read_file', arguments: { path: '/etc/passwd' } }))
        .rejects.toThrow('Tool call denied');
      expect(mockServerClient.callTool).not.toHaveBeenCalled();
    });

    it('should handle callTool without arguments', async () => {
      const mcpTools = [
        {
          name: 'list_tools',
          inputSchema: { type: 'object' as const },
        },
      ];

      const mockServerClient = {
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: '[]' }],
        }),
      };

      const veto = await Veto.init({ configDir: VETO_DIR });
      const { callTool } = veto.wrapMCPTools(mcpTools, mockServerClient);

      const result = await callTool({ name: 'list_tools' });
      expect(result.content[0].text).toBe('[]');
      expect(mockServerClient.callTool).toHaveBeenCalledWith({
        name: 'list_tools',
        arguments: {},
      });
    });
  });

  describe('Approval Preferences', () => {
    it('should auto-approve when approve_all preference is set', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
cloud:
  baseUrl: "http://localhost:3001"
  apiKey: "test-key"
  retries: 0
logging:
  level: "silent"
`,
        'utf-8'
      );

      // validate returns require_approval
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'require_approval',
          reason: 'Needs review',
          approval_id: 'appr-pref-001',
        }),
        text: async () => '',
      });

      const veto = await Veto.init({ configDir: VETO_DIR });
      veto.setApprovalPreference('pref_tool', 'approve_all');

      const handler = vi.fn().mockResolvedValue('auto-approved');
      const tools = [{ name: 'pref_tool', handler, inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      const result = await wrapped[0].handler({});
      expect(result).toBe('auto-approved');
      expect(handler).toHaveBeenCalled();
      // Only the validate call should have been made, no poll call
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should auto-deny when deny_all preference is set', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
cloud:
  baseUrl: "http://localhost:3001"
  apiKey: "test-key"
  retries: 0
logging:
  level: "silent"
`,
        'utf-8'
      );

      // validate returns require_approval
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          decision: 'require_approval',
          reason: 'Needs review',
          approval_id: 'appr-pref-002',
        }),
        text: async () => '',
      });

      const veto = await Veto.init({ configDir: VETO_DIR });
      veto.setApprovalPreference('deny_tool', 'deny_all');

      const handler = vi.fn();
      const tools = [{ name: 'deny_tool', handler, inputSchema: {} }];
      const wrapped = veto.wrap(tools);

      await expect(wrapped[0].handler({})).rejects.toThrow('Tool call denied');
      expect(handler).not.toHaveBeenCalled();
      // Only the validate call, no poll
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should clear preferences', async () => {
      writeFileSync(
        join(VETO_DIR, 'veto.config.yaml'),
        `
version: "1.0"
mode: "strict"
validation:
  mode: "cloud"
logging:
  level: "silent"
`,
        'utf-8'
      );

      const veto = await Veto.init({ configDir: VETO_DIR });

      veto.setApprovalPreference('tool_a', 'approve_all');
      veto.setApprovalPreference('tool_b', 'deny_all');

      expect(veto.getApprovalPreference('tool_a')).toBe('approve_all');
      expect(veto.getApprovalPreference('tool_b')).toBe('deny_all');

      // Clear specific
      veto.clearApprovalPreferences('tool_a');
      expect(veto.getApprovalPreference('tool_a')).toBeUndefined();
      expect(veto.getApprovalPreference('tool_b')).toBe('deny_all');

      // Clear all
      veto.clearApprovalPreferences();
      expect(veto.getApprovalPreference('tool_b')).toBeUndefined();
    });
  });
});
