"""
Event webhook emission for Veto validation decisions.
"""

from __future__ import annotations

from dataclasses import dataclass
import asyncio
import json
import threading
from typing import Any, Literal, Optional, TypeGuard
import urllib.error
import urllib.request

from veto.types.config import ValidationDecision
from veto.utils.logger import Logger


WebhookEventType = Literal["deny", "require_approval", "budget_exceeded"]
WebhookFormat = Literal["slack", "pagerduty", "generic", "cef"]
WebhookSeverity = Literal["critical", "high", "medium", "low", "info"]


@dataclass(frozen=True)
class EventWebhookConfig:
    url: str
    on: list[WebhookEventType]
    min_severity: WebhookSeverity
    format: WebhookFormat


@dataclass(frozen=True)
class WebhookEvent:
    event_type: WebhookEventType
    tool_name: str
    arguments: dict[str, Any]
    decision: ValidationDecision
    reason: Optional[str]
    rule_id: Optional[str]
    severity: Optional[WebhookSeverity]
    timestamp: str
    shadow: Optional[bool] = None


_VALID_EVENT_TYPES: tuple[WebhookEventType, ...] = (
    "deny",
    "require_approval",
    "budget_exceeded",
)
_VALID_FORMATS: tuple[WebhookFormat, ...] = (
    "slack",
    "pagerduty",
    "generic",
    "cef",
)
_VALID_SEVERITIES: tuple[WebhookSeverity, ...] = (
    "critical",
    "high",
    "medium",
    "low",
    "info",
)
_SEVERITY_RANK: dict[WebhookSeverity, int] = {
    "info": 1,
    "low": 2,
    "medium": 3,
    "high": 4,
    "critical": 5,
}


def _read_yaml_key(config: dict[Any, Any], key: str) -> Any:
    value = config.get(key)
    # PyYAML treats "on" as a boolean key unless quoted.
    if value is None and key == "on" and True in config:
        return config.get(True)
    return value


def _is_valid_event_type(value: Any) -> TypeGuard[WebhookEventType]:
    return isinstance(value, str) and value in _VALID_EVENT_TYPES


def _is_valid_format(value: Any) -> TypeGuard[WebhookFormat]:
    return isinstance(value, str) and value in _VALID_FORMATS


def _is_valid_severity(value: Any) -> TypeGuard[WebhookSeverity]:
    return isinstance(value, str) and value in _VALID_SEVERITIES


def parse_event_webhook_config(
    config: Any,
    logger: Logger,
) -> Optional[EventWebhookConfig]:
    if not isinstance(config, dict):
        return None

    raw_url = _read_yaml_key(config, "url")
    if not isinstance(raw_url, str) or not raw_url.strip():
        logger.warn("events.webhook.url must be a non-empty string")
        return None

    on: list[WebhookEventType] = ["deny"]
    raw_on = _read_yaml_key(config, "on")
    if isinstance(raw_on, list):
        parsed = [event for event in raw_on if _is_valid_event_type(event)]
        if parsed:
            on = parsed
        else:
            logger.warn(
                "events.webhook.on contained no valid event types, defaulting to ['deny']"
            )
    elif raw_on is not None:
        logger.warn("events.webhook.on must be an array of event types")

    min_severity: WebhookSeverity = "info"
    raw_min_severity = _read_yaml_key(config, "min_severity")
    if raw_min_severity is not None:
        if _is_valid_severity(raw_min_severity):
            min_severity = raw_min_severity
        else:
            logger.warn(
                "events.webhook.min_severity is invalid, defaulting to 'info'"
            )

    webhook_format: WebhookFormat = "generic"
    raw_format = _read_yaml_key(config, "format")
    if raw_format is not None:
        if _is_valid_format(raw_format):
            webhook_format = raw_format
        else:
            logger.warn("events.webhook.format is invalid, defaulting to 'generic'")

    return EventWebhookConfig(
        url=raw_url.strip(),
        on=on,
        min_severity=min_severity,
        format=webhook_format,
    )


def format_generic_payload(event: WebhookEvent) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "event_type": event.event_type,
        "tool_name": event.tool_name,
        "arguments": event.arguments,
        "decision": event.decision,
        "reason": event.reason,
        "rule_id": event.rule_id,
        "severity": event.severity,
        "timestamp": event.timestamp,
    }
    if event.shadow is True:
        payload["shadow"] = True
    return payload


def format_slack_payload(event: WebhookEvent) -> dict[str, Any]:
    reason = event.reason or "No reason provided"
    return {
        "text": f"Veto {event.event_type}: {event.tool_name}",
        "blocks": [
            {
                "type": "header",
                "text": {
                    "type": "plain_text",
                    "text": f"Veto {event.event_type}",
                },
            },
            {
                "type": "section",
                "fields": [
                    {"type": "mrkdwn", "text": f"*Tool*\\n`{event.tool_name}`"},
                    {"type": "mrkdwn", "text": f"*Decision*\\n`{event.decision}`"},
                    {
                        "type": "mrkdwn",
                        "text": f"*Severity*\\n`{event.severity or 'unknown'}`",
                    },
                    {
                        "type": "mrkdwn",
                        "text": f"*Rule ID*\\n`{event.rule_id or 'n/a'}`",
                    },
                ],
            },
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": f"*Reason*\\n{reason}"},
            },
            {
                "type": "context",
                "elements": [{"type": "mrkdwn", "text": f"Timestamp: {event.timestamp}"}],
            },
        ],
    }


def _map_pagerduty_severity(
    severity: Optional[WebhookSeverity],
) -> Literal["critical", "error", "warning", "info"]:
    if severity == "critical":
        return "critical"
    if severity == "high":
        return "error"
    if severity == "medium":
        return "warning"
    return "info"


