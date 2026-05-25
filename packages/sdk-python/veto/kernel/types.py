"""Types and config helpers for local kernel validation."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Literal, Mapping, Optional


@dataclass
class KernelConfig:
    base_url: str = "http://localhost:11434/v1"
    model: str = ""
    temperature: float = 0.1
    max_tokens: int = 256
    timeout: int = 30000


@dataclass
class KernelToolCall:
    tool: str
    arguments: dict[str, Any]


@dataclass
class KernelResponse:
    pass_weight: float
    block_weight: float
    decision: Literal["pass", "block"]
    reasoning: str
    matched_rules: Optional[list[str]] = None


class KernelError(Exception):
    pass


class KernelParseError(KernelError):
    def __init__(self, message: str, raw_response: str):
        super().__init__(message)
        self.raw_response = raw_response


def resolve_kernel_config(config: Mapping[str, Any]) -> KernelConfig:
    model = config.get("model")
    if not isinstance(model, str) or not model:
        raise KernelError("Kernel configuration not available")
    base_url = config.get("baseUrl", config.get("base_url", "http://localhost:11434/v1"))
    return KernelConfig(
        base_url=str(base_url).rstrip("/"),
        model=model,
        temperature=float(config.get("temperature", 0.1)),
        max_tokens=int(config.get("maxTokens", config.get("max_tokens", 256))),
        timeout=int(config.get("timeout", 30000)),
    )


def parse_kernel_response(content: str) -> KernelResponse:
    match = re.search(r"\{[\s\S]*\}", content)
    if match is None:
        raise KernelParseError("No JSON found in response", content)
    try:
        parsed = json.loads(match.group(0))
    except json.JSONDecodeError as exc:
        raise KernelParseError("Invalid JSON in response", content) from exc

    if not isinstance(parsed, dict):
        raise KernelParseError("Response is not an object", content)
    if not isinstance(parsed.get("pass_weight"), (int, float)):
        raise KernelParseError("Missing or invalid pass_weight", content)
    if not isinstance(parsed.get("block_weight"), (int, float)):
        raise KernelParseError("Missing or invalid block_weight", content)
    if parsed.get("decision") not in ("pass", "block"):
        raise KernelParseError("Missing or invalid decision", content)
    if not isinstance(parsed.get("reasoning"), str):
        raise KernelParseError("Missing or invalid reasoning", content)

    matched_rules = parsed.get("matched_rules")
    return KernelResponse(
        pass_weight=float(parsed["pass_weight"]),
        block_weight=float(parsed["block_weight"]),
        decision=parsed["decision"],
        reasoning=parsed["reasoning"],
        matched_rules=[item for item in matched_rules if isinstance(item, str)]
        if isinstance(matched_rules, list)
        else None,
    )

