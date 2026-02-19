/**
 * Anthropic SDK + Veto Example
 *
 * Demonstrates using Veto with the Anthropic SDK's tool use API.
 * Veto validates tool calls before execution using provider adapters.
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { Veto, ToolCallDeniedError } from 'veto-sdk';
import { toAnthropic, fromAnthropicToolUse } from 'veto-sdk/providers';

const toolHandlers: Record<string, (args: Record<string, unknown>) => string> = {
  get_balance: ({ account_id }) =>
    JSON.stringify({ account_id, balance: 25000, currency: 'USD' }),

  transfer_funds: ({ amount, from_account, to_account }) =>
    JSON.stringify({ success: true, amount, from_account, to_account, tx_id: 'TX-' + Date.now() }),
};

const vetoTools = [
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
        amount: { type: 'number', description: 'Amount to transfer in USD' },
        from_account: { type: 'string', description: 'Source account ID' },
        to_account: { type: 'string', description: 'Destination account ID' },
      },
      required: ['amount', 'from_account', 'to_account'],
    },
  },
];

async function main() {
  console.log('=== Anthropic SDK + Veto Example ===\n');

  const client = new Anthropic();
  const veto = await Veto.init();

  const anthropicTools = vetoTools.map(toAnthropic);

  const prompts = [
    'Check the balance of account ACC-001',
    'Transfer $500 from ACC-001 to ACC-002',
    'Transfer $50,000 from ACC-001 to ACC-003',
    'Transfer $1,000 from ACC-001 to EXT-BANK-999',
  ];

  for (const prompt of prompts) {
    console.log(`\n--- User: ${prompt} ---`);

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: 'You are a banking assistant. Use the provided tools to help users.',
      messages: [{ role: 'user', content: prompt }],
      tools: anthropicTools,
    });

    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const vetoCall = fromAnthropicToolUse(block);
        console.log(`  Tool: ${vetoCall.name}(${JSON.stringify(vetoCall.arguments)})`);

        const wrapped = veto.wrap([{
          name: vetoCall.name,
          handler: async (args: Record<string, unknown>) => toolHandlers[vetoCall.name](args),
        }]);

        try {
          const result = await wrapped[0].handler(vetoCall.arguments);
          console.log(`  Result: ${result}`);
        } catch (e) {
          if (e instanceof ToolCallDeniedError) {
            console.log(`  BLOCKED by Veto: ${e.message}`);
          } else {
            throw e;
          }
        }
      } else if (block.type === 'text') {
        console.log(`  Assistant: ${block.text}`);
      }
    }
  }

  console.log('\n--- Veto Stats ---');
  console.log(veto.getHistoryStats());
}

main().catch(console.error);
