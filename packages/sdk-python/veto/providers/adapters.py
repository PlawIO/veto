"""
Provider adapters for converting between Veto's format and provider formats.

These adapters enable Veto to work transparently with different AI providers
while maintaining a consistent internal representation.
"""

from typing import Any, Callable, Generic, TypeVar, Union
from dataclasses import dataclass
import math
import json

from veto.types.tool import ToolDefinition, ToolCall
from veto.providers.types import (
    Provider,
    OpenAITool,
    OpenAIToolCall,
    OpenAIFunctionDefinition,
    AnthropicTool,
    AnthropicToolUse,
    GoogleTool,
    GoogleFunctionDeclaration,
    GoogleFunctionCall,
    MCPInputSchema,
    MCPTool,
    MCPToolCallArgs,
)
from veto.utils.id import generate_tool_call_id


# ============================================================================
# OpenAI Adapter
# ============================================================================


def to_openai(tool: ToolDefinition) -> OpenAITool:
    """
    Convert Veto tool definition to OpenAI format.

    Example:
        >>> openai_tool = to_openai(ToolDefinition(
        ...     name='get_weather',
        ...     description='Get current weather',
        ...     input_schema={'type': 'object', 'properties': {'city': {'type': 'string'}}}
        ... ))
    """
    return OpenAITool(
        type="function",
        function=OpenAIFunctionDefinition(
            name=tool.name,
            description=tool.description,
            parameters=tool.input_schema,
        ),
    )


def from_openai(tool: OpenAITool) -> ToolDefinition:
    """Convert OpenAI tool format to Veto definition."""
    return ToolDefinition(
        name=tool.function.name,
        description=tool.function.description,
        input_schema=tool.function.parameters or {"type": "object"},
    )


def from_openai_tool_call(tool_call: OpenAIToolCall) -> ToolCall:
    """Convert OpenAI tool call to Veto format."""
    try:
        args = json.loads(tool_call.function.arguments)
    except (json.JSONDecodeError, TypeError):
        args = {}

    return ToolCall(
        id=tool_call.id,
        name=tool_call.function.name,
        arguments=args,
        raw_arguments=tool_call.function.arguments,
    )


def to_openai_tools(tools: list[ToolDefinition]) -> list[OpenAITool]:
    """Convert multiple Veto tools to OpenAI format."""
    return [to_openai(tool) for tool in tools]


# ============================================================================
# Anthropic Adapter
# ============================================================================


def to_anthropic(tool: ToolDefinition) -> AnthropicTool:
    """
    Convert Veto tool definition to Anthropic format.

    Example:
        >>> anthropic_tool = to_anthropic(ToolDefinition(
        ...     name='get_weather',
        ...     description='Get current weather',
        ...     input_schema={'type': 'object', 'properties': {'city': {'type': 'string'}}}
        ... ))
    """
    return AnthropicTool(
        name=tool.name,
        description=tool.description,
        input_schema=tool.input_schema,
    )


def from_anthropic(tool: AnthropicTool) -> ToolDefinition:
    """Convert Anthropic tool format to Veto definition."""
    return ToolDefinition(
        name=tool.name,
        description=tool.description,
        input_schema=tool.input_schema,
    )


def from_anthropic_tool_use(tool_use: AnthropicToolUse) -> ToolCall:
    """Convert Anthropic tool use to Veto format."""
    return ToolCall(
        id=tool_use.id,
        name=tool_use.name,
        arguments=tool_use.input,
    )


def to_anthropic_tools(tools: list[ToolDefinition]) -> list[AnthropicTool]:
    """Convert multiple Veto tools to Anthropic format."""
    return [to_anthropic(tool) for tool in tools]


# ============================================================================
# Google (Gemini) Adapter
# ============================================================================


def to_google_function_declaration(
    tool: ToolDefinition,
) -> GoogleFunctionDeclaration:
    """Convert Veto tool definition to Google function declaration."""
    return GoogleFunctionDeclaration(
        name=tool.name,
        description=tool.description,
        parameters=tool.input_schema,
    )


