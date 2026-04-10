# Crypto trading cloud policy examples

These are example Veto Cloud `POST /v1/policies` payloads for semantic enforcement that cannot be expressed cleanly with deterministic YAML alone.

Use them when you want Veto Cloud to judge the agent's reasoning quality, information edge, and leverage justification in `mode: "llm"`.

Trade reasoning enforcement:

```json
{
  "toolName": "place_order",
  "mode": "llm",
  "llmConfig": {
    "description": "Only allow trades where the agent provides documented, research-based reasoning. The reasoning must reference specific market data, on-chain metrics, news events, or fundamental analysis. Reject trades based purely on technical patterns without fundamental backing. Reject trades that chase recent pumps (tokens up >15% in 24h) unless strong fundamental justification is provided. The agent must explain the risk-reward ratio and exit strategy.",
    "exceptions": [
      "Stop-loss orders and take-profit orders are always allowed",
      "Reducing position size is always allowed",
      "DCA into documented strategies is allowed"
    ],
    "argumentInstructions": [
      {
        "argumentName": "reasoning",
        "instruction": "Must reference specific data. 'Looks bullish' or 'good entry' is insufficient."
      }
    ],
    "preferredModel": "anthropic"
  }
}
```

Prediction market reasoning:

```json
{
  "toolName": "place_bet",
  "mode": "llm",
  "llmConfig": {
    "description": "Only allow bets where the agent identifies a clear edge — the market price must differ meaningfully from the agent's calculated probability. The agent must explain: (1) what information the market is missing or mispricing, (2) the agent's estimated true probability, (3) why the agent's estimate is more accurate than the market consensus. Reject bets where the agent's edge is less than 5% (e.g., market says 50%, agent says 54%). Reject bets on events the agent has no informational advantage on.",
    "exceptions": [
      "Hedging existing positions is always allowed",
      "Selling existing shares to reduce exposure is always allowed"
    ],
    "argumentInstructions": [
      {
        "argumentName": "reasoning",
        "instruction": "Must include: market probability, agent's estimated probability, identified edge, and information source."
      }
    ],
    "preferredModel": "anthropic"
  }
}
```

Leverage justification:

```json
{
  "toolName": "change_leverage",
  "mode": "llm",
  "llmConfig": {
    "description": "Only allow leverage increases when the agent justifies the risk-reward. Must explain: expected move size, stop-loss distance, and maximum acceptable loss in USD. Deny during high-volatility events. Never allow above 3x on altcoins.",
    "exceptions": [
      "Reducing leverage is always allowed",
      "Setting leverage to 1x is always allowed"
    ],
    "preferredModel": "anthropic"
  }
}
```

Run the executable example from the SDK package root:

```bash
npx tsx examples/crypto-trading/cloud-policies.ts
```

Set:

```bash
export VETO_API_KEY="veto_..."
export VETO_BASE_URL="https://api.veto.so"
```
