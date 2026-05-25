import pytest

from veto import (
    MCPInputSchema,
    MCPTool,
    MCPToolCallArgs,
    ToolCallDeniedError,
    ToolDefinition,
    Veto,
    extract_mcp_economic_context,
    from_mcp,
    from_mcp_tool_call,
    is_mcp_tool,
    to_mcp,
    to_mcp_tools,
)
from veto.providers import get_adapter


def test_mcp_adapter_round_trips_tool_definition() -> None:
    tool = ToolDefinition(
        name="read_file",
        description="Read a file",
        input_schema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    )

    mcp_tool = to_mcp(tool)
    assert mcp_tool.name == "read_file"
    assert mcp_tool.input_schema.properties == {"path": {"type": "string"}}

    back = from_mcp(mcp_tool)
    assert back.name == tool.name
    assert back.description == tool.description
    assert back.input_schema["required"] == ["path"]


def test_mcp_adapter_accepts_canonical_camel_case_dict() -> None:
    tool = from_mcp(
        {
            "name": "search",
            "description": "Search",
            "inputSchema": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
            },
        }
    )

    assert tool.name == "search"
    assert tool.input_schema["properties"]["query"]["type"] == "string"


def test_mcp_tool_call_conversion_and_adapter_factory() -> None:
    call = from_mcp_tool_call(MCPToolCallArgs(name="read_file", arguments={"path": "/tmp/a"}))
    assert call.name == "read_file"
    assert call.arguments == {"path": "/tmp/a"}
    assert call.id.startswith("call_")

    adapter = get_adapter("mcp")
    assert adapter.to_provider_tools(
        [ToolDefinition(name="a", input_schema={"type": "object"})]
    )[0].name == "a"


def test_is_mcp_tool_rejects_openai_and_anthropic_shapes() -> None:
    assert is_mcp_tool(MCPTool(name="x", input_schema=MCPInputSchema(type="object")))
    assert is_mcp_tool({"name": "x", "inputSchema": {"type": "object"}})
    assert not is_mcp_tool({"type": "function", "function": {"name": "x"}})
    assert not is_mcp_tool({"name": "x", "input_schema": {"type": "object"}})
    assert not is_mcp_tool(None)


def test_to_mcp_tools_converts_multiple_tools() -> None:
    tools = [
        ToolDefinition(name="a", input_schema={"type": "object"}),
        ToolDefinition(name="b", input_schema={"type": "object"}),
    ]
    assert [tool.name for tool in to_mcp_tools(tools)] == ["a", "b"]


def test_extract_mcp_economic_context_matches_ts_convention() -> None:
    ctx = extract_mcp_economic_context(
        {
            "name": "search_api",
            "arguments": {
                "_meta": {
                    "economic_context": {
                        "cost": 0.01,
                        "currency": "USD",
                        "protocol": "mpp",
                        "payer": "cus_123",
                        "mandate_id": "mdt_1",
                    }
                }
            },
        }
    )

    assert ctx == {
        "cost": 0.01,
        "currency": "USD",
        "protocol": "mpp",
        "payer": "cus_123",
        "protocol_metadata": {"mandate_id": "mdt_1"},
    }
    assert extract_mcp_economic_context({"name": "x"}) is None
    assert (
        extract_mcp_economic_context(
            {"name": "x", "arguments": {"economic_context": {"cost": -1}}}
        )
        is None
    )


class _FakeMCPServer:
    def __init__(self) -> None:
        self.calls: list[MCPToolCallArgs] = []

    async def call_tool(self, args: MCPToolCallArgs) -> dict:
        self.calls.append(args)
        return {"content": [{"type": "text", "text": "ok"}]}


@pytest.mark.asyncio
async def test_wrap_mcp_tools_validates_before_forwarding() -> None:
    veto = Veto.from_rules(
        rules=[
            {
                "id": "block-secrets",
                "name": "Block secret path",
                "action": "block",
                "tools": ["read_file"],
                "conditions": [
                    {
                        "field": "arguments.path",
                        "operator": "starts_with",
                        "value": "/etc",
                    }
                ],
            }
        ],
        log_level="silent",
    )
    server = _FakeMCPServer()
    wrapped = veto.wrap_mcp_tools(
        [MCPTool(name="read_file", input_schema=MCPInputSchema(type="object"))],
        server,
    )

    allowed = await wrapped.call_tool(
        MCPToolCallArgs(name="read_file", arguments={"path": "/tmp/ok"})
    )
    assert allowed == {"content": [{"type": "text", "text": "ok"}]}
    assert server.calls[0].arguments == {"path": "/tmp/ok"}

    with pytest.raises(ToolCallDeniedError):
        await wrapped.call_tool(
            MCPToolCallArgs(name="read_file", arguments={"path": "/etc/passwd"})
        )
    assert len(server.calls) == 1
