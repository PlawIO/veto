"""
Type definitions for the Veto proxy server.
"""

from typing import Literal

from pydantic import ConfigDict
from pydantic.dataclasses import dataclass

ProxyFormat = Literal["openai", "anthropic", "auto"]
ResolvedProxyFormat = Literal["openai", "anthropic"]


@dataclass(config=ConfigDict(extra="forbid"), slots=True)
class ProxyConfig:
    port: int
    target: str
    max_buffer_bytes: int
    config_dir: str
    format: ProxyFormat = "auto"
