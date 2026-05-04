import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Veto } from '../../src/core/veto.js';
import { fromMCPToolCall } from '../../src/providers/adapters.js';
import type { ToolDefinition } from '../../src/types/tool.js';
import { guardVercelAIToolCall } from '../../src/integrations/vercel-ai/index.js';
import { guardOpenAIAgentsToolCall } from '../../src/integrations/openai-agents/index.js';
import { guardLangChainToolCall } from '../../src/integrations/langchain/index.js';
import { guardClaudeToolUse, toClaudeTools } from '../../src/integrations/claude-sdk/index.js';
import {
  guardGoogleADKFunctionCall,
  toGoogleADKFunctionDeclarations,
} from '../../src/integrations/google-adk/index.js';
import { guardMastraToolCall, wrapMastraTool } from '../../src/integrations/mastra/index.js';
import { guardAutoGenToolCall, wrapAutoGenTool } from '../../src/integrations/autogen/index.js';
import { guardCrewAIToolCall, wrapCrewAITool } from '../../src/integrations/crewai/index.js';

interface ParityCase {
  label: string;
  toolName: string;
  args: Record<string, unknown>;
  expected: 'allow' | 'deny' | 'require_approval';
}

const parityCases: ParityCase[] = [
  {
    label: 'safe search',
    toolName: 'search',
    args: { query: 'status' },
    expected: 'allow',
  },
  {
    label: 'destructive shell',
    toolName: 'bash',
    args: { command: 'rm -rf /tmp/veto-parity' },
    expected: 'deny',
  },
  {
    label: 'destructive file delete',
    toolName: 'delete_file',
    args: { path: '/tmp/veto-parity' },
    expected: 'deny',
  },
  {
    label: 'approval-gated deploy',
    toolName: 'deploy',
    args: { environment: 'production' },
    expected: 'require_approval',
  },
];

function writeParityPolicy(configDir: string): void {
  const rulesDir = join(configDir, 'rules');
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(
    join(configDir, 'veto.config.yaml'),
    `
version: "1.0"
mode: "strict"
validation:
  mode: "local"
logging:
  level: "silent"
rules:
  directory: "./rules"
`,
    'utf-8',
  );
  writeFileSync(
    join(rulesDir, 'parity.yaml'),
    `
version: "1.0"
rules:
  - id: parity-deny-destructive-bash
    name: Deny destructive shell
    enabled: true
    action: block
    tools: [bash]
    conditions:
      - field: arguments.command
        operator: contains
        value: rm -rf
  - id: parity-deny-delete-file
    name: Deny file deletion
    enabled: true
    action: block
    tools: [delete_file]
  - id: parity-approval-prod-deploy
    name: Require production deploy approval
    enabled: true
    action: require_approval
    tools: [deploy]
    conditions:
      - field: arguments.environment
        operator: equals
        value: production
`,
    'utf-8',
  );
}

