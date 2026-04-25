#!/usr/bin/env python3
"""
veto-guardd — long-running daemon that holds a Veto instance and answers
authorization questions over HTTP. The Claude Code PreToolUse hook is a
20-line client that POSTs each tool call here and gets back a decision.

Why a daemon: importing the veto package is ~250ms; hooks spawn a fresh
process per tool call, so the naive path adds noticeable lag. With the
daemon, the hook's overhead drops to ~5ms.

Run:
    VETO_LOG=stream python3 veto_guardd.py [--rules rules.yaml] [--port 8765]

Then start Claude Code with the hook configured (see settings.example.json).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

import yaml

from veto import Veto


def load_rules(path: str) -> list[dict[str, Any]]:
    """Load the `rules:` list from a Veto-style YAML file."""
    with open(path, "r") as f:
        data = yaml.safe_load(f) or {}
    rules = data.get("rules") or []
    if not isinstance(rules, list):
        raise SystemExit(f"{path}: expected `rules` to be a list")
    return rules


class GuardHandler(BaseHTTPRequestHandler):
    veto: Optional[Veto] = None  # set by main()
    loop: Optional[asyncio.AbstractEventLoop] = None  # shared event loop

    def do_POST(self) -> None:  # noqa: N802 — stdlib API
        if self.path != "/guard":
            self._respond(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length > 0 else b"{}"
            body = json.loads(raw)
            tool_name = body.get("tool_name") or ""
            tool_input = body.get("tool_input") or {}

            assert self.veto is not None and self.loop is not None
            future = asyncio.run_coroutine_threadsafe(
                self.veto.guard(tool_name, tool_input),
                self.loop,
            )
            result = future.result(timeout=10.0)

            self._respond(200, {
                "decision": result.decision,
                "reason": result.reason,
                "rule_id": result.rule_id,
                "severity": result.severity,
            })
        except Exception as e:  # never crash the daemon on a bad request
            self._respond(500, {"error": str(e)})

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._respond(200, {"ok": True})
            return
        self._respond(404, {"error": "not found"})

    def log_message(self, *args: Any, **kwargs: Any) -> None:
        # Silence stdlib's per-request access logging — the stream logger
        # already prints every decision in our preferred format.
        pass

    def _respond(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def _start_event_loop() -> asyncio.AbstractEventLoop:
    """Spin up an asyncio loop on a background thread for guard() calls."""
    loop = asyncio.new_event_loop()
    t = threading.Thread(target=loop.run_forever, name="veto-guardd-loop", daemon=True)
    t.start()
    return loop


def main() -> None:
    parser = argparse.ArgumentParser(description="Veto guard daemon for Claude Code")
    parser.add_argument(
        "--rules",
        default=os.path.join(os.path.dirname(__file__), "rules.yaml"),
        help="path to rules.yaml (default: ./rules.yaml beside this script)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("VETO_GUARDD_PORT", "8765")),
        help="port to listen on (default: 8765, or $VETO_GUARDD_PORT)",
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="bind address (default: 127.0.0.1)",
    )
    args = parser.parse_args()

    # Default to stream logging unless the user has explicitly set something else.
    os.environ.setdefault("VETO_LOG", "stream")

    rules = load_rules(args.rules)
    print(
        f"[veto-guardd] loaded {len(rules)} rule{'s' if len(rules) != 1 else ''} "
        f"from {args.rules}",
        file=sys.stderr,
    )

    veto = Veto.from_rules(rules=rules)
    loop = _start_event_loop()

    GuardHandler.veto = veto
    GuardHandler.loop = loop

    server = ThreadingHTTPServer((args.host, args.port), GuardHandler)
    print(
        f"[veto-guardd] listening on http://{args.host}:{args.port} "
        f"(POST /guard, GET /healthz)",
        file=sys.stderr,
    )
    print("[veto-guardd] decisions stream below — Ctrl+C to stop\n", file=sys.stderr)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[veto-guardd] shutting down", file=sys.stderr)
        server.shutdown()


if __name__ == "__main__":
    main()