def to_google_tool(tools: list[ToolDefinition]) -> GoogleTool:
    """
    Convert Veto tools to Google tool format.

    Google's format wraps all function declarations in a single tool object.

    Example:
        >>> google_tool = to_google_tool([
        ...     ToolDefinition(name='get_weather', ...),
        ...     ToolDefinition(name='search', ...)
        ... ])
        # {'function_declarations': [...]}
    """
    return GoogleTool(
        function_declarations=[
            to_google_function_declaration(tool) for tool in tools
        ]
    )


def from_google_function_declaration(
    func: GoogleFunctionDeclaration,
) -> ToolDefinition:
    """Convert Google function declaration to Veto definition."""
    return ToolDefinition(
        name=func.name,
        description=func.description,
        input_schema=func.parameters or {"type": "object"},
    )


def from_google_tool(tool: GoogleTool) -> list[ToolDefinition]:
    """Convert Google tool to Veto definitions."""
    return [
        from_google_function_declaration(func)
        for func in tool.function_declarations
    ]


def from_google_function_call(function_call: GoogleFunctionCall) -> ToolCall:
    """Convert Google function call to Veto format."""
    return ToolCall(
        id=generate_tool_call_id(),
        name=function_call.name,
        arguments=function_call.args,
    )


# ============================================================================
# MCP (Model Context Protocol) Adapter
# ============================================================================


