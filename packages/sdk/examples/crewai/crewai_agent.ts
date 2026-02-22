/**
 * CrewAI-style Tools + Veto Example
 *
 * Demonstrates how Veto's wrap() works with tools that use an `execute`
 * method — the pattern used by CrewAI and similar agent frameworks.
 * Veto automatically detects and wraps execute/handler/run/call methods.
 */

import { Veto, ToolCallDeniedError } from 'veto-sdk';

// CrewAI-style tool class with execute() method
class GetBalanceTool {
  name = 'get_balance';
  description = 'Get the balance of a bank account';

  async execute(args: Record<string, unknown>): Promise<string> {
    return JSON.stringify({
      account_id: args.account_id,
      balance: 25000,
      currency: 'USD',
    });
  }
}

class TransferFundsTool {
  name = 'transfer_funds';
  description = 'Transfer money between bank accounts';

  async execute(args: Record<string, unknown>): Promise<string> {
    return JSON.stringify({
      success: true,
      amount: args.amount,
      from_account: args.from_account,
      to_account: args.to_account,
      tx_id: 'TX-' + Date.now(),
    });
  }
}

async function main() {
  console.log('=== CrewAI-style Tools + Veto Example ===\n');

  const veto = await Veto.init();

  // Create tool instances (CrewAI-style: classes with execute() method)
  const tools = [new GetBalanceTool(), new TransferFundsTool()];

  // Veto.wrap() auto-detects the execute() method and wraps it
  const wrappedTools = veto.wrap(tools);

  // Simulate agent executing tool calls
  const calls = [
    { tool: 'get_balance', args: { account_id: 'ACC-001' } },
    { tool: 'transfer_funds', args: { amount: 500, from_account: 'ACC-001', to_account: 'ACC-002' } },
    { tool: 'transfer_funds', args: { amount: 50000, from_account: 'ACC-001', to_account: 'ACC-003' } },       // BLOCKED
    { tool: 'transfer_funds', args: { amount: 1000, from_account: 'ACC-001', to_account: 'EXT-BANK-999' } },   // BLOCKED
  ];

  for (const call of calls) {
    const tool = wrappedTools.find(t => t.name === call.tool)!;
    console.log(`--- ${call.tool}(${JSON.stringify(call.args)}) ---`);

    try {
      // Optional preflight: run guard() before calling execute().
      const guard = await veto.guard(call.tool, call.args, {
        sessionId: 'crewai-example-session',
        agentId: 'crewai-example-agent',
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

      const result = await tool.execute(call.args);
      console.log(`  Result: ${result}\n`);
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
