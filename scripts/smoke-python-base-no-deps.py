#!/usr/bin/env python3
"""Smoke-test the Python base wheel without runtime dependencies."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import venv
from pathlib import Path


if sys.version_info < (3, 10):
    for candidate_name in ("python3.12", "python3.11", "python3.10"):
        candidate = shutil.which(candidate_name)
        if candidate and Path(candidate).resolve() != Path(sys.executable).resolve():
            os.execv(candidate, [candidate, *sys.argv])
    raise SystemExit("smoke-python-base-no-deps.py requires Python 3.10 or newer")

ROOT = Path(__file__).resolve().parents[1]
SDK_DIR = ROOT / "packages" / "sdk-python"
DENIED_DISTRIBUTIONS = {
    "aiohttp",
    "jcs",
    "jsonschema",
    "pydantic",
    "pyyaml",
    "sse-starlette",
}


def run(args: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=str(cwd or ROOT),
        check=True,
        text=True,
    )


def venv_python(venv_dir: Path) -> Path:
    if sys.platform == "win32":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="veto-python-base-") as raw_tmp:
        tmp = Path(raw_tmp)
        wheelhouse = tmp / "wheelhouse"
        wheelhouse.mkdir()

        run(
            [
                sys.executable,
                "-m",
                "pip",
                "wheel",
                "--no-deps",
                "--wheel-dir",
                str(wheelhouse),
                str(SDK_DIR),
            ],
        )

        wheels = sorted(wheelhouse.glob("veto-*.whl"))
        if len(wheels) != 1:
            raise RuntimeError(f"expected one veto wheel, found {wheels}")

        env_dir = tmp / "venv"
        venv.EnvBuilder(with_pip=True).create(env_dir)
        python = venv_python(env_dir)

        run([str(python), "-m", "pip", "install", "--no-deps", str(wheels[0])])

        probe = textwrap.dedent(
            """
            import asyncio
            import json
            import subprocess
            import sys
            import tempfile
            from pathlib import Path

            import veto
            from veto import Veto, VetoOptions, hash_receipt, verify_receipt_chain
            from veto.receipts import parse_ndjson

            DENIED = {
                "aiohttp",
                "jcs",
                "jsonschema",
                "pydantic",
                "pyyaml",
                "sse-starlette",
            }

            installed = {
                package["name"].lower()
                for package in json.loads(
                    subprocess.check_output(
                        [sys.executable, "-m", "pip", "list", "--format=json"],
                        text=True,
                    )
                )
            }
            unexpected = sorted(installed & DENIED)
            assert unexpected == [], f"base install pulled optional deps: {unexpected}"

            async def main() -> None:
                receipt_store = Path(tempfile.mkdtemp()) / "receipts.ndjson"
                local = Veto.local(
                    bundle={
                        "rules": [
                            {
                                "id": "deny-large-wire",
                                "name": "Deny large wire transfer",
                                "enabled": True,
                                "severity": "critical",
                                "action": "block",
                                "tools": ["wire_transfer"],
                                "conditions": [
                                    {
                                        "field": "arguments.amount",
                                        "operator": "greater_than",
                                        "value": 1000,
                                    }
                                ],
                            }
                        ]
                    },
                    receipts=receipt_store,
                    log_level="silent",
                )

                denied = await local.validate("wire_transfer", {"amount": 2500})
                assert denied.decision == "deny"
                assert denied.receipt is not None

                allowed = await local.validate("wire_transfer", {"amount": 25})
                assert allowed.decision == "allow"
                assert allowed.receipt is not None

                receipts = parse_ndjson(receipt_store.read_text(encoding="utf-8"))
                assert len(receipts) == 2
                assert verify_receipt_chain(receipts)["ok"] is True
                assert hash_receipt(receipts[-1]).startswith("sha256:")
                assert isinstance(VetoOptions(log_level="silent"), VetoOptions)

                await local.close()

            asyncio.run(main())
            assert "Veto" in dir(veto)
            """
        )
        run([str(python), "-c", probe])


if __name__ == "__main__":
    main()
