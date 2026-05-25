"""Shared connector parsing helpers."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Optional


def get_status(response: Any) -> Optional[int]:
    if isinstance(response, Mapping):
        status = response.get("status", response.get("status_code"))
    else:
        status = getattr(response, "status", getattr(response, "status_code", None))
    return int(status) if isinstance(status, int) else None


def get_header(response: Any, name: str) -> Optional[str]:
    headers = response.get("headers") if isinstance(response, Mapping) else getattr(response, "headers", None)
    if headers is None:
        return None

    lower_name = name.lower()
    if hasattr(headers, "get") and callable(headers.get):
        try:
            value = headers.get(name)
            if isinstance(value, str):
                return value
            value = headers.get(lower_name)
            if isinstance(value, str):
                return value
        except Exception:
            pass

    if isinstance(headers, Mapping):
        for key, value in headers.items():
            if isinstance(key, str) and key.lower() == lower_name and isinstance(value, str):
                return value

    return None

