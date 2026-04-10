"""Type definitions for the Veto Python intercept proxy."""

from dataclasses import dataclass
from typing import Literal


@dataclass
class ProxyConfig:
    port: int = 8080
    target: str = "https://api.openai.com"
    max_buffer_bytes: int = 1024 * 1024
    config_dir: str = "./veto"
    format: Literal["openai", "anthropic", "auto"] = "auto"
