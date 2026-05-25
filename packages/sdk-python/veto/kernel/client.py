"""Kernel client for local OpenAI-compatible model inference."""

from __future__ import annotations

import asyncio
import json
import urllib.request
from typing import Any, Mapping, Optional

from veto.kernel.prompt import build_prompt, build_system_prompt
from veto.kernel.types import (
    KernelConfig,
    KernelResponse,
    KernelToolCall,
    parse_kernel_response,
    resolve_kernel_config,
)
from veto.utils.logger import Logger


class KernelClient:
    def __init__(
        self,
        *,
        config: KernelConfig | Mapping[str, Any],
        logger: Logger,
        openai_client: Optional[Any] = None,
    ) -> None:
        self._config = (
            config if isinstance(config, KernelConfig) else resolve_kernel_config(config)
        )
        self._logger = logger
        self._openai_client = openai_client

    async def evaluate(
        self,
        tool_call: KernelToolCall | Mapping[str, Any],
        rules: list[dict[str, Any]],
    ) -> KernelResponse:
        content = await self._complete(build_prompt(tool_call, rules))
        return parse_kernel_response(content)

    async def health_check(self) -> bool:
        try:
            await self.evaluate(KernelToolCall(tool="health_check", arguments={}), [])
            return True
        except Exception:
            return False

    async def healthCheck(self) -> bool:
        return await self.health_check()

    async def _complete(self, user_prompt: str) -> str:
        if self._openai_client is not None:
            response = self._openai_client.chat.completions.create(
                model=self._config.model,
                messages=[
                    {"role": "system", "content": build_system_prompt()},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=self._config.temperature,
                max_tokens=self._config.max_tokens,
            )
            if hasattr(response, "__await__"):
                response = await response
            return response["choices"][0]["message"]["content"]

        return await asyncio.to_thread(self._complete_http, user_prompt)

    def _complete_http(self, user_prompt: str) -> str:
        payload = json.dumps(
            {
                "model": self._config.model,
                "messages": [
                    {"role": "system", "content": build_system_prompt()},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": self._config.temperature,
                "max_tokens": self._config.max_tokens,
            }
        ).encode("utf-8")
        request = urllib.request.Request(
            f"{self._config.base_url}/chat/completions",
            data=payload,
            headers={"content-type": "application/json", "authorization": "Bearer ollama"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self._config.timeout / 1000) as response:
            parsed = json.loads(response.read().decode("utf-8"))
        return parsed["choices"][0]["message"]["content"]


def create_kernel_client(
    *,
    config: KernelConfig | Mapping[str, Any],
    logger: Logger,
    openai_client: Optional[Any] = None,
) -> KernelClient:
    return KernelClient(config=config, logger=logger, openai_client=openai_client)


createKernelClient = create_kernel_client

