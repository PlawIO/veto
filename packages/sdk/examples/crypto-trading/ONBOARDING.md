# OpenClaw onboarding playbook for `@veto/crypto-trading`

Use this file as context when an OpenClaw agent is walking a user through safe trading setup.

## Goal

Turn a conversational onboarding flow into a personalized Veto config with conservative defaults, clear approval gates, and editable thresholds that map directly to the `# Adjust:` comments in `packs/crypto-trading.yaml`.

## Questions to ask

1. What do you want to trade first?
   - Crypto spot
   - Crypto futures
   - Prediction markets
   - A mix
2. Which venue are you using?
   - Binance
   - Bybit
   - OKX
   - Polymarket
   - Manifold
3. What is your total starting budget for this session?
4. What is the maximum amount you are comfortable putting into a single trade?
5. What is the maximum amount you are comfortable putting into a single prediction market bet?
6. What leverage, if any, are you comfortable with?
7. How many positions or bets do you want open at once?
8. How much friction do you want?
   - Approve nearly everything
   - Auto-allow only tiny trades
   - Move faster with larger auto-allowed trades
9. What best describes your experience level?
   - New
   - Some experience
   - Very experienced
10. What best describes your risk tolerance?
    - Conservative
    - Moderate
    - Aggressive

## Preset mapping

| Question             | Conservative | Moderate | Aggressive |
| -------------------- | -----------: | -------: | ---------: |
| Max leverage         |           2x |       5x |        10x |
| Max single trade     |         $500 |   $2,000 |    $10,000 |
| Max single bet       |         $100 |     $500 |     $2,000 |
| Session budget       |         $500 |   $1,000 |     $5,000 |
| Auto-allow threshold |          $50 |     $200 |     $1,000 |
| Max open positions   |            2 |        3 |          5 |
| Max open bets        |            3 |        5 |         10 |

## How answers map to config values

- `Max leverage` → `crypto-max-leverage`
- `Max single trade` → `crypto-max-position`
- `Max single bet` → `crypto-max-bet`
- `Auto-allow threshold` → `crypto-allow-small-trades` and `crypto-approve-trades`
- `Auto-allow bet threshold` → `crypto-allow-small-bets` and `crypto-approve-bets`
- `Session budget` → `economic.budgets[0].limit` and `sessionConstraints.budget`
- `Always approve above` → `economic.budgets[0].approval_threshold`
- `Max open positions` → `sessionConstraints.counters.open_positions.max`
- `Max open bets` → `sessionConstraints.counters.active_bets.max`
- `Max cumulative session volume` → `sessionConstraints.cumulativeLimits`

Use the preset first, then fine-tune with the user's actual answers.

## Recommended interpretation

- If the user is new or anxious, start conservative even if they ask for faster execution.
- If they want futures, keep the leverage cap conservative unless they explicitly demonstrate experience.
- If they only want prediction markets, still keep approval gates active and preserve the read/research-before-action rules.
- If they want "fully automatic" behavior, explain that Veto defaults to approval for real-money writes and that this is intentional.

## CLI flow

Initialize:

```bash
veto agent init --pack crypto-trading
```

Adjust limits from the conversation:

```bash
veto agent policy-add "set max leverage to 3x"
veto agent policy-add "set max single trade to $1000"
veto agent policy-add "set max single bet to $250"
veto agent policy-add "set auto-allow trade threshold to $100"
veto agent policy-add "set session budget to $2000"
veto agent policy-add "set max open positions to 3"
veto agent policy-add "set max open bets to 5"
```

Verify:

```bash
veto agent scan
veto agent policy-list
```

## Suggested step-by-step agent flow

1. Confirm trading domain and venue.
2. Classify the user into conservative, moderate, or aggressive.
3. Initialize with the pack.
4. Apply the preset values that match the user.
5. Override any value that the user answered explicitly.
6. Verify the config.
7. Explain that read-only tools are frictionless, small trades may auto-allow, and larger trades will ping for approval.
8. Only then ask the user to connect exchange or market credentials.

## Example conversation flow

**User:** I want to start trading crypto, but I do not want the AI to do anything crazy.

**Agent:** Which exchange are you using, what is your total budget, and are you planning spot only or futures too?

**User:** Binance, $1,000, mostly spot. Maybe some futures later.

**Agent:** How much are you comfortable risking in a single trade, and what is the highest leverage you would ever allow?

**User:** Maybe $300 per trade. I do not really want leverage above 2x.

**Agent:** Got it. I will start from the conservative preset, keep approval gates on, cap leverage at 2x, and set your single-trade limit to $300.

**Agent commands:**

```bash
veto agent init --pack crypto-trading
veto agent policy-add "set max leverage to 2x"
veto agent policy-add "set max single trade to $300"
veto agent policy-add "set session budget to $1000"
veto agent policy-add "set auto-allow trade threshold to $50"
veto agent scan
veto agent policy-list
```

**Agent explanation to user:** Read-only market research stays frictionless. Tiny trades can pass automatically. Anything meaningful will ping your phone before money moves.
