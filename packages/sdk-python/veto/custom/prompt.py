"""Prompt building for custom LLM providers."""

from __future__ import annotations

from typing import Any

from veto.kernel.prompt import build_prompt

SYSTEM_PROMPT = """You are a security guardrail for AI agent tool calls.

TASK: Evaluate whether the tool call violates any rules in the provided ruleset.

IMPORTANT: You MUST respond with ONLY a JSON object, no other text, no explanation, no markdown.

JSON FORMAT:
{"pass_weight": <float 0-1>, "block_weight": <float 0-1>, "decision": "<pass|block>", "reasoning": "<brief explanation>"}

RULES:
- If no rules are violated, set decision to "pass" with pass_weight >= 0.7
- If any rule is violated, set decision to "block" with block_weight >= 0.7"""


def build_user_prompt(tool_call: Any, rules: list[dict[str, Any]]) -> str:
    return build_prompt(tool_call, rules)


def build_provider_messages(provider: str, user_prompt: str) -> dict[str, Any]:
    if provider in ("openai", "openrouter"):
        return {
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ]
        }
    if provider == "anthropic":
        return {
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": user_prompt}],
        }
    if provider == "gemini":
        return {
            "contents": [
                {"role": "user", "parts": [{"text": f"{SYSTEM_PROMPT}\n\n{user_prompt}"}]}
            ]
        }
    raise ValueError(f"Unknown provider: {provider}")


buildUserPrompt = build_user_prompt
buildProviderMessages = build_provider_messages

