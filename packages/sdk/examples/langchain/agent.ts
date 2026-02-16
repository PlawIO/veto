/**
 * LangChain + Veto — Agent Middleware Example (TypeScript)
 *
 * This example shows how to add Veto guardrails to a LangChain agent
 * using the v1 middleware system.
 *
 * Setup:
 *   npm install veto-sdk langchain @langchain/openai @langchain/core
 */

// @ts-expect-error example file, imports may not resolve in SDK repo
import { createAgent } from 'langchain';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { Veto } from 'veto-sdk';
import { createVetoLangChainMiddleware } from 'veto-sdk/integrations/langchain';

// Define tools
const searchTool = tool(
  ({ query }) => `Search results for: ${query}`,
  {
    name: 'web_search',
    description: 'Search the web for information',
    schema: z.object({
      query: z.string().describe('Search query'),
    }),
  },
);

const sendEmailTool = tool(
  async ({ to, subject: _subject, body: _body }) => `Email sent to ${to}`,
  {
    name: 'send_email',
    description: 'Send an email',
    schema: z.object({
      to: z.string().email(),
      subject: z.string(),
      body: z.string(),
    }),
  },
);

async function main() {
  const veto = await Veto.init();

  // Create agent with Veto middleware
  const agent = createAgent({
    model: 'openai:gpt-4o',
    tools: [searchTool, sendEmailTool],
    middleware: [
      createVetoLangChainMiddleware(veto, {
        onAllow: (name, args) => console.log(`[Veto] Allowed: ${name}`),
        onDeny: (name, _args, reason) => console.log(`[Veto] Blocked ${name}: ${reason}`),
      }),
    ],
    systemPrompt: 'You are a helpful assistant.',
  });

  const result = await agent.invoke({
    messages: [{ role: 'user', content: 'Search for the weather in SF and email the results to alice@example.com' }],
  });

  console.log(result);
}

main().catch(console.error);