describe('runtime adapter parity', () => {
  let testDir: string;
  let configDir: string;
  let veto: Veto;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'veto-runtime-parity-'));
    configDir = join(testDir, 'veto');
    mkdirSync(configDir, { recursive: true });
    writeParityPolicy(configDir);
    veto = await Veto.init({ configDir });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const adapters: Array<{
    name: string;
    decide: (veto: Veto, testCase: ParityCase) => Promise<ParityCase['expected']>;
  }> = [
    {
      name: 'Vercel AI',
      decide: async (v, testCase) => (await guardVercelAIToolCall(v, {
        type: 'tool-call',
        toolCallId: `vercel-${testCase.label}`,
        toolName: testCase.toolName,
        args: JSON.stringify(testCase.args),
      })).decision,
    },
    {
      name: 'OpenAI Agents',
      decide: async (v, testCase) => (await guardOpenAIAgentsToolCall(v, {
        tool_name: testCase.toolName,
        tool_arguments: JSON.stringify(testCase.args),
      })).decision,
    },
    {
      name: 'Claude SDK',
      decide: async (v, testCase) => (await guardClaudeToolUse(v, {
        type: 'tool_use',
        id: `claude-${testCase.label}`,
        name: testCase.toolName,
        input: testCase.args,
      })).decision,
    },
    {
      name: 'LangChain/LangGraph',
      decide: async (v, testCase) => (await guardLangChainToolCall(v, {
        id: `langchain-${testCase.label}`,
        name: testCase.toolName,
        args: testCase.args,
      })).decision,
    },
    {
      name: 'Google ADK',
      decide: async (v, testCase) => (await guardGoogleADKFunctionCall(v, {
        id: `google-${testCase.label}`,
        name: testCase.toolName,
        args: testCase.args,
      })).decision,
    },
    {
      name: 'Mastra',
      decide: async (v, testCase) => (await guardMastraToolCall(
        v,
        testCase.toolName,
        testCase.args,
      )).decision,
    },
    {
      name: 'AutoGen',
      decide: async (v, testCase) => (await guardAutoGenToolCall(v, {
        id: `autogen-${testCase.label}`,
        name: testCase.toolName,
        arguments: JSON.stringify(testCase.args),
      })).decision,
    },
    {
      name: 'CrewAI',
      decide: async (v, testCase) => (await guardCrewAIToolCall(v, {
        id: `crewai-${testCase.label}`,
        name: testCase.toolName,
        input: testCase.args,
      })).decision,
    },
    {
      name: 'MCP',
      decide: async (v, testCase) => {
        const call = fromMCPToolCall({
          name: testCase.toolName,
          arguments: testCase.args,
        });
        return (await v.guard(call.name, call.arguments)).decision;
      },
    },
  ];

  for (const adapter of adapters) {
    it(`${adapter.name} maps allow, deny, and approval decisions`, async () => {
      for (const testCase of parityCases) {
        await expect(adapter.decide(veto, testCase), testCase.label).resolves.toBe(testCase.expected);
      }
    });
  }

  it('new provider-backed adapters reuse existing schema converters', () => {
    const tool: ToolDefinition = {
      name: 'search',
      description: 'Search indexed documents',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    };

    expect(toClaudeTools([tool])[0]).toEqual({
      name: 'search',
      description: 'Search indexed documents',
      input_schema: tool.inputSchema,
    });
    expect(toGoogleADKFunctionDeclarations([tool])[0]).toEqual({
      name: 'search',
      description: 'Search indexed documents',
      parameters: tool.inputSchema,
    });
  });

  it('runtime function wrappers guard before handler execution', async () => {
    const deniedVeto = {
      guard: vi.fn().mockResolvedValue({ decision: 'deny', reason: 'Blocked' }),
    } as unknown as Veto;

    const mastraHandler = vi.fn().mockResolvedValue('ok');
    const mastraTool = wrapMastraTool(deniedVeto, {
      name: 'delete_file',
      execute: mastraHandler,
    });
    await expect(mastraTool.execute({ path: '/tmp/x' })).rejects.toMatchObject({
      name: 'VetoRuntimeAdapterError',
      decision: 'deny',
    });
    expect(mastraHandler).not.toHaveBeenCalled();

    const autoGenHandler = vi.fn().mockResolvedValue('ok');
    const autoGenTool = wrapAutoGenTool(deniedVeto, {
      name: 'delete_file',
      func: autoGenHandler,
    });
    await expect(autoGenTool.func?.({ path: '/tmp/x' })).rejects.toMatchObject({
      name: 'VetoRuntimeAdapterError',
      decision: 'deny',
    });
    expect(autoGenHandler).not.toHaveBeenCalled();

    const crewHandler = vi.fn().mockResolvedValue('ok');
    const crewTool = wrapCrewAITool(deniedVeto, {
      name: 'delete_file',
      func: crewHandler,
    });
    await expect(crewTool.func?.({ path: '/tmp/x' })).rejects.toMatchObject({
      name: 'VetoRuntimeAdapterError',
      decision: 'deny',
    });
    expect(crewHandler).not.toHaveBeenCalled();
  });
});
