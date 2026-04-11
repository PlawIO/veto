"""
Type definitions for the Veto proxy server.
"""

from dataclasses import dataclass
from typing import Literal

ProxyFormat = Literal["openai", "anthropic", "auto"]
ResolvedProxyFormat = Literal["openai", "anthropic"]


@dataclass(slots=True)
class ProxyConfig:
    port: int
    target: str
    max_buffer_bytes: int
    config_dir: str
    format: ProxyFormat = "auto"
