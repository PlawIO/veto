/**
 * Google Gemini + Veto Example
 *
 * Demonstrates using Veto with Google's Gemini API function calling.
 * Veto validates tool calls before execution using provider adapters.
 */

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { Veto, ToolCallDeniedError } from 'veto-sdk';
import { toGoogleTool, fromGoogleFunctionCall } from 'veto-sdk/providers';

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
  console.log('=== Google Gemini + Veto Example ===\n');

  const genai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY! });
  const veto = await Veto.init();

  // Convert to Google's tool format
  const googleTool = toGoogleTool(vetoTools);

  const prompts = [
    'Check the balance of account ACC-001',
    'Transfer $500 from ACC-001 to ACC-002',
    'Transfer $50,000 from ACC-001 to ACC-003',       // BLOCKED
    'Transfer $1,000 from ACC-001 to EXT-BANK-999',   // BLOCKED
  ];

  for (const prompt of prompts) {
    console.log(`\n--- User: ${prompt} ---`);

    const response = await genai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        tools: [{ functionDeclarations: googleTool.functionDeclarations }],
        systemInstruction: 'You are a banking assistant. Use the provided tools to help users.',
      },
    });

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.functionCall) {
        const vetoCall = fromGoogleFunctionCall(part.functionCall);
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
      } else if (part.text) {
        console.log(`  Assistant: ${part.text}`);
      }
    }
  }

  console.log('\n--- Veto Stats ---');
  console.log(veto.getHistoryStats());
}

main().catch(console.error);
