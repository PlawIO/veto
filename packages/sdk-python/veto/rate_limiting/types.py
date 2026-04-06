from dataclasses import dataclass
from typing import Literal


@dataclass
class RateLimitEntry:
    scope: Literal["agent", "user", "session", "global"]
    max_calls: int
    window_seconds: int
