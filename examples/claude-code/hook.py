#!/usr/bin/env python3
"""
Claude Code PreToolUse hook for Veto.

Reads the tool-call envelope from stdin (Claude Code hook protocol), POSTs it
to veto-guardd, and emits the JSON response Claude Code expects on stdout.

Mapping of Veto decisions → Claude Code permission decisions:

    decision=allow              → permissionDecision="allow"   (no prompt, run)
    decision=deny               → permissionDecision="deny"    (block + reason)
    decision=require_approval   → permissionDecision="ask"     (Claude Code's
                                                                permission prompt
                                                                surfaces to user)

Configured in .claude/settings.json (see settings.example.json beside this).
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

DAEMON_URL = os.environ.get("VETO_GUARDD_URL", "http://127.0.0.1:8765/guard")
TIMEOUT = float(os.environ.get("VETO_GUARDD_TIMEOUT", "5"))


def respond(decision: str, reason: str | None = None) -> None:
    """Emit the hook response Claude Code expects, then exit."""
    output: dict = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
        }
    }
    if reason:
        output["hookSpecificOutput"]["permissionDecisionReason"] = reason
    print(json.dumps(output))
    sys.exit(0)


def fail_open(message: str) -> None:
    """Daemon unavailable / hook error — log to stderr and let the call through."""
    print(f"[veto-hook] {message}", file=sys.stderr)
    sys.exit(0)


def format_reason(reason: str | None, rule_id: str | None) -> str | None:
    parts: list[str] = []
    if reason:
        parts.append(reason)
    if rule_id:
        parts.append(f"(policy:{rule_id})")
    return " ".join(parts) if parts else None


def main() -> None:
    try:
        envelope = json.load(sys.stdin)
    except Exception:
        # Malformed input shouldn't break Claude Code — fail open silently.
        sys.exit(0)

    payload = json.dumps({
        "tool_name": envelope.get("tool_name"),
        "tool_input": envelope.get("tool_input") or {},
    }).encode()

    try:
        req = urllib.request.Request(
            DAEMON_URL,
            data=payload,
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            result = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read(500).decode("utf-8", errors="replace").strip()
        except Exception:
            body = ""
        if body:
            body = " ".join(body.split())
        reason = f" {e.reason}" if e.reason else ""
        body_suffix = f": {body}" if body else ""
        fail_open(
            f"guard daemon at {DAEMON_URL} returned HTTP {e.code}{reason}{body_suffix}; "
            "allowing call."
        )
        return
    except (urllib.error.URLError, ConnectionRefusedError):
        fail_open(
            f"guard daemon unreachable at {DAEMON_URL}; allowing call. "
            "Start it with `python3 veto_guardd.py`."
        )
        return
    except Exception as e:
        fail_open(f"hook error: {e}")
        return

    decision = result.get("decision", "allow")
    reason = format_reason(result.get("reason"), result.get("rule_id"))

    if decision == "deny":
        respond("deny", reason or "Blocked by Veto policy")
    elif decision == "require_approval":
        respond("ask", reason or "Veto policy requires approval")
    else:
        respond("allow")


if __name__ == "__main__":
    main()
