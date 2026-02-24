import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scan } from '../../src/cli/scan.js';

const TEST_DIR = '/tmp/veto-scan-test-' + Date.now();

function writeFixture(relativePath: string, content: string): void {
  const absolutePath = join(TEST_DIR, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf-8');
}

describe('veto scan', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  it('detects TypeScript tools from tool(...) and object-key tool definitions', async () => {
    writeFixture(
      'src/agent.ts',
      `import { z } from 'zod';

const transfer = tool(
  async ({ amount, recipient }) => ({ amount, recipient }),
  {
    name: 'transfer_funds',
    parameters: z.object({
      amount: z.number(),
      recipient: z.string(),
    }),
  }
);

const tools = {
  lookup_user: tool({
    description: 'Lookup a user',
    parameters: z.object({
      userId: z.string(),
    }),
    execute: async ({ userId }) => ({ userId }),
  }),
};
`
    );

    const result = await scan({ directory: TEST_DIR, quiet: true });
    const names = result.report.discoveredTools.map((tool) => tool.name);

    expect(names).toContain('transfer_funds');
    expect(names).toContain('lookup_user');

    const transferTool = result.report.discoveredTools.find((tool) => tool.name === 'transfer_funds');
    expect(transferTool?.parameters).toContain('amount');
    expect(transferTool?.parameters).toContain('recipient');
  });

  it('detects Python tools from @tool decorator and BaseTool subclasses', async () => {
    writeFixture(
      'agent_tools.py',
      `from langchain.tools import tool, BaseTool

@tool
def search_docs(query: str, limit: int = 5):
    return []

class TransferTool(BaseTool):
    name = "transfer_funds"

    def _run(self, amount: float, account: str):
        return True
`
    );

    const result = await scan({ directory: TEST_DIR, quiet: true });
    const names = result.report.discoveredTools.map((tool) => tool.name);

    expect(names).toContain('search_docs');
    expect(names).toContain('transfer_funds');

    const searchTool = result.report.discoveredTools.find((tool) => tool.name === 'search_docs');
    expect(searchTool?.parameters).toContain('query');
    expect(searchTool?.parameters).toContain('limit');
  });

  it('marks tools as covered when a matching tool rule exists', async () => {
    writeFixture(
      'src/agent.ts',
      `const tools = {
  transfer_funds: tool({ execute: async () => null }),
  send_email: tool({ execute: async () => null }),
};
`
    );

    writeFixture(
      'veto/rules/financial.yaml',
      `version: "1.0"
name: financial
rules:
  - id: transfer-limit
    name: Transfer limit
    enabled: true
    severity: high
    action: block
    tools:
      - transfer_funds
`
    );

    const result = await scan({ directory: TEST_DIR, quiet: true });
    const transfer = result.report.discoveredTools.find((tool) => tool.name === 'transfer_funds');
    const email = result.report.discoveredTools.find((tool) => tool.name === 'send_email');

    expect(transfer?.covered).toBe(true);
    expect(email?.covered).toBe(false);
  });

  it('marks all discovered tools as covered when a global rule exists', async () => {
    writeFixture(
      'src/agent.ts',
      `const tools = {
  transfer_funds: tool({ execute: async () => null }),
  send_email: tool({ execute: async () => null }),
};
`
    );

    writeFixture(
      'veto/rules/global.yaml',
      `version: "1.0"
name: baseline
rules:
  - id: baseline-approval
    name: Require approval globally
    enabled: true
    severity: medium
    action: require_approval
`
    );

    const result = await scan({ directory: TEST_DIR, quiet: true });

    expect(result.report.summary.uncovered).toBe(0);
    expect(result.report.discoveredTools.every((tool) => tool.covered)).toBe(true);
  });

  it('fails when --fail-uncovered is enabled and uncovered tools exist', async () => {
    writeFixture('src/agent.ts', `const t = tool({ name: 'read_secret', execute: async () => null });`);

    const result = await scan({
      directory: TEST_DIR,
      quiet: true,
      failUncovered: true,
    });

    expect(result.success).toBe(false);
    expect(result.report.summary.uncovered).toBeGreaterThan(0);
  });

  it('succeeds without --fail-uncovered even when uncovered tools exist', async () => {
    writeFixture('src/agent.ts', `const t = tool({ name: 'read_secret', execute: async () => null });`);

    const result = await scan({
      directory: TEST_DIR,
      quiet: true,
      failUncovered: false,
    });

    expect(result.success).toBe(true);
    expect(result.report.summary.uncovered).toBeGreaterThan(0);
  });

  it('emits financial inline YAML suggestions for transfer_funds', async () => {
    writeFixture(
      'src/agent.ts',
      `const transfer = tool({
  name: 'transfer_funds',
  execute: async ({ amount }) => amount,
});
`
    );

    const result = await scan({
      directory: TEST_DIR,
      quiet: true,
      suggest: true,
    });

    expect(result.report.suggestions).toHaveLength(1);
    expect(result.report.suggestions[0].pack).toBe('@veto/financial');
    expect(result.report.suggestions[0].snippet).toContain('transfer_funds');
    expect(result.report.suggestions[0].snippet).toContain('rules:');
  });

  it('prints parseable JSON output with stable report fields', async () => {
    writeFixture('src/agent.ts', `const t = tool({ name: 'read_secret', execute: async () => null });`);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await scan({
      directory: TEST_DIR,
      quiet: false,
      format: 'json',
    });

    expect(logSpy).toHaveBeenCalledTimes(1);

    const serialized = logSpy.mock.calls[0][0];
    expect(typeof serialized).toBe('string');

    const parsed = JSON.parse(serialized as string) as {
      summary: { total: number; uncovered: number };
      discoveredTools: Array<{ name: string }>;
    };

    expect(parsed.summary.total).toBe(result.report.summary.total);
    expect(parsed.summary.uncovered).toBe(result.report.summary.uncovered);
    expect(parsed.discoveredTools[0]?.name).toBe('read_secret');
  });

  it('ignores node_modules and other excluded directories during source discovery', async () => {
    writeFixture(
      'node_modules/example/index.ts',
      `const transfer = tool({ name: 'transfer_funds', execute: async () => null });`
    );

    const result = await scan({ directory: TEST_DIR, quiet: true });

    expect(result.report.discoveredTools).toHaveLength(0);
  });

  it('honors custom rules directory from veto.config.yaml', async () => {
    writeFixture(
      'src/agent.ts',
      `const t = tool({ name: 'special_tool', execute: async () => null });`
    );

    writeFixture(
      'veto/veto.config.yaml',
      `version: "1.0"
rules:
  directory: "./custom-rules"
  recursive: true
`
    );

    writeFixture(
      'veto/custom-rules/custom.yaml',
      `version: "1.0"
name: custom
rules:
  - id: special-guard
    name: Guard special tool
    enabled: true
    severity: high
    action: block
    tools:
      - special_tool
`
    );

    const result = await scan({ directory: TEST_DIR, quiet: true });

    expect(result.report.policy.rulesDirectory).toBe(join(TEST_DIR, 'veto', 'custom-rules'));

    const discovered = result.report.discoveredTools.find((tool) => tool.name === 'special_tool');
    expect(discovered?.covered).toBe(true);
  });
});
