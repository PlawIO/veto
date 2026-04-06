"""Tests for the audit chain hash computation."""


from veto.audit.chain import compute_chain_hash, sorted_stringify, GENESIS_HASH


class TestSortedStringify:
    def test_primitives(self):
        assert sorted_stringify(None) == "null"
        assert sorted_stringify(True) == "true"
        assert sorted_stringify(False) == "false"
        assert sorted_stringify(42) == "42"
        assert sorted_stringify(3.14) == "3.14"
        assert sorted_stringify("hello") == '"hello"'

    def test_list(self):
        assert sorted_stringify([1, 2, 3]) == "[1,2,3]"
        assert sorted_stringify([]) == "[]"

    def test_dict_keys_sorted(self):
        result = sorted_stringify({"b": 2, "a": 1})
        assert result == '{"a":1,"b":2}'

    def test_nested_objects(self):
        obj = {"z": [3, 2, 1], "a": {"y": "val", "x": True}}
        result = sorted_stringify(obj)
        assert result == '{"a":{"x":true,"y":"val"},"z":[3,2,1]}'

    def test_circular_reference(self):
        a: dict = {"key": "value"}
        a["self"] = a
        result = sorted_stringify(a)
        assert '"[Circular]"' in result


class TestComputeChainHash:
    def test_deterministic(self):
        record = {"tool": "read_file", "decision": "allow"}
        h1 = compute_chain_hash(GENESIS_HASH, record)
        h2 = compute_chain_hash(GENESIS_HASH, record)
        assert h1 == h2

    def test_different_records_produce_different_hashes(self):
        r1 = {"tool": "read_file", "decision": "allow"}
        r2 = {"tool": "write_file", "decision": "deny"}
        h1 = compute_chain_hash(GENESIS_HASH, r1)
        h2 = compute_chain_hash(GENESIS_HASH, r2)
        assert h1 != h2

    def test_chain_integrity(self):
        """Modifying a record in the middle breaks the chain."""
        records = [
            {"tool": "read_file", "decision": "allow"},
            {"tool": "write_file", "decision": "deny"},
            {"tool": "delete_file", "decision": "deny"},
        ]
        hashes = [GENESIS_HASH]
        for r in records:
            hashes.append(compute_chain_hash(hashes[-1], r))

        # Tamper with the second record
        tampered = records.copy()
        tampered[1] = {"tool": "write_file", "decision": "allow"}
        tampered_hashes = [GENESIS_HASH]
        for r in tampered:
            tampered_hashes.append(compute_chain_hash(tampered_hashes[-1], r))

        # First hash matches (same record), second diverges
        assert hashes[1] == tampered_hashes[1]
        assert hashes[2] != tampered_hashes[2]
        assert hashes[3] != tampered_hashes[3]

    def test_key_order_irrelevant(self):
        """Dict key insertion order should not affect the hash."""
        r1 = {"b": 2, "a": 1}
        r2 = {"a": 1, "b": 2}
        assert compute_chain_hash("", r1) == compute_chain_hash("", r2)

    def test_hash_is_hex_sha256(self):
        h = compute_chain_hash(GENESIS_HASH, {"x": 1})
        assert len(h) == 64
        assert all(c in "0123456789abcdef" for c in h)
