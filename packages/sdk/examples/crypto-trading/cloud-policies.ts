type LlmPolicyPayload = {
  toolName: string;
  mode: 'llm';
  llmConfig: {
    description: string;
    exceptions?: string[];
    argumentInstructions?: Array<{
      argumentName: string;
      instruction: string;
    }>;
    preferredModel: 'anthropic' | 'openai' | 'gemini' | 'openrouter';
  };
};

const baseUrl = process.env.VETO_BASE_URL ?? 'https://api.veto.so';
const apiKey = process.env.VETO_API_KEY;

if (!apiKey) {
  throw new Error('Set VETO_API_KEY before running this example.');
}

const policies: LlmPolicyPayload[] = [
  // Force the agent to explain why a trade has real informational backing.
  {
    toolName: 'place_order',
    mode: 'llm',
    llmConfig: {
      description: 'Only allow trades where the agent provides documented, research-based reasoning. The reasoning must reference specific market data, on-chain metrics, news events, or fundamental analysis. Reject trades based purely on technical patterns without fundamental backing. Reject trades that chase recent pumps (tokens up >15% in 24h) unless strong fundamental justification is provided. The agent must explain the risk-reward ratio and exit strategy.',
      exceptions: [
        'Stop-loss orders and take-profit orders are always allowed',
        'Reducing position size is always allowed',
        'DCA into documented strategies is allowed',
      ],
      argumentInstructions: [
        {
          argumentName: 'reasoning',
          instruction: "Must reference specific data. 'Looks bullish' or 'good entry' is insufficient.",
        },
      ],
      preferredModel: 'anthropic',
    },
  },

  // Force the agent to prove it has a measurable edge before betting.
  {
    toolName: 'place_bet',
    mode: 'llm',
    llmConfig: {
      description: "Only allow bets where the agent identifies a clear edge — the market price must differ meaningfully from the agent's calculated probability. The agent must explain: (1) what information the market is missing or mispricing, (2) the agent's estimated true probability, (3) why the agent's estimate is more accurate than the market consensus. Reject bets where the agent's edge is less than 5% (e.g., market says 50%, agent says 54%). Reject bets on events the agent has no informational advantage on.",
      exceptions: [
        'Hedging existing positions is always allowed',
        'Selling existing shares to reduce exposure is always allowed',
      ],
      argumentInstructions: [
        {
          argumentName: 'reasoning',
          instruction: "Must include: market probability, agent's estimated probability, identified edge, and information source.",
        },
      ],
      preferredModel: 'anthropic',
    },
  },

  // Force the agent to justify leverage increases with explicit downside math.
  {
    toolName: 'change_leverage',
    mode: 'llm',
    llmConfig: {
      description: 'Only allow leverage increases when the agent justifies the risk-reward. Must explain: expected move size, stop-loss distance, and maximum acceptable loss in USD. Deny during high-volatility events. Never allow above 3x on altcoins.',
      exceptions: [
        'Reducing leverage is always allowed',
        'Setting leverage to 1x is always allowed',
      ],
      preferredModel: 'anthropic',
    },
  },
];

async function createPolicy(payload: LlmPolicyPayload): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/policies`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-veto-api-key': apiKey!,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Failed to create ${payload.toolName}: ${response.status} ${body}`);
  }

  const result = await response.json().catch(() => ({}));
  console.log(`created ${payload.toolName}`, result);
}

async function main(): Promise<void> {
  console.log(`creating ${policies.length} cloud policies against ${baseUrl}`);

  for (const policy of policies) {
    await createPolicy(policy);
  }

  console.log('done');
}

await main();
