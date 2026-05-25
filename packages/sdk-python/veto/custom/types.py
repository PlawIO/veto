"""Custom LLM provider validation types."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Literal, Mapping, Optional

from veto.kernel.types import KernelResponse, KernelToolCall

CustomProvider = Literal["gemini", "openrouter", "openai", "anthropic"]
CustomResponse = KernelResponse
CustomToolCall = KernelToolCall

PROVIDER_ENV_VARS: dict[str, str] = {
    "openai": "OPENAI_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
}

PROVIDER_BASE_URLS: dict[str, Optional[str]] = {
    "openai": "https://api.openai.com/v1",
    "anthropic": None,
    "gemini": None,
    "openrouter": "https://openrouter.ai/api/v1",
}


@dataclass
class CustomConfig:
    provider: CustomProvider
    model: str
    api_key: Optional[str] = None
    temperature: float = 0.1
    max_tokens: int = 500
    timeout: int = 30000
    base_url: Optional[str] = None


class CustomError(Exception):
    pass


class CustomConfigError(CustomError):
    pass


class CustomParseError(CustomError):
    def __init__(self, message: str, raw_response: str):
        super().__init__(message)
        self.raw_response = raw_response


class CustomAPIKeyError(CustomConfigError):
    def __init__(self, provider: str, env_var: str, configured_env_var: bool = False):
        if configured_env_var:
            message = (
                f"API key env var {env_var} for custom provider {provider} is not set "
                f"or empty. Set {env_var} or configure custom.apiKey with a literal secret."
            )
        else:
            message = (
                f"Missing API key for custom provider {provider}. Set {env_var} "
                "environment variable or configure custom.apiKey."
            )
        super().__init__(message)
        self.provider = provider
        self.env_var = env_var


def _resolve_api_key(provider: str, configured: Optional[str]) -> str:
    if configured and configured.strip():
        trimmed = configured.strip()
        if trimmed.isupper() and all(ch.isalnum() or ch == "_" for ch in trimmed):
            resolved = os.environ.get(trimmed)
            if not resolved:
                raise CustomAPIKeyError(provider, trimmed, True)
            return resolved
        return trimmed

    env_var = PROVIDER_ENV_VARS[provider]
    resolved = os.environ.get(env_var)
    if not resolved:
        raise CustomAPIKeyError(provider, env_var)
    return resolved


def resolve_custom_config(config: Mapping[str, Any]) -> CustomConfig:
    provider = config.get("provider")
    if provider not in PROVIDER_ENV_VARS:
        if not provider:
            raise CustomConfigError(
                "Missing custom.provider for custom validation. Set custom.provider "
                "to one of: openai, anthropic, gemini, openrouter."
            )
        raise CustomConfigError(
            f'Unsupported custom.provider "{provider}". Supported providers: '
            "openai, anthropic, gemini, openrouter."
        )

    model = config.get("model")
    if not isinstance(model, str) or not model.strip():
        raise CustomConfigError(
            f"Missing custom.model for custom provider {provider}. "
            "Set custom.model in veto.config.yaml."
        )

    api_key_raw = config.get("apiKey", config.get("api_key"))
    return CustomConfig(
        provider=provider,
        model=model,
        api_key=_resolve_api_key(provider, api_key_raw if isinstance(api_key_raw, str) else None),
        temperature=float(config.get("temperature", 0.1)),
        max_tokens=int(config.get("maxTokens", config.get("max_tokens", 500))),
        timeout=int(config.get("timeout", 30000)),
        base_url=config.get("baseUrl", config.get("base_url", PROVIDER_BASE_URLS[provider])),
    )
