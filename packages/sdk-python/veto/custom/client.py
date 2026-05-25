"""Custom LLM provider client for validation."""

from __future__ import annotations

import asyncio
import json
import urllib.request
from typing import Any, Mapping

from veto.custom.prompt import build_provider_messages, build_user_prompt
from veto.custom.types import CustomConfig, CustomError, resolve_custom_config
from veto.kernel.types import KernelResponse as CustomResponse
from veto.kernel.types import KernelToolCall as CustomToolCall
from veto.kernel.types import parse_kernel_response
from veto.utils.logger import Logger


class CustomClient:
    def __init__(self, *, config: CustomConfig | Mapping[str, Any], logger: Logger) -> None:
        self._config = (
            config if isinstance(config, CustomConfig) else resolve_custom_config(config)
        )
        self._logger = logger

    async def evaluate(
        self,
        tool_call: CustomToolCall | Mapping[str, Any],
        rules: list[dict[str, Any]],
    ) -> CustomResponse:
        user_prompt = build_user_prompt(tool_call, rules)
        messages = build_provider_messages(self._config.provider, user_prompt)
        content = await asyncio.to_thread(self._call_provider, messages)
        return parse_kernel_response(content)

    async def health_check(self) -> bool:
        try:
            await self.evaluate(CustomToolCall(tool="health_check", arguments={}), [])
            return True
        except Exception:
            return False

    async def healthCheck(self) -> bool:
        return await self.health_check()

    def _call_provider(self, messages: dict[str, Any]) -> str:
        if self._config.provider in ("openai", "openrouter"):
            return self._call_chat_completions(messages["messages"])
        if self._config.provider == "anthropic":
            return self._call_anthropic(messages)
        if self._config.provider == "gemini":
            return self._call_gemini(messages)
        raise CustomError(f"Unsupported provider: {self._config.provider}")

    def _post_json(self, url: str, payload: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"content-type": "application/json", **headers},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self._config.timeout / 1000) as response:
            parsed = json.loads(response.read().decode("utf-8"))
        if not isinstance(parsed, dict):
            raise CustomError("Provider response was not a JSON object")
        return parsed

    def _call_chat_completions(self, messages: list[dict[str, str]]) -> str:
        base_url = (self._config.base_url or "https://api.openai.com/v1").rstrip("/")
        parsed = self._post_json(
            f"{base_url}/chat/completions",
            {
                "model": self._config.model,
                "messages": messages,
                "temperature": self._config.temperature,
                "max_tokens": self._config.max_tokens,
            },
            {"authorization": f"Bearer {self._config.api_key}"},
        )
        content = parsed["choices"][0]["message"]["content"]
        return content if isinstance(content, str) else str(content)

    def _call_anthropic(self, messages: dict[str, Any]) -> str:
        base_url = (self._config.base_url or "https://api.anthropic.com").rstrip("/")
        if not base_url.endswith("/v1"):
            base_url = f"{base_url}/v1"
        parsed = self._post_json(
            f"{base_url}/messages",
            {
                "model": self._config.model,
                "system": messages["system"],
                "messages": messages["messages"],
                "temperature": self._config.temperature,
                "max_tokens": self._config.max_tokens,
            },
            {
                "x-api-key": self._config.api_key or "",
                "anthropic-version": "2023-06-01",
            },
        )
        blocks = parsed.get("content")
        if isinstance(blocks, list):
            for block in blocks:
                if isinstance(block, dict) and isinstance(block.get("text"), str):
                    return str(block["text"])
        raise CustomError("Anthropic response did not contain text")

    def _call_gemini(self, messages: dict[str, Any]) -> str:
        url = (
            self._config.base_url
            or "https://generativelanguage.googleapis.com/v1beta"
        ).rstrip("/")
        parsed = self._post_json(
            f"{url}/models/{self._config.model}:generateContent?key={self._config.api_key}",
            {
                "contents": messages["contents"],
                "generationConfig": {
                    "temperature": self._config.temperature,
                    "maxOutputTokens": self._config.max_tokens,
                },
            },
            {},
        )
        candidates = parsed.get("candidates")
        if isinstance(candidates, list) and candidates:
            parts = candidates[0].get("content", {}).get("parts", [])
            if isinstance(parts, list) and parts and isinstance(parts[0].get("text"), str):
                return str(parts[0]["text"])
        raise CustomError("Gemini response did not contain text")


def create_custom_client(
    *,
    config: CustomConfig | Mapping[str, Any],
    logger: Logger,
) -> CustomClient:
    return CustomClient(config=config, logger=logger)


createCustomClient = create_custom_client
