/**
 * MCP (Model Context Protocol) + Veto Example
 *
 * Demonstrates using veto.wrapMCPTools() to add guardrails to MCP server tools.
 * The wrapped callTool function validates every call before forwarding to the server.
 */

import { Veto, ToolCallDeniedError } from 'veto-sdk';

// Simulate an MCP server's tool list
const mcpTools = [
  {
    name: 'get_balance',
    description: 'Get the balance of a bank account',
    inputSchema: {
      type: 'object' as const,
      properties: {
        account_id: { type: 'string', description: 'The account ID' },
      },
      required: ['account_id'],
    },
  },
  {
    name: 'transfer_funds',
    description: 'Transfer money between bank accounts',
    inputSchema: {
      type: 'object' as const,
      properties: {
        amount: { type: 'number', description: 'Amount in USD' },
        from_account: { type: 'string', description: 'Source account' },
        to_account: { type: 'string', description: 'Destination account' },
      },
      required: ['amount', 'from_account', 'to_account'],
    },
  },
];

// Simulate an MCP server client
const mcpServerClient = {
  callTool: async (args: { name: string; arguments?: Record<string, unknown> }) => {
    const a = args.arguments ?? {};
    if (args.name === 'get_balance') {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ account_id: a.account_id, balance: 25000, currency: 'USD' }) }],
      };
    }
    if (args.name === 'transfer_funds') {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, ...a, tx_id: 'TX-' + Date.now() }) }],
      };
    }
    return { content: [{ type: 'text' as const, text: 'Unknown tool' }] };
  },
};

async function main() {
  console.log('=== MCP + Veto Example ===\n');

  const veto = await Veto.init();

  // Wrap MCP tools — returns original tool schemas + validated callTool function
  const { tools, callTool } = veto.wrapMCPTools(mcpTools, mcpServerClient);

  console.log(`Wrapped ${tools.length} MCP tools: ${tools.map(t => t.name).join(', ')}\n`);

  // Simulate tool calls that an LLM might make
  const calls = [
    { name: 'get_balance', arguments: { account_id: 'ACC-001' } },
    { name: 'transfer_funds', arguments: { amount: 500, from_account: 'ACC-001', to_account: 'ACC-002' } },
    { name: 'transfer_funds', arguments: { amount: 50000, from_account: 'ACC-001', to_account: 'ACC-003' } },       // BLOCKED
    { name: 'transfer_funds', arguments: { amount: 1000, from_account: 'ACC-001', to_account: 'EXT-BANK-999' } },   // BLOCKED
  ];

  for (const call of calls) {
    console.log(`--- callTool: ${call.name}(${JSON.stringify(call.arguments)}) ---`);
    try {
      // Optional preflight: run guard() without forwarding to MCP server.
      const guard = await veto.guard(call.name, call.arguments ?? {}, {
        sessionId: 'mcp-example-session',
        agentId: 'mcp-example-agent',
      });

      if (guard.decision !== 'allow') {
        console.log(
          `  Guard decision: ${guard.decision} (${guard.reason ?? 'no reason'})`
          + `${guard.ruleId ? ` [rule=${guard.ruleId}]` : ''}`
          + `${guard.severity ? ` [severity=${guard.severity}]` : ''}`
          + `${guard.approvalId ? ` [approval=${guard.approvalId}]` : ''}\n`
        );
        continue;
      }

      const result = await callTool(call);
      const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
      console.log(`  Result: ${text}\n`);
    } catch (e) {
      if (e instanceof ToolCallDeniedError) {
        console.log(`  BLOCKED by Veto: ${e.message}\n`);
      } else {
        throw e;
      }
    }
  }

  console.log('--- Veto Stats ---');
  console.log(veto.getHistoryStats());
}

main().catch(console.error);
