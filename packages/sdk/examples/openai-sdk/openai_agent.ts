/**
 * OpenAI SDK + Veto Example
 *
 * Demonstrates using Veto with the OpenAI SDK's function calling API.
 * Veto validates tool calls before execution using provider adapters.
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { Veto, ToolCallDeniedError } from 'veto-sdk';
import { toOpenAI, fromOpenAIToolCall } from 'veto-sdk/providers';

// Tool implementations
const toolHandlers: Record<string, (args: Record<string, unknown>) => string> = {
  get_balance: ({ account_id }) =>
    JSON.stringify({ account_id, balance: 25000, currency: 'USD' }),

  transfer_funds: ({ amount, from_account, to_account }) =>
    JSON.stringify({ success: true, amount, from_account, to_account, tx_id: 'TX-' + Date.now() }),
};

// Tool definitions in Veto's format
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
  console.log('=== OpenAI SDK + Veto Example ===\n');

  const client = new OpenAI();
  const veto = await Veto.init();

  // Convert tool definitions to OpenAI format
  const openAITools = vetoTools.map(toOpenAI);

  const prompts = [
    'Check the balance of account ACC-001',
    'Transfer $500 from ACC-001 to ACC-002',
    'Transfer $50,000 from ACC-001 to ACC-003',       // BLOCKED: amount > 10000
    'Transfer $1,000 from ACC-001 to EXT-BANK-999',   // BLOCKED: external transfer
  ];

  for (const prompt of prompts) {
    console.log(`\n--- User: ${prompt} ---`);

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: 'You are a banking assistant. Use the provided tools to help users.' },
      { role: 'user', content: prompt },
    ];

    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      tools: openAITools,
    });

    const choice = response.choices[0];

    if (choice.message.tool_calls) {
      for (const toolCall of choice.message.tool_calls) {
        const vetoCall = fromOpenAIToolCall(toolCall);
        console.log(`  Tool: ${vetoCall.name}(${JSON.stringify(vetoCall.arguments)})`);

        // Optional preflight: run guard() without executing the tool.
        const guard = await veto.guard(vetoCall.name, vetoCall.arguments, {
          sessionId: 'openai-example-session',
          agentId: 'openai-example-agent',
        });

        if (guard.decision !== 'allow') {
          console.log(
            `  Guard decision: ${guard.decision} (${guard.reason ?? 'no reason'})`
            + `${guard.ruleId ? ` [rule=${guard.ruleId}]` : ''}`
            + `${guard.severity ? ` [severity=${guard.severity}]` : ''}`
            + `${guard.approvalId ? ` [approval=${guard.approvalId}]` : ''}`
          );
          continue;
        }

        // Validate with Veto before executing
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
      }
    } else {
      console.log(`  Assistant: ${choice.message.content}`);
    }
  }

  console.log('\n--- Veto Stats ---');
  console.log(veto.getHistoryStats());
}

main().catch(console.error);
