from pathlib import Path

from veto.receipts import (
    build_decision_receipt,
    format_ndjson,
    hash_receipt,
    parse_ndjson,
    receipt_summary,
    verify_file,
    verify_receipt_chain,
)


def test_build_receipt_summary_and_hash() -> None:
    receipt = build_decision_receipt(
        tool_name="transfer_funds",
        arguments={"amount": 100},
        decision="allow",
        session_id="sess_1",
        agent_id="agent_1",
        timestamp="2026-01-01T00:00:00Z",
    )

    summary = receipt_summary(receipt)

    assert receipt["version"] == "veto.receipt/1"
    assert receipt["tool_name"] == "transfer_funds"
    assert receipt["argument_hash"].startswith("sha256:")
    assert summary.receipt_id == receipt["receipt_id"]
    assert summary.receipt_hash == hash_receipt(receipt)
    assert summary.previous_receipt_hash == receipt["previous_receipt_hash"]


def test_parse_format_and_verify_receipt_chain(tmp_path: Path) -> None:
    first = build_decision_receipt(
        tool_name="bash",
        arguments={"command": "pwd"},
        decision="allow",
        timestamp="2026-01-01T00:00:00Z",
    )
    second = build_decision_receipt(
        tool_name="bash",
        arguments={"command": "rm -rf /tmp/demo"},
        decision="deny",
        reason="blocked",
        previous_receipt=first,
        timestamp="2026-01-01T00:00:01Z",
    )

    ndjson = format_ndjson([first, second])
    parsed = parse_ndjson(ndjson)
    receipt_file = tmp_path / "receipts.ndjson"
    receipt_file.write_text(ndjson, encoding="utf-8")

    assert [receipt["receipt_id"] for receipt in parsed] == [
        first["receipt_id"],
        second["receipt_id"],
    ]
    assert verify_receipt_chain(parsed) == {"ok": True}
    assert verify_file(receipt_file)["ok"] is True


def test_verify_receipt_chain_detects_tampering() -> None:
    first = build_decision_receipt(
        tool_name="bash",
        arguments={"command": "pwd"},
        decision="allow",
        timestamp="2026-01-01T00:00:00Z",
    )
    second = build_decision_receipt(
        tool_name="bash",
        arguments={"command": "date"},
        decision="allow",
        previous_receipt=first,
        timestamp="2026-01-01T00:00:01Z",
    )
    tampered = {**second, "previous_receipt_hash": first["policy_hash"]}

    result = verify_receipt_chain([first, tampered])

    assert result["ok"] is False
    assert result["breakAt"] == 1
