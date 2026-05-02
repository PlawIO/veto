"""Top-level protect() API for one-step tool wrapping."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Literal, Optional, Protocol, TypeVar, Union, cast, overload, runtime_checkable

import yaml

from veto.core.veto import Veto, VetoOptions
from veto.types.config import LogLevel, StreamLogMode

ProtectMode = Literal["strict", "log", "shadow"]


@runtime_checkable
class ToolLike(Protocol):
    name: str


T = TypeVar("T", bound=ToolLike)


TOOL_PACK_HEURISTICS: list[dict[str, Any]] = [
    {
        "patterns": [
            "transfer",
            "payment",
            "balance",
            "withdraw",
            "deposit",
            "invoice",
            "refund",
            "charge",
            "payout",
            "wire",
            "bank",
            "fund",
            "money",
            "wallet",
        ],
        "pack": "@veto/financial",
    },
    {
        "patterns": [
            "navigate",
            "click",
            "goto",
            "browse",
            "scroll",
            "type_text",
            "fill_form",
            "screenshot",
            "open_url",
            "submit_form",
            "page",
            "tab",
            "browser",
        ],
        "pack": "@veto/browser-automation",
    },
    {
        "patterns": [
            "query",
            "sql",
            "database",
            "select",
            "insert",
            "table",
            "fetch_record",
            "read_record",
            "db",
            "collection",
            "document",
            "find",
            "aggregate",
        ],
        "pack": "@veto/data-access",
    },
    {
        "patterns": [
            "exec",
            "shell",
            "command",
            "terminal",
            "bash",
            "run_code",
            "write_file",
            "edit_file",
            "read_file",
            "delete_file",
            "mkdir",
            "code",
            "script",
        ],
        "pack": "@veto/coding-agent",
    },
    {
        "patterns": [
            "email",
            "send_email",
            "send_message",
            "notify",
            "sms",
            "slack",
            "message",
            "mail",
            "notification",
            "chat",
            "reply",
        ],
        "pack": "@veto/communication",
    },
    {
        "patterns": [
            "deploy",
            "publish",
            "release",
            "push",
            "rollback",
            "provision",
            "terraform",
            "kubernetes",
            "k8s",
            "docker",
            "helm",
            "ci_cd",
        ],
        "pack": "@veto/deployment",
    },
]


ProtectInitSource = Literal[
    "rules",
    "api_key",
    "endpoint",
    "config_dir",
    "local",
    "pack",
    "heuristic",
    "safe_defaults",
    "allow_all",
]


_default_instance: Optional[tuple[Veto, ProtectInitSource, Path]] = None
_instance_cache: dict[str, Veto] = {}


def _to_serializable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value

    if isinstance(value, dict):
        return {
            str(key): _to_serializable(item)
            for key, item in sorted(value.items(), key=lambda entry: str(entry[0]))
        }

    if isinstance(value, (list, tuple, set)):
        return [_to_serializable(item) for item in value]

    return repr(value)


def _stable_serialize(value: Any) -> str:
    return json.dumps(
        _to_serializable(value),
        sort_keys=True,
        separators=(",", ":"),
    )


def _to_tools_list(tools: Union[T, list[T]]) -> list[T]:
    if isinstance(tools, list):
        return tools
    return [tools]


def _collect_heuristic_packs(tools: list[T]) -> list[str]:
    packs: set[str] = set()

    for tool in tools:
        name = tool.name.lower()

        for heuristic in TOOL_PACK_HEURISTICS:
            patterns = heuristic["patterns"]
            if any(pattern in name for pattern in patterns):
                packs.add(str(heuristic["pack"]))

    return sorted(packs)


def _has_yaml_rule_file(path: Path) -> bool:
    if not path.exists():
        return False

    return any(
        child.is_file() and child.suffix.lower() in {".yaml", ".yml"}
        or child.is_dir() and _has_yaml_rule_file(child)
        for child in path.iterdir()
    )


def _has_local_policy_project() -> bool:
    veto_dir = Path.cwd() / "veto"
    return (veto_dir / "veto.config.yaml").exists() or _has_yaml_rule_file(veto_dir / "rules")


def _load_policy_pack(pack_name: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]], str]:
    normalized_pack = Veto._normalize_policy_pack_name(pack_name)
    pack_path = Veto._resolve_policy_pack_path(normalized_pack)

    with open(pack_path, "r", encoding="utf-8") as f:
        parsed = yaml.safe_load(f)

    if not isinstance(parsed, dict):
        raise ValueError(f'Policy pack "{normalized_pack}" is not a YAML object')

    rules_raw = parsed.get("rules")
    output_rules_raw = parsed.get("output_rules")

    rules = (
        [dict(rule) for rule in rules_raw if isinstance(rule, dict)]
        if isinstance(rules_raw, list)
        else []
    )

    output_rules = (
        [dict(rule) for rule in output_rules_raw if isinstance(rule, dict)]
        if isinstance(output_rules_raw, list)
        else []
    )

    return rules, output_rules, normalized_pack


def _load_inline_rules_from_packs(
    pack_names: list[str],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    all_rules: list[dict[str, Any]] = []
    all_output_rules: list[dict[str, Any]] = []
    normalized_packs: list[str] = []

    for pack_name in pack_names:
        rules, output_rules, normalized = _load_policy_pack(pack_name)
        all_rules.extend(rules)
        all_output_rules.extend(output_rules)
        normalized_packs.append(normalized)

    return all_rules, all_output_rules, sorted(set(normalized_packs))


def _build_init_decision(
    tools: list[T],
    options: dict[str, Any],
) -> tuple[ProtectInitSource, list[dict[str, Any]], list[dict[str, Any]], list[str]]:
    rules = options.get("rules")
    if isinstance(rules, list):
        inline_rules = [dict(rule) for rule in rules if isinstance(rule, dict)]
        return "rules", inline_rules, [], []

    if options.get("api_key"):
        return "api_key", [], [], []

    if options.get("endpoint"):
        return "endpoint", [], [], []

    if options.get("config_dir"):
        return "config_dir", [], [], []

    pack_name = options.get("pack")
    if isinstance(pack_name, str) and pack_name.strip() != "":
        rules_from_pack, output_rules_from_pack, normalized_packs = _load_inline_rules_from_packs([pack_name])
        return "pack", rules_from_pack, output_rules_from_pack, normalized_packs

    if _has_local_policy_project():
        return "local", [], [], []

    heuristic_packs = _collect_heuristic_packs(tools)
    if heuristic_packs:
        rules_from_pack, output_rules_from_pack, normalized_packs = _load_inline_rules_from_packs(heuristic_packs)
        return "heuristic", rules_from_pack, output_rules_from_pack, normalized_packs

    rules_from_pack, output_rules_from_pack, normalized_packs = _load_inline_rules_from_packs(["@veto/safe-defaults"])
    return "safe_defaults", rules_from_pack, output_rules_from_pack, normalized_packs


def _resolve_protect_mode(options: dict[str, Any], source: ProtectInitSource) -> Optional[ProtectMode]:
    raw_mode = options.get("mode")
    if raw_mode in ("strict", "log", "shadow"):
        return cast(ProtectMode, raw_mode)

    if source == "safe_defaults":
        return "log"

    return None


def _resolve_protect_log_level(options: dict[str, Any]) -> Optional[LogLevel]:
    if options.get("stream"):
        return "stream"

    raw_log_level = options.get("log_level")
    if isinstance(raw_log_level, str) and raw_log_level in {
        "debug",
        "info",
        "stream",
        "warn",
        "error",
        "silent",
    }:
        return cast(LogLevel, raw_log_level)

    # Fall back to VETO_LOG env var (recognizes ``stream`` and ``stream:verbose``).
    import os
    from veto.utils.logger import parse_env_log_setting

    env_setting = parse_env_log_setting(os.environ.get("VETO_LOG"))
    if env_setting is not None:
        return env_setting.level

    return None


def _resolve_protect_stream_mode(options: dict[str, Any]) -> Optional[StreamLogMode]:
    """Pull ``stream_mode`` from explicit options, then VETO_LOG env var."""
    explicit = options.get("stream_mode")
    if isinstance(explicit, str):
        if explicit in ("compact", "verbose"):
            return cast(StreamLogMode, explicit)
        return None
    if explicit is not None:
        return None

    import os
    from veto.utils.logger import parse_env_log_setting

    env_setting = parse_env_log_setting(os.environ.get("VETO_LOG"))
    if env_setting is not None and env_setting.stream_mode is not None:
        return env_setting.stream_mode
    return None


def _create_cache_key(
    options: dict[str, Any],
    source: ProtectInitSource,
    rules: list[dict[str, Any]],
    output_rules: list[dict[str, Any]],
    packs: list[str],
) -> str:
    payload = {
        "source": source,
        "config_dir": options.get("config_dir"),
        "pack": options.get("pack"),
        "api_key": options.get("api_key"),
        "endpoint": options.get("endpoint"),
        "mode": _resolve_protect_mode(options, source),
        "log_level": _resolve_protect_log_level(options),
        "stream": options.get("stream"),
        "stream_mode": _resolve_protect_stream_mode(options),
        "session_id": options.get("session_id"),
        "agent_id": options.get("agent_id"),
        "user_id": options.get("user_id"),
        "role": options.get("role"),
        "packs": packs,
        "rules_fingerprint": _stable_serialize(rules),
        "output_rules_fingerprint": _stable_serialize(output_rules),
        "budget": options.get("budget"),
        "costs": options.get("costs"),
    }
    return _stable_serialize(payload)


def _create_allow_all_instance(options: dict[str, Any]) -> Veto:
    return Veto.from_rules(
        rules=[],
        output_rules=[],
        mode=options.get("mode"),
        log_level=_resolve_protect_log_level(options),
        stream_mode=_resolve_protect_stream_mode(options),
        session_id=options.get("session_id"),
        agent_id=options.get("agent_id"),
        user_id=options.get("user_id"),
        role=options.get("role"),
        api_key=options.get("api_key"),
        endpoint=options.get("endpoint"),
        on_approval_required=options.get("on_approval_required"),
    )


def _should_emit_auto_apply_message(log_level: Optional[str]) -> bool:
    return log_level != "silent"


def _emit_auto_applied_pack_message(
    tools: list[T],
    source: ProtectInitSource,
    rules: list[dict[str, Any]],
    packs: list[str],
    log_level: Optional[str],
) -> None:
    if not _should_emit_auto_apply_message(log_level):
        return

    if source != "heuristic" or not packs:
        return

    print(f"[veto] Auto-applied policy packs: {', '.join(packs)}", file=sys.stderr)
    print(
        f"[veto] {len(rules)} rules active for {len(tools)} tools. Run 'npx veto test' for details.",
        file=sys.stderr,
    )


async def _initialize_veto(
    tools: list[T],
    options: dict[str, Any],
) -> tuple[Veto, ProtectInitSource, list[dict[str, Any]], list[str], bool]:
    source, inline_rules, inline_output_rules, packs = _build_init_decision(tools, options)
    cache_key = _create_cache_key(
        options,
        source,
        inline_rules,
        inline_output_rules,
        packs,
    )

    cached = _instance_cache.get(cache_key)
    if cached is not None:
        return cached, source, inline_rules, packs, True

    try:
        if source in ("rules", "pack", "heuristic", "safe_defaults", "allow_all"):
            instance = Veto.from_rules(
                rules=inline_rules,
                output_rules=inline_output_rules,
                mode=_resolve_protect_mode(options, source),
                log_level=_resolve_protect_log_level(options),
                stream_mode=_resolve_protect_stream_mode(options),
                session_id=options.get("session_id"),
                agent_id=options.get("agent_id"),
                user_id=options.get("user_id"),
                role=options.get("role"),
                api_key=options.get("api_key"),
                endpoint=options.get("endpoint"),
                on_approval_required=options.get("on_approval_required"),
            )
        else:
            instance = await Veto.init(
                VetoOptions(
                    config_dir=options.get("config_dir"),
                    mode=options.get("mode"),
                    log_level=_resolve_protect_log_level(options),
                    stream_mode=_resolve_protect_stream_mode(options),
                    session_id=options.get("session_id"),
                    agent_id=options.get("agent_id"),
                    user_id=options.get("user_id"),
                    role=options.get("role"),
                    api_key=options.get("api_key"),
                    base_url=options.get("endpoint"),
                    on_approval_required=options.get("on_approval_required"),
                )
            )
    except Exception:
        instance = _create_allow_all_instance(options)

    _instance_cache[cache_key] = instance
    return instance, source, inline_rules, packs, False


@overload
async def protect(tools: list[T], **kwargs: Any) -> list[T]:
    ...


@overload
async def protect(tools: T, **kwargs: Any) -> T:
    ...


async def protect(tools: Union[T, list[T]], **kwargs: Any) -> Union[T, list[T]]:
    """Wrap tools with Veto in one call.

    Supported kwargs mirror TypeScript ProtectOptions. `budget` and `costs`
    are accepted for API parity and are currently no-op in Python.
    """

    global _default_instance

    if not kwargs and _default_instance is not None:
        default_instance, default_source, default_cwd = _default_instance
        if default_source == "local" and default_cwd == Path.cwd():
            if isinstance(tools, list):
                return default_instance.wrap(tools)
            return default_instance.wrap_tool(tools)

    normalized_options = dict(kwargs)

    tool_list = _to_tools_list(tools)
    instance, source, inline_rules, packs, from_cache = await _initialize_veto(tool_list, normalized_options)

    if not from_cache:
        _emit_auto_applied_pack_message(
            tools=tool_list,
            source=source,
            rules=inline_rules,
            packs=packs,
            log_level=_resolve_protect_log_level(normalized_options),
        )

    if not kwargs:
        _default_instance = (instance, source, Path.cwd())

    if isinstance(tools, list):
        return instance.wrap(tools)

    return instance.wrap_tool(tools)


def _reset_protect_cache_for_tests() -> None:
    global _default_instance
    _default_instance = None
    _instance_cache.clear()


__all__ = ["protect"]
