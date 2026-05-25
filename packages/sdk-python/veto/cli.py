"""Small Python CLI wrapper.

The TypeScript SDK has a much larger interactive CLI. Python at least needs
the documented ``veto init`` command and schema validation entrypoints so the
published console script is not a dead import.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import yaml

from veto.rules import PolicySchemaError, validate_policy_ir

DEFAULT_CONFIG = """# Veto Configuration
# See README.md for documentation

version: "1.0"
mode: "strict"

validation:
  mode: "local"

logging:
  level: "info"

rules:
  directory: "./rules"
  recursive: true
"""

DEFAULT_RULES = """# Veto Default Rules
# Add your rules here. Create additional .yaml files for organization.

version: "1.0"
name: default-rules
description: Default security rules

rules:
  - id: block-system-paths
    name: Block system path access
    description: Prevent access to sensitive system directories
    enabled: true
    severity: critical
    action: block
    tools:
      - read_file
      - write_file
      - delete_file
    conditions:
      - field: arguments.path
        operator: starts_with
        value: /etc

  - id: block-rm-rf
    name: Block rm -rf
    description: Prevent recursive forced deletion
    enabled: true
    severity: critical
    action: block
    tools:
      - execute_command
      - run_shell
      - bash
    conditions:
      - field: arguments.command
        operator: contains
        value: "rm -rf"
"""

PACK_RULES_TEMPLATE = """# Veto Rules
# This file extends a built-in policy pack and lets you override specific rules.

version: "1.0"
name: custom-rules
description: Custom rules extending {pack}
extends: "{pack}"

rules:
  # Override a pack rule by reusing the same id:
  # - id: <pack-rule-id>
  #   name: My override
  #   action: block

  # Add project-specific rules:
  # - id: project-specific-rule
  #   name: Project specific rule
  #   action: block
"""


def _write_if_allowed(path: Path, content: str, *, force: bool) -> bool:
    if path.exists() and not force:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.rstrip() + "\n", encoding="utf-8")
    return True


def _cmd_init(args: argparse.Namespace) -> int:
    root = Path(args.directory).resolve()
    rules_dir = root / "rules"
    wrote_config = _write_if_allowed(root / "veto.config.yaml", DEFAULT_CONFIG, force=args.force)
    rules_content = (
        PACK_RULES_TEMPLATE.format(pack=args.pack)
        if args.pack
        else DEFAULT_RULES
    )
    wrote_rules = _write_if_allowed(
        rules_dir / "defaults.yaml",
        rules_content,
        force=args.force,
    )

    if wrote_config:
        print(f"created {root / 'veto.config.yaml'}")
    else:
        print(f"exists  {root / 'veto.config.yaml'}")
    if wrote_rules:
        print(f"created {rules_dir / 'defaults.yaml'}")
    else:
        print(f"exists  {rules_dir / 'defaults.yaml'}")
    return 0


def _cmd_validate(args: argparse.Namespace) -> int:
    path = Path(args.path)
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        validate_policy_ir(data)
    except PolicySchemaError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Failed to validate {path}: {exc}", file=sys.stderr)
        return 1

    print(f"valid {path}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="veto")
    subcommands = parser.add_subparsers(dest="command", required=True)

    init = subcommands.add_parser("init", help="create a local veto/ policy directory")
    init.add_argument(
        "--directory",
        "-d",
        default="veto",
        help="target Veto config directory (default: ./veto)",
    )
    init.add_argument("--pack", help='extend a built-in pack, e.g. "@veto/coding-agent"')
    init.add_argument("--force", action="store_true", help="overwrite existing files")
    init.set_defaults(func=_cmd_init)

    validate = subcommands.add_parser("validate-policy", help="validate a policy YAML file")
    validate.add_argument("path", help="path to a policy YAML file")
    validate.set_defaults(func=_cmd_validate)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())

