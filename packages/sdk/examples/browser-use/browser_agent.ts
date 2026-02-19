/**
 * browser-use + Veto Example
 *
 * Demonstrates using Veto's browser-use integration to add guardrails
 * to browser automation agents. wrapBrowserUse() returns a Controller
 * that validates every browser action before execution.
 */

import 'dotenv/config';
import { Veto } from 'veto-sdk';
import { wrapBrowserUse } from 'veto-sdk/integrations/browser-use';

async function main() {
  console.log('=== browser-use + Veto Example ===\n');

  const veto = await Veto.init();

  // Wrap browser-use with Veto validation
  // Returns a Controller that validates actions before execution
  const controller = await wrapBrowserUse(veto, {
    onAllow: (action, params) => {
      console.log(`  ALLOWED: ${action}(${JSON.stringify(params)})`);
    },
    onDeny: (action, params, reason) => {
      console.log(`  BLOCKED: ${action}(${JSON.stringify(params)}) — ${reason}`);
    },
  });

  console.log('Controller created with Veto validation.\n');
  console.log('In a real application, you would use the controller like:\n');
  console.log('  import { Agent, Browser } from "browser-use-node";');
  console.log('');
  console.log('  const agent = new Agent({');
  console.log('    task: "Search for the latest AI news",');
  console.log('    llm: myLLMClient,');
  console.log('    browser: new Browser(),');
  console.log('    controller,  // <-- Veto-wrapped controller');
  console.log('  });');
  console.log('');
  console.log('  await agent.run();');
  console.log('');
  console.log('Veto will validate each browser action (go_to_url, click_element,');
  console.log('input_text, etc.) against your rules before the browser executes it.');
  console.log('');
  console.log('Rules configured:');
  console.log('  - Block navigation to URLs containing "malware" or "/admin"');
  console.log('  - Block typing passwords into forms');

  console.log('\n--- Veto Stats ---');
  console.log(veto.getHistoryStats());
}

main().catch(console.error);
