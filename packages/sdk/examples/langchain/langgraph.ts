/**
 * LangGraph + Veto — ToolNode Wrapper Example (TypeScript)
 *
 * This example shows how to add Veto guardrails to a raw LangGraph graph
 * without using the createAgent middleware API.
 *
 * Setup:
 *   npm install veto-sdk @langchain/langgraph @langchain/openai @langchain/core
 */

// @ts-expect-error example file, imports may not resolve in SDK repo
import { StateGraph, MessagesAnnotation, START, END } from '@langchain/langgraph';
import { ToolNode, toolsCondition } from '@langchain/langgraph/prebuilt';
import { ChatOpenAI } from '@langchain/openai';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { Veto } from 'veto-sdk';
import { createVetoToolNode } from 'veto-sdk/integrations/langchain';

// Define tools
const searchTool = tool(
  ({ query }) => `Results for: ${query}`,
  {
    name: 'web_search',
    description: 'Search the web',
    schema: z.object({ query: z.string() }),
  },
);

const deleteTool = tool(
  ({ path }) => `Deleted ${path}`,
  {
    name: 'delete_file',
    description: 'Delete a file from disk',
    schema: z.object({ path: z.string() }),
  },
);

async function main() {
  const veto = await Veto.init();
  const model = new ChatOpenAI({ model: 'gpt-4o' }).bindTools([searchTool, deleteTool]);

  const callModel = async (state: typeof MessagesAnnotation.State) => {
    const response = await model.invoke(state.messages);
    return { messages: [response] };
  };

  // Wrap the ToolNode with Veto validation
  const toolNode = new ToolNode([searchTool, deleteTool]);
  const vetoToolNode = createVetoToolNode(veto, toolNode, {
    onDeny: (name, _args, reason) => console.log(`[Veto] Blocked ${name}: ${reason}`),
  });

  const graph = new StateGraph(MessagesAnnotation)
    .addNode('agent', callModel)
    .addNode('tools', vetoToolNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', toolsCondition, ['tools', END])
    .addEdge('tools', 'agent')
    .compile();

  const result = await graph.invoke({
    messages: [{ role: 'user', content: 'Search for "veto sdk" then delete /tmp/cache' }],
  });

  console.log(result.messages.at(-1)?.content);
}

main().catch(console.error);
