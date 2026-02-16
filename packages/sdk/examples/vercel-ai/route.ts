/**
 * Vercel AI SDK + Veto — Next.js Route Handler Example
 *
 * This example shows how to add Veto guardrails to a Next.js API route
 * that uses the Vercel AI SDK for tool-calling agents.
 *
 * Setup:
 *   npm install veto-sdk ai @ai-sdk/openai zod
 *
 * Add to your Next.js app at: app/api/chat/route.ts
 */

import { streamText, tool, wrapLanguageModel } from 'ai';
import { openai } from '@ai-sdk/openai';
import { Veto } from 'veto-sdk';
import { createVetoMiddleware } from 'veto-sdk/integrations/vercel-ai';
import { z } from 'zod';

// Initialize Veto once at module level
const veto = await Veto.init();

// Wrap the model with Veto middleware
const model = wrapLanguageModel({
  model: openai('gpt-4o'),
  middleware: createVetoMiddleware(veto, {
    onDeny: (toolName, args, reason) => {
      console.log(`[Veto] Blocked ${toolName}: ${reason}`);
    },
  }),
});

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model,
    system: 'You are a helpful assistant with access to tools.',
    messages,
    tools: {
      getWeather: tool({
        description: 'Get current weather for a city',
        parameters: z.object({
          city: z.string().describe('City name'),
        }),
        execute: async ({ city }) => ({
          city,
          temperature: 72,
          conditions: 'sunny',
        }),
      }),
      sendEmail: tool({
        description: 'Send an email to a recipient',
        parameters: z.object({
          to: z.string().email(),
          subject: z.string(),
          body: z.string(),
        }),
        execute: async ({ to: _to, subject: _subject, body: _body }) => ({
          sent: true,
          messageId: `msg_${Date.now()}`,
        }),
      }),
    },
    maxSteps: 5,
  });

  return result.toDataStreamResponse();
}