def _get_attr_or_key(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def _schema_properties(schema: Any) -> dict[str, Any] | None:
    properties = _get_attr_or_key(schema, "properties")
    return properties if isinstance(properties, dict) else None


def _schema_required(schema: Any) -> list[str] | None:
    required = _get_attr_or_key(schema, "required")
    if isinstance(required, list):
        return [item for item in required if isinstance(item, str)]
    return None


def to_mcp(tool: ToolDefinition) -> MCPTool:
    """Convert Veto tool definition to MCP format."""
    return MCPTool(
        name=tool.name,
        description=tool.description,
        input_schema=MCPInputSchema(
            type="object",
            properties=tool.input_schema.get("properties"),
            required=tool.input_schema.get("required"),
        ),
    )


def from_mcp(tool: MCPTool | dict[str, Any]) -> ToolDefinition:
    """Convert MCP tool format to Veto definition."""
    input_schema = _get_attr_or_key(tool, "input_schema")
    if input_schema is None:
        # Accept canonical camelCase MCP dictionaries as well as Pythonic
        # dataclasses. This mirrors TS's `inputSchema` shape while keeping
        # Python attrs idiomatic.
        input_schema = _get_attr_or_key(tool, "inputSchema")

    return ToolDefinition(
        name=_get_attr_or_key(tool, "name"),
        description=_get_attr_or_key(tool, "description"),
        input_schema={
            "type": "object",
            **(
                {"properties": _schema_properties(input_schema)}
                if _schema_properties(input_schema) is not None
                else {}
            ),
            **(
                {"required": _schema_required(input_schema)}
                if _schema_required(input_schema) is not None
                else {}
            ),
        },
    )


def from_mcp_tool_call(tool_call: MCPToolCallArgs | dict[str, Any]) -> ToolCall:
    """Convert MCP tool call arguments to Veto format."""
    return ToolCall(
        id=generate_tool_call_id(),
        name=_get_attr_or_key(tool_call, "name"),
        arguments=_get_attr_or_key(tool_call, "arguments") or {},
    )


def to_mcp_tools(tools: list[ToolDefinition]) -> list[MCPTool]:
    """Convert multiple Veto tools to MCP format."""
    return [to_mcp(tool) for tool in tools]


def is_mcp_tool(tool: Any) -> bool:
    """Return True when an object matches the MCP tool shape."""
    if not isinstance(tool, (dict, MCPTool)):
        return False

    name = _get_attr_or_key(tool, "name")
    if not isinstance(name, str):
        return False

    input_schema = (
        _get_attr_or_key(tool, "input_schema")
        if isinstance(tool, MCPTool)
        else _get_attr_or_key(tool, "inputSchema")
    )
    if input_schema is None:
        return False

    schema_type = _get_attr_or_key(input_schema, "type")
    if schema_type != "object":
        return False

    # Exclude Anthropic and OpenAI tool shapes.
    if isinstance(tool, dict):
        if "input_schema" in tool:
            return False
        if "function" in tool:
            return False
        if tool.get("type") == "function":
            return False

    return True


VALID_ECONOMIC_PROTOCOLS = {"x402", "mpp", "ap2", "custom"}


def extract_mcp_economic_context(
    tool_call: MCPToolCallArgs | dict[str, Any],
) -> dict[str, Any] | None:
    """Extract economic context from MCP tool call metadata.

    Looks for ``arguments._meta.economic_context`` first, then
    ``arguments.economic_context``. Returns a normalized dict matching the
    TypeScript SDK's ``EconomicContext`` surface, or ``None`` if absent/invalid.
    """
    arguments = _get_attr_or_key(tool_call, "arguments")
    if not isinstance(arguments, dict):
        return None

    data: Any = None
    meta = arguments.get("_meta")
    if isinstance(meta, dict) and isinstance(meta.get("economic_context"), dict):
        data = meta["economic_context"]
    elif isinstance(arguments.get("economic_context"), dict):
        data = arguments["economic_context"]

    if not isinstance(data, dict):
        return None

    cost = data.get("cost")
    if not isinstance(cost, (int, float)) or isinstance(cost, bool):
        return None
    if not math.isfinite(float(cost)) or float(cost) < 0:
        return None

    currency = data.get("currency") if isinstance(data.get("currency"), str) else "USD"
    protocol = data.get("protocol") if isinstance(data.get("protocol"), str) else "custom"
    if protocol not in VALID_ECONOMIC_PROTOCOLS:
        protocol = "custom"

    context: dict[str, Any] = {
        "cost": float(cost),
        "currency": currency,
        "protocol": protocol,
    }
    payer = data.get("payer")
    if isinstance(payer, str):
        context["payer"] = payer

    metadata = {
        key: value
        for key, value in data.items()
        if key not in {"cost", "currency", "protocol", "payer"}
    }
    if metadata:
        context["protocol_metadata"] = metadata

    return context


# ============================================================================
# Generic Adapter Factory
# ============================================================================

TTool = TypeVar("TTool")
TToolCall = TypeVar("TToolCall")


@dataclass
class ProviderAdapter(Generic[TTool, TToolCall]):
    """Adapter interface for converting between formats."""

    to_provider_tool: Callable[[ToolDefinition], TTool]
    from_provider_tool: Callable[[TTool], ToolDefinition]
    from_provider_tool_call: Callable[[TToolCall], ToolCall]
    to_provider_tools: Callable[[list[ToolDefinition]], list[TTool]]


# OpenAI adapter instance
openai_adapter: ProviderAdapter[OpenAITool, OpenAIToolCall] = ProviderAdapter(
    to_provider_tool=to_openai,
    from_provider_tool=from_openai,
    from_provider_tool_call=from_openai_tool_call,
    to_provider_tools=to_openai_tools,
)

# Anthropic adapter instance
anthropic_adapter: ProviderAdapter[AnthropicTool, AnthropicToolUse] = (
    ProviderAdapter(
        to_provider_tool=to_anthropic,
        from_provider_tool=from_anthropic,
        from_provider_tool_call=from_anthropic_tool_use,
        to_provider_tools=to_anthropic_tools,
    )
)

mcp_adapter: ProviderAdapter[MCPTool, MCPToolCallArgs] = ProviderAdapter(
    to_provider_tool=to_mcp,
    from_provider_tool=from_mcp,
    from_provider_tool_call=from_mcp_tool_call,
    to_provider_tools=to_mcp_tools,
)


def get_adapter(
    provider: Provider,
) -> Union[
    ProviderAdapter[OpenAITool, OpenAIToolCall],
    ProviderAdapter[AnthropicTool, AnthropicToolUse],
    ProviderAdapter[MCPTool, MCPToolCallArgs],
]:
    """
    Get an adapter for a specific provider.

    Example:
        >>> adapter = get_adapter('openai')
        >>> provider_tools = adapter.to_provider_tools(veto_tools)
    """
    if provider == "openai":
        return openai_adapter
    elif provider == "anthropic":
        return anthropic_adapter
    elif provider == "mcp":
        return mcp_adapter
    elif provider == "google":
        raise ValueError(
            "Google adapter not available via get_adapter(). "
            "Use to_google_tool() and from_google_function_call() directly."
        )
    else:
        raise ValueError(f"Unknown provider: {provider}")
