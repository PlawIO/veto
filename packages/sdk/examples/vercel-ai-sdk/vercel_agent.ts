/**
 * Vercel AI SDK + Veto Example
 *
 * Demonstrates using Veto with the Vercel AI SDK (ai package).
 * Veto wraps tool handlers to validate calls before execution.
 */

import 'dotenv/config';
import { generateText, tool as aiTool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';
import { Veto, ToolCallDeniedError } from 'veto-sdk';

async function main() {
  console.log('=== Vercel AI SDK + Veto Example ===\n');

  const veto = await Veto.init();

  // Define tools using Vercel AI SDK's tool() helper
  const getBalance = {
    name: 'get_balance',
    description: 'Get the balance of a bank account',
    handler: async ({ account_id }: { account_id: string }) =>
      JSON.stringify({ account_id, balance: 25000, currency: 'USD' }),
  };

  const transferFunds = {
    name: 'transfer_funds',
    description: 'Transfer money between bank accounts',
    handler: async ({ amount, from_account, to_account }: { amount: number; from_account: string; to_account: string }) =>
      JSON.stringify({ success: true, amount, from_account, to_account, tx_id: 'TX-' + Date.now() }),
  };

  // Wrap handlers with Veto validation
  const wrapped = veto.wrap([getBalance, transferFunds]);
  const wrappedMap = Object.fromEntries(wrapped.map(t => [t.name, t]));

  // Create Vercel AI SDK tools, delegating to Veto-wrapped handlers
  const tools = {
    get_balance: aiTool({
      description: 'Get the balance of a bank account',
      parameters: z.object({
        account_id: z.string().describe('The account ID'),
      }),
      execute: async (args) => wrappedMap['get_balance'].handler(args),
    }),
    transfer_funds: aiTool({
      description: 'Transfer money between bank accounts',
      parameters: z.object({
        amount: z.number().describe('Amount to transfer in USD'),
        from_account: z.string().describe('Source account ID'),
        to_account: z.string().describe('Destination account ID'),
      }),
      execute: async (args) => wrappedMap['transfer_funds'].handler(args),
    }),
  };

  const prompts = [
    'Check the balance of account ACC-001',
    'Transfer $500 from ACC-001 to ACC-002',
    'Transfer $50,000 from ACC-001 to ACC-003',
    'Transfer $1,000 from ACC-001 to EXT-BANK-999',
  ];

  for (const prompt of prompts) {
    console.log(`\n--- User: ${prompt} ---`);

    try {
      const { text, toolResults } = await generateText({
        model: openai('gpt-4o-mini'),
        system: 'You are a banking assistant. Use the provided tools to help users.',
        prompt,
        tools,
        maxSteps: 3,
      });

      if (toolResults && toolResults.length > 0) {
        for (const tr of toolResults) {
          console.log(`  Tool: ${tr.toolName} -> ${JSON.stringify(tr.result)}`);
        }
      }
      if (text) {
        console.log(`  Assistant: ${text}`);
      }
    } catch (e) {
      if (e instanceof ToolCallDeniedError) {
        console.log(`  BLOCKED by Veto: ${e.message}`);
      } else {
        console.log(`  Error: ${e}`);
      }
    }
  }

  console.log('\n--- Veto Stats ---');
  console.log(veto.getHistoryStats());
}

main().catch(console.error);