def format_pagerduty_payload(event: WebhookEvent) -> dict[str, Any]:
    generic = format_generic_payload(event)
    return {
        "event_action": "trigger",
        "dedup_key": f"veto-{event.event_type}-{event.rule_id or event.tool_name}",
        "payload": {
            "summary": f"[Veto] {event.event_type} on {event.tool_name}",
            "source": "veto-sdk-python",
            "severity": _map_pagerduty_severity(event.severity),
            "timestamp": event.timestamp,
            "custom_details": generic,
        },
    }


def _map_cef_severity(severity: Optional[WebhookSeverity]) -> int:
    if severity == "critical":
        return 10
    if severity == "high":
        return 8
    if severity == "medium":
        return 5
    if severity == "low":
        return 3
    return 1


def _escape_cef(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace("|", "\\|")
        .replace("=", "\\=")
        .replace("\r", "\\r")
        .replace("\n", "\\n")
    )


def format_cef_payload(event: WebhookEvent) -> str:
    signature_id = event.rule_id or event.event_type
    reason = event.reason or "No reason provided"
    extension_fields = " ".join(
        [
            f"eventType={_escape_cef(event.event_type)}",
            f"toolName={_escape_cef(event.tool_name)}",
            f"decision={_escape_cef(event.decision)}",
            f"reason={_escape_cef(reason)}",
            f"ruleId={_escape_cef(event.rule_id or '')}",
            f"severity={_escape_cef(event.severity or '')}",
            f"timestamp={_escape_cef(event.timestamp)}",
            f"arguments={_escape_cef(json.dumps(event.arguments))}",
            *(
                ["shadow=true"]
                if event.shadow is True
                else []
            ),
        ]
    )
    return "|".join(
        [
            "CEF:0",
            "Veto",
            "SDK",
            "1.0",
            _escape_cef(signature_id),
            _escape_cef(f"Veto {event.event_type}"),
            str(_map_cef_severity(event.severity)),
            extension_fields,
        ]
    )


class EventWebhookEmitter:
    def __init__(self, config: Optional[EventWebhookConfig], logger: Logger):
        self._config = config
        self._logger = logger

    def emit(self, event: WebhookEvent) -> None:
        if self._config is None:
            return
        if not self._should_emit(event):
            return

        payload = self._format_payload(event)
        if isinstance(payload, str):
            body = payload.encode("utf-8")
            content_type = "text/plain; charset=utf-8"
        else:
            body = json.dumps(payload, default=str).encode("utf-8")
            content_type = "application/json"

        self._logger.debug(
            "Dispatching webhook event",
            {
                "event_type": event.event_type,
                "tool_name": event.tool_name,
                "decision": event.decision,
                "format": self._config.format,
                "url": self._config.url,
            },
        )

        try:
            loop = asyncio.get_running_loop()
            loop.create_task(
                self._dispatch_async(self._config.url, body, content_type, event)
            )
        except RuntimeError:
            thread = threading.Thread(
                target=self._dispatch_sync,
                args=(self._config.url, body, content_type, event),
                daemon=True,
            )
            thread.start()

    def _should_emit(self, event: WebhookEvent) -> bool:
        if self._config is None:
            return False
        if event.event_type not in self._config.on:
            return False

        event_severity: WebhookSeverity = event.severity or "info"
        return _SEVERITY_RANK[event_severity] >= _SEVERITY_RANK[self._config.min_severity]

    def _format_payload(self, event: WebhookEvent) -> dict[str, Any] | str:
        if self._config is None:
            return format_generic_payload(event)
        if self._config.format == "slack":
            return format_slack_payload(event)
        if self._config.format == "pagerduty":
            return format_pagerduty_payload(event)
        if self._config.format == "cef":
            return format_cef_payload(event)
        return format_generic_payload(event)

    async def _dispatch_async(
        self,
        url: str,
        body: bytes,
        content_type: str,
        event: WebhookEvent,
    ) -> None:
        try:
            status = await self._send_async(url, body, content_type)
            if status >= 400:
                self._logger.warn(
                    "Webhook endpoint returned non-success status",
                    {
                        "status": status,
                        "event_type": event.event_type,
                        "tool_name": event.tool_name,
                    },
                )
        except Exception as exc:
            self._logger.warn(
                "Webhook event dispatch failed",
                {
                    "event_type": event.event_type,
                    "tool_name": event.tool_name,
                    "error": str(exc),
                },
            )

    def _dispatch_sync(
        self,
        url: str,
        body: bytes,
        content_type: str,
        event: WebhookEvent,
    ) -> None:
        try:
            status = self._send_sync(url, body, content_type)
            if status >= 400:
                self._logger.warn(
                    "Webhook endpoint returned non-success status",
                    {
                        "status": status,
                        "event_type": event.event_type,
                        "tool_name": event.tool_name,
                    },
                )
        except Exception as exc:
            self._logger.warn(
                "Webhook event dispatch failed",
                {
                    "event_type": event.event_type,
                    "tool_name": event.tool_name,
                    "error": str(exc),
                },
            )

    async def _send_async(
        self,
        url: str,
        body: bytes,
        content_type: str,
    ) -> int:
        import aiohttp

        timeout = aiohttp.ClientTimeout(total=5)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                url,
                data=body,
                headers={"Content-Type": content_type},
            ) as response:
                return int(response.status)

    def _send_sync(
        self,
        url: str,
        body: bytes,
        content_type: str,
    ) -> int:
        request = urllib.request.Request(
            url=url,
            data=body,
            headers={"Content-Type": content_type},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                status = response.getcode()
                return int(status) if isinstance(status, int) else 200
        except urllib.error.HTTPError as exc:
            code = exc.code
            return int(code) if isinstance(code, int) else 500
