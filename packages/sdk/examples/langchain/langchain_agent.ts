/**
 * LangChain + Veto Example
 *
 * Demonstrates the simplest integration pattern: define LangChain tools,
 * wrap with veto.wrap(), and pass to createAgent. Veto validates every
 * tool call transparently.
 */

import 'dotenv/config';
import { createAgent, tool } from 'langchain';
import { z } from 'zod';
import { Veto } from 'veto-sdk';

const getBalance = tool(
  ({ account_id }) =>
    JSON.stringify({ account_id, balance: 25000, currency: 'USD' }),
  {
    name: 'get_balance',
    description: 'Get the balance of a bank account',
    schema: z.object({
      account_id: z.string().describe('The account ID'),
    }),
  }
);

const transferFunds = tool(
  ({ amount, from_account, to_account }) =>
    JSON.stringify({ success: true, amount, from_account, to_account, tx_id: 'TX-' + Date.now() }),
  {
    name: 'transfer_funds',
    description: 'Transfer money between bank accounts',
    schema: z.object({
      amount: z.number().describe('Amount to transfer in USD'),
      from_account: z.string().describe('Source account ID'),
      to_account: z.string().describe('Destination account ID'),
    }),
  }
);

async function main() {
  console.log('=== LangChain + Veto Example ===\n');

  // 1. Initialize Veto
  const veto = await Veto.init();

  // 2. Wrap tools — types preserved, validation injected
  const tools = veto.wrap([getBalance, transferFunds]);

  // Optional preflight examples using guard() without executing tools.
  const preflightChecks = [
    { name: 'transfer_funds', args: { amount: 500, from_account: 'ACC-001', to_account: 'ACC-002' } },
    { name: 'transfer_funds', args: { amount: 50000, from_account: 'ACC-001', to_account: 'ACC-003' } },
  ];

  console.log('--- Guard preflight checks ---');
  for (const check of preflightChecks) {
    const guard = await veto.guard(check.name, check.args, {
      sessionId: 'langchain-example-session',
      agentId: 'langchain-example-agent',
    });
    console.log(
      `  ${check.name} -> ${guard.decision}`
      + `${guard.reason ? ` (${guard.reason})` : ''}`
      + `${guard.ruleId ? ` [rule=${guard.ruleId}]` : ''}`
      + `${guard.severity ? ` [severity=${guard.severity}]` : ''}`
      + `${guard.approvalId ? ` [approval=${guard.approvalId}]` : ''}`
    );
  }
  console.log('');

  // 3. Create LangChain agent with wrapped tools
  const agent = createAgent({
    model: 'google-genai:gemini-2.0-flash',
    tools,
  });

  const prompts = [
    'Check the balance of account ACC-001',
    'Transfer $500 from ACC-001 to ACC-002',
    'Transfer $50,000 from ACC-001 to ACC-003',       // BLOCKED
    'Transfer $1,000 from ACC-001 to EXT-BANK-999',   // BLOCKED
  ];

  for (const prompt of prompts) {
    console.log(`\n--- User: ${prompt} ---`);
    try {
      const result = await agent.invoke({
        messages: [{ role: 'user', content: prompt }],
      });
      const lastMsg = result.messages[result.messages.length - 1];
      console.log(`  Agent: ${lastMsg.content}`);
    } catch (e) {
      console.log(`  Error: ${e}`);
    }
  }

  console.log('\n--- Veto Stats ---');
  console.log(veto.getHistoryStats());
}

main().catch(console.error);
