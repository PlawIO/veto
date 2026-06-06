"""Python-native Veto CLI."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import platform
import shutil
import sys
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

from veto.cloud.client import VetoCloudClient, VetoCloudConfig
from veto.core.veto import Veto, VetoOptions
from veto.receipts import (
    append_receipt,
    build_decision_receipt,
    format_ndjson,
    iter_ndjson_lines,
    parse_ndjson,
    receipt_summary,
    verify_file,
    verify_receipt_chain,
)

DEFAULT_RECEIPTS_PATH = Path(".veto/receipts.ndjson")

DEFAULT_CONFIG: dict[str, Any] = {
    "version": "1.0",
    "mode": "strict",
    "validation": {"mode": "local"},
    "logging": {"level": "info"},
    "rules": {"directory": "./rules", "recursive": True},
}

DEFAULT_RULES: dict[str, Any] = {
    "version": "1.0",
    "name": "default-rules",
    "description": "Default local Veto rules",
    "rules": [
        {
            "id": "block-rm-rf",
            "name": "Block recursive forced deletion",
            "description": "Prevent destructive shell deletion",
            "enabled": True,
            "severity": "critical",
            "action": "block",
            "tools": ["execute_command", "run_shell", "bash"],
            "conditions": [
                {
                    "field": "arguments.command",
                    "operator": "contains",
                    "value": "rm -rf",
                }
            ],
        }
    ],
}

DEFAULT_MCP_CONFIG: dict[str, Any] = {
    "version": "1.0",
    "upstreams": [
        {
            "name": "default",
            "transport": "mcp-sse",
            "url": "http://localhost:3000/mcp",
        }
    ],
}


def _package_version() -> str:
    try:
        return version("veto")
    except PackageNotFoundError:
        return "0.0.0"


def _json_default(value: Any) -> Any:
    if hasattr(value, "as_dict"):
        return value.as_dict()
    if hasattr(value, "__dict__"):
        return value.__dict__
    return str(value)


def _ok(data: dict[str, Any], next_steps: list[str] | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"ok": True, "data": data}
    if next_steps:
        payload["next"] = next_steps
    return payload


def _error(
    code: str,
    message: str,
    *,
    details: dict[str, Any] | None = None,
    next_step: str | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "ok": False,
        "error": {"code": code, "message": message},
    }
    if details:
        payload["error"]["details"] = details
    if next_step:
        payload["next"] = [next_step]
    return payload


def _print(payload: dict[str, Any], *, json_output: bool) -> None:
    if json_output:
        print(json.dumps(payload, default=_json_default, sort_keys=True))
        return
    if payload.get("ok"):
        data = payload.get("data", {})
        for key, value in data.items():
            print(f"{key}: {value}")
    else:
        err = payload["error"]
        print(f"{err['code']}: {err['message']}", file=sys.stderr)


def _load_pyyaml() -> Any:
    try:
        import yaml
    except ModuleNotFoundError as exc:
        raise ModuleNotFoundError(
            "PyYAML is required for YAML CLI commands. Install it with "
            "`pip install 'veto[rules]'`."
        ) from exc

    return yaml


def _load_policy_validator() -> tuple[type[Exception], Any]:
    try:
        from veto.rules.schema_validator import PolicySchemaError, validate_policy_ir
    except ModuleNotFoundError as exc:
        raise ModuleNotFoundError(
            "jsonschema is required to validate policy files. Install it with "
            "`pip install 'veto[rules]'`."
        ) from exc

    return PolicySchemaError, validate_policy_ir


def _write_yaml(path: Path, data: dict[str, Any], *, force: bool) -> bool:
    if path.exists() and not force:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    yaml = _load_pyyaml()
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")
    return True


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _receipt_count(path: Path) -> int:
    if not path.exists():
        return 0
    with path.open("r", encoding="utf-8") as handle:
        return sum(1 for _ in iter_ndjson_lines(handle))


def _timestamp_suffix() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00",
        "Z",
    ).replace(":", "-")


def _infer_restore_target(backup: Path) -> Path | None:
    marker = ".veto-backup-"
    name = backup.name
    index = name.find(marker)
    if index < 0:
        return None
    return backup.with_name(name[:index])


def _load_mcp_client_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"mcpServers": {}}
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"Invalid MCP config at {path}: root must be an object")
    servers = data.get("mcpServers")
    if servers is None:
        data["mcpServers"] = {}
    elif not isinstance(servers, dict):
        raise ValueError(f"Invalid MCP config at {path}: mcpServers must be an object")
    return data


def _run_mcp_import(
    *,
    output: Path,
    config: Path,
    cloud: bool,
    dry_run: bool,
) -> dict[str, Any]:
    document = _load_mcp_client_config(output)
    servers = dict(document.get("mcpServers") or {})
    existing_servers = {key: value for key, value in servers.items() if key != "veto"}
    if cloud:
        servers["veto"] = {
            "url": "https://api.veto.so/v1/mcp/default",
            "transport": "sse",
        }
    else:
        servers["veto"] = {
            "command": "veto",
            "args": ["mcp", "start", "--config", str(config)],
        }
    document["mcpServers"] = servers

    backup_path: Path | None = None
    if not dry_run:
        output.parent.mkdir(parents=True, exist_ok=True)
        if output.exists():
            backup_path = output.with_name(f"{output.name}.veto-backup-{_timestamp_suffix()}")
            shutil.copy2(output, backup_path)
        _write_json(output, document)
        if not cloud:
            upstreams = []
            for name, server in existing_servers.items():
                if isinstance(server, dict):
                    upstreams.append({"name": name, **server})
            _write_yaml(
                config,
                {"version": "1.0", "upstreams": upstreams},
                force=True,
            )

    return {
        "path": str(output),
        "config": str(config),
        "cloud": cloud,
        "dryRun": dry_run,
        "backupPath": str(backup_path) if backup_path else None,
        "servers": sorted(servers.keys()),
    }


def _bounded_int(value: str | int | None, name: str, minimum: int, maximum: int) -> int | None:
    if value is None:
        return None
    raw = str(value).strip()
    if not raw.isdigit():
        raise ValueError(f"--{name} must be an integer between {minimum} and {maximum}")
    parsed = int(raw)
    if parsed < minimum or parsed > maximum:
        raise ValueError(f"--{name} must be an integer between {minimum} and {maximum}")
    return parsed


def _cmd_version(args: argparse.Namespace) -> int:
    payload = _ok(
        {
            "version": _package_version(),
            "runtime": "python",
            "python": platform.python_version(),
        }
    )
    if args.json:
        _print(payload, json_output=True)
    else:
        print(f"veto v{payload['data']['version']} (python {payload['data']['python']})")
    return 0


def _cmd_init(args: argparse.Namespace) -> int:
    try:
        workspace = Path(args.directory).resolve()
        veto_dir = workspace / "veto"
        config_path = veto_dir / "veto.config.yaml"
        rules_path = veto_dir / "rules" / "defaults.yaml"
        mcp_path = veto_dir / "mcp.config.yaml"
        receipt_path = workspace / DEFAULT_RECEIPTS_PATH

        if args.restore:
            payload = _error(
                "restore_requires_backup",
                "Use 'veto mcp restore --backup <path>' to restore an MCP client config.",
                next_step="veto mcp restore --backup <path>",
            )
            _print(payload, json_output=args.json)
            return 1

        created: list[str] = []
        if not args.dry_run:
            config = dict(DEFAULT_CONFIG)
            if args.mode in {"strict", "log", "shadow"}:
                config["mode"] = args.mode
                config["validation"] = {"mode": "local"}
            else:
                config["mode"] = "strict"
                config["validation"] = {"mode": args.mode}
            if args.pack:
                config["packs"] = [args.pack]
            if _write_yaml(config_path, config, force=args.force):
                created.append(str(config_path.relative_to(workspace)))
            rules = dict(DEFAULT_RULES)
            if args.pack:
                rules = {
                    "version": "1.0",
                    "name": "custom-rules",
                    "description": f"Rules extending {args.pack}",
                    "extends": args.pack,
                    "rules": [],
                }
            if _write_yaml(rules_path, rules, force=args.force):
                created.append(str(rules_path.relative_to(workspace)))
            if not args.no_mcp and _write_yaml(mcp_path, DEFAULT_MCP_CONFIG, force=args.force):
                created.append(str(mcp_path.relative_to(workspace)))

        import_result: dict[str, Any] | None = None
        if not args.no_mcp and args.agent != "none":
            candidates = [
                workspace / ".cursor" / "mcp.json",
                workspace / ".codex" / "mcp.json",
                workspace / ".claude" / "mcp.json",
                workspace / "mcp.json",
            ]
            detected = next((candidate for candidate in candidates if candidate.exists()), None)
            if detected is not None or args.agent in {"cursor", "codex", "claude-desktop", "generic"}:
                output = detected or workspace / "mcp.json"
                import_result = _run_mcp_import(
                    output=output,
                    config=mcp_path,
                    cloud=args.mode == "cloud",
                    dry_run=args.dry_run,
                )

        receipt_ok = False
        if not args.dry_run and not args.no_receipt_smoke:
            receipt = build_decision_receipt(
                tool_name="veto_init_smoke",
                arguments={"command": "rm -rf /tmp/veto-smoke"},
                decision="deny",
                reason="Veto init receipt smoke check",
                session_id="init",
                agent_id="veto-python-cli",
            )
            append_receipt(receipt_path, receipt)
            receipt_ok = bool(verify_file(receipt_path).get("ok"))

        payload = _ok(
            {
                "workspace": str(workspace),
                "created": created,
                "mcp": import_result,
                "receipt": receipt_ok,
                "receiptStore": str(receipt_path),
            },
            ["veto doctor", f"veto receipts verify {receipt_path}"],
        )
        _print(payload, json_output=args.json)
        return 0
    except ModuleNotFoundError as exc:
        _print(
            _error(
                "missing_optional_dependency",
                str(exc),
                next_step="pip install 'veto[rules]'",
            ),
            json_output=args.json,
        )
        return 1


def _cmd_doctor(args: argparse.Namespace) -> int:
    workspace = Path(args.directory).resolve()
    receipt_path = workspace / DEFAULT_RECEIPTS_PATH
    receipt_result = verify_file(receipt_path) if receipt_path.exists() else {"ok": True, "count": 0}
    payload = _ok(
        {
            "workspace": str(workspace),
            "config": (workspace / "veto" / "veto.config.yaml").exists(),
            "mcp": (workspace / "veto" / "mcp.config.yaml").exists(),
            "receiptStore": str(receipt_path),
            "receiptChain": receipt_result,
        }
    )
    _print(payload, json_output=args.json)
    return 0 if receipt_result.get("ok") else 1


def _cmd_validate_policy(args: argparse.Namespace) -> int:
    path = Path(args.path)
    try:
        yaml = _load_pyyaml()
        policy_error_type, validate_policy_ir = _load_policy_validator()
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        try:
            validate_policy_ir(data)
        except policy_error_type as exc:
            payload = _error("policy_invalid", str(exc))
            _print(payload, json_output=args.json)
            return 1
    except ModuleNotFoundError as exc:
        payload = _error(
            "missing_optional_dependency",
            str(exc),
            next_step="pip install 'veto[rules]'",
        )
        _print(payload, json_output=args.json)
        return 1
    except Exception as exc:
        payload = _error("policy_validate_failed", f"Failed to validate {path}: {exc}")
        _print(payload, json_output=args.json)
        return 1

    _print(_ok({"path": str(path)}), json_output=args.json)
    return 0


def _cmd_validate(args: argparse.Namespace) -> int:
    try:
        tool_name = args.tool_name or args.tool
        if not tool_name:
            raise ValueError("tool name is required")
        arguments = json.loads(args.arguments)
        if not isinstance(arguments, dict):
            raise ValueError("--arguments must decode to a JSON object")

        async def _run() -> Any:
            veto = await Veto.init(
                VetoOptions(
                    config_dir=args.config_dir,
                    validation_mode=args.validation_mode,
                    receipt_store=str(args.receipt_store),
                    log_level="silent",
                    api_key=args.api_key,
                    base_url=args.base_url,
                )
            )
            try:
                return await veto.validate(
                    tool_name,
                    arguments,
                    session_id=args.session_id,
                    agent_id=args.agent_id,
                )
            finally:
                await veto.close()

        outcome = asyncio.run(_run())
        _print(_ok(outcome.as_dict()), json_output=args.json)
        return 0
    except Exception as exc:
        _print(_error("validate_failed", str(exc)), json_output=args.json)
        return 1


def _cmd_receipts_verify(args: argparse.Namespace) -> int:
    path = Path(args.file)
    result = verify_file(path)
    if not result.get("ok"):
        _print(
            _error(
                "receipt_verify_failed",
                str(result.get("reason", "Receipt verification failed")),
                details=result,
            ),
            json_output=args.json,
        )
        return 1
    _print(
        _ok(
            {
                "path": str(path),
                "count": result.get("count", 0),
                "finalReceiptHash": result.get("finalReceiptHash"),
            }
        ),
        json_output=args.json,
    )
    return 0


def _cmd_receipts_export(args: argparse.Namespace) -> int:
    try:
        if args.cloud:
            limit = _bounded_int(args.limit, "limit", 1, 10_000)
            cursor = _bounded_int(args.cursor, "cursor", 0, 2**53 - 1)

            async def _run() -> str:
                client = VetoCloudClient(
                    VetoCloudConfig(
                        api_key=args.api_key,
                        base_url=args.base_url,
                    )
                )
                try:
                    return await client.export_receipts(
                        project_id=args.project_id,
                        start_date=args.start_date,
                        end_date=args.end_date,
                        cursor=cursor,
                        limit=limit,
                    )
                finally:
                    await client.close()

            raw = asyncio.run(_run())
            source = "cloud"
        else:
            input_path = Path(args.file)
            if not input_path.exists():
                raise FileNotFoundError(f"Receipt store not found: {input_path}")
            raw = input_path.read_text(encoding="utf-8")
            source = "local"

        receipts = parse_ndjson(raw)
        verified = verify_receipt_chain(receipts)
        if not verified.get("ok"):
            raise ValueError(str(verified.get("reason", "Receipt chain is broken")))
        ndjson = format_ndjson(receipts)
        if args.output:
            output_path = Path(args.output)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(ndjson, encoding="utf-8")
        elif not args.json:
            sys.stdout.write(ndjson)
        if args.json or args.output:
            _print(
                _ok(
                    {
                        "source": source,
                        "count": len(receipts),
                        "outputPath": str(args.output) if args.output else None,
                    }
                ),
                json_output=args.json,
            )
        return 0
    except Exception as exc:
        _print(_error("receipt_export_failed", str(exc)), json_output=args.json)
        return 1


def _cmd_receipts_show(args: argparse.Namespace) -> int:
    try:
        path = Path(args.file)
        if not path.exists():
            raise FileNotFoundError(f"Receipt store not found: {path}")
        for receipt in parse_ndjson(path.read_text(encoding="utf-8")):
            if receipt["receipt_id"] == args.receipt_id:
                _print(
                    _ok(
                        {
                            "file": str(path),
                            "receipt": receipt,
                            "summary": receipt_summary(receipt).as_dict(),
                        }
                    ),
                    json_output=args.json,
                )
                return 0
        raise LookupError(f"Receipt not found: {args.receipt_id}")
    except Exception as exc:
        _print(_error("receipt_not_found", str(exc)), json_output=args.json)
        return 1


def _cmd_mcp_import(args: argparse.Namespace) -> int:
    try:
        result = _run_mcp_import(
            output=Path(args.output).resolve(),
            config=Path(args.config).resolve(),
            cloud=args.cloud,
            dry_run=args.dry_run,
        )
        _print(_ok(result), json_output=args.json)
        return 0
    except Exception as exc:
        _print(_error("mcp_import_failed", str(exc)), json_output=args.json)
        return 1


def _cmd_import(args: argparse.Namespace) -> int:
    if args.kind != "mcp":
        _print(
            _error(
                "unsupported_import_kind",
                "Only 'veto import mcp' is supported.",
                next_step="veto import mcp --output mcp.json",
            ),
            json_output=args.json,
        )
        return 1
    return _cmd_mcp_import(args)


def _cmd_mcp_restore(args: argparse.Namespace) -> int:
    try:
        backup = Path(args.backup).resolve()
        if not backup.exists():
            raise FileNotFoundError(f"Backup not found: {backup}")
        target = Path(args.output).resolve() if args.output else _infer_restore_target(backup)
        if target is None:
            raise ValueError("Could not infer restore target. Provide --output <path>.")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(backup, target)
        _print(_ok({"restored": True, "path": str(target), "backupPath": str(backup)}), json_output=args.json)
        return 0
    except Exception as exc:
        _print(_error("restore_failed", str(exc)), json_output=args.json)
        return 1


def _cmd_runtime_missing(args: argparse.Namespace) -> int:
    payload = _error(
        "runtime_capability_missing",
        "This Python CLI command delegates to the Node CLI runtime.",
        next_step="npx --package veto-cli@latest veto mcp serve",
    )
    _print(payload, json_output=args.json)
    return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="veto")
    parser.add_argument("--version", action="store_true", help="show version")
    parser.add_argument("--json", action="store_true", help="emit JSON")
    subcommands = parser.add_subparsers(dest="command")

    version_cmd = subcommands.add_parser("version", help="show runtime version")
    version_cmd.add_argument("--json", action="store_true")
    version_cmd.set_defaults(func=_cmd_version)

    init = subcommands.add_parser("init", help="initialize local Veto config")
    init.add_argument("--directory", "-d", default=".", help="workspace directory")
    init.add_argument("--agent", default="auto", choices=["auto", "cursor", "codex", "claude-desktop", "generic", "none"])
    init.add_argument("--mode", default="local", choices=["local", "cloud", "strict", "log", "shadow"])
    init.add_argument("--pack")
    init.add_argument("--force", action="store_true")
    init.add_argument("--yes", action="store_true")
    init.add_argument("--dry-run", action="store_true")
    init.add_argument("--restore", action="store_true")
    init.add_argument("--no-mcp", action="store_true")
    init.add_argument("--no-receipt-smoke", action="store_true")
    init.add_argument("--json", action="store_true")
    init.set_defaults(func=_cmd_init)

    doctor = subcommands.add_parser("doctor", help="inspect local Veto setup")
    doctor.add_argument("--directory", "-d", default=".")
    doctor.add_argument("--json", action="store_true")
    doctor.set_defaults(func=_cmd_doctor)

    validate_policy = subcommands.add_parser("validate-policy", help="validate a policy YAML file")
    validate_policy.add_argument("path")
    validate_policy.add_argument("--json", action="store_true")
    validate_policy.set_defaults(func=_cmd_validate_policy)

    validate = subcommands.add_parser("validate", help="validate one tool call")
    validate.add_argument("tool", nargs="?")
    validate.add_argument("--tool-name")
    validate.add_argument("--arguments", "--args", default="{}")
    validate.add_argument("--config-dir", default="./veto")
    validate.add_argument("--validation-mode", default="local", choices=["cloud", "local", "kernel", "custom", "api"])
    validate.add_argument("--receipt-store", type=Path, default=DEFAULT_RECEIPTS_PATH)
    validate.add_argument("--session-id")
    validate.add_argument("--agent-id")
    validate.add_argument("--api-key", default=os.environ.get("VETO_API_KEY"))
    validate.add_argument("--base-url", default=os.environ.get("VETO_API_URL", "https://api.veto.so"))
    validate.add_argument("--json", action="store_true")
    validate.set_defaults(func=_cmd_validate)

    receipts = subcommands.add_parser("receipts", help="export, verify, and show receipts")
    receipt_sub = receipts.add_subparsers(dest="receipt_command", required=True)
    receipts_verify = receipt_sub.add_parser("verify")
    receipts_verify.add_argument("file", nargs="?", default=str(DEFAULT_RECEIPTS_PATH))
    receipts_verify.add_argument("--json", action="store_true")
    receipts_verify.set_defaults(func=_cmd_receipts_verify)
    receipts_export = receipt_sub.add_parser("export")
    receipts_export.add_argument("--file", default=str(DEFAULT_RECEIPTS_PATH))
    receipts_export.add_argument("--output")
    receipts_export.add_argument("--cloud", action="store_true")
    receipts_export.add_argument("--project-id")
    receipts_export.add_argument("--start-date")
    receipts_export.add_argument("--end-date")
    receipts_export.add_argument("--cursor")
    receipts_export.add_argument("--limit")
    receipts_export.add_argument("--api-key", default=os.environ.get("VETO_API_KEY"))
    receipts_export.add_argument("--base-url", default=os.environ.get("VETO_API_URL", "https://api.veto.so"))
    receipts_export.add_argument("--json", action="store_true")
    receipts_export.set_defaults(func=_cmd_receipts_export)
    receipts_show = receipt_sub.add_parser("show")
    receipts_show.add_argument("receipt_id")
    receipts_show.add_argument("--file", default=str(DEFAULT_RECEIPTS_PATH))
    receipts_show.add_argument("--json", action="store_true")
    receipts_show.set_defaults(func=_cmd_receipts_show)

    mcp = subcommands.add_parser("mcp", help="manage MCP protection")
    mcp_sub = mcp.add_subparsers(dest="mcp_command", required=True)
    mcp_import = mcp_sub.add_parser("import")
    mcp_import.add_argument("--output", default="mcp.json")
    mcp_import.add_argument("--config", default="veto/mcp.config.yaml")
    mcp_import.add_argument("--cloud", action="store_true")
    mcp_import.add_argument("--dry-run", action="store_true")
    mcp_import.add_argument("--json", action="store_true")
    mcp_import.set_defaults(func=_cmd_mcp_import)
    mcp_restore = mcp_sub.add_parser("restore")
    mcp_restore.add_argument("--backup", required=True)
    mcp_restore.add_argument("--output")
    mcp_restore.add_argument("--json", action="store_true")
    mcp_restore.set_defaults(func=_cmd_mcp_restore)
    for command_name in ("start", "serve"):
        runtime = mcp_sub.add_parser(command_name)
        runtime.add_argument("--config", default="veto/mcp.config.yaml")
        runtime.add_argument("--transport")
        runtime.add_argument("--json", action="store_true")
        runtime.set_defaults(func=_cmd_runtime_missing)

    import_cmd = subcommands.add_parser("import", help="compatibility import command")
    import_cmd.add_argument("kind", choices=["mcp"])
    import_cmd.add_argument("--output", default="mcp.json")
    import_cmd.add_argument("--config", default="veto/mcp.config.yaml")
    import_cmd.add_argument("--cloud", action="store_true")
    import_cmd.add_argument("--dry-run", action="store_true")
    import_cmd.add_argument("--json", action="store_true")
    import_cmd.set_defaults(func=_cmd_import)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if getattr(args, "version", False):
        return _cmd_version(args)
    if not hasattr(args, "func"):
        parser.print_help()
        return 1
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
