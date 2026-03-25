/**
 * Provider adapters for converting between Veto's format and provider formats.
 *
 * These adapters enable Veto to work transparently with different AI providers
 * while maintaining a consistent internal representation.
 *
 * @module providers/adapters
 */

import type { ToolDefinition, ToolCall } from '../types/tool.js';
import type { EconomicContext, EconomicProtocol } from '../economic/types.js';
import type {
  Provider,
  OpenAITool,
  OpenAIToolCall,
  AnthropicTool,
  AnthropicToolUse,
  GoogleTool,
  GoogleFunctionDeclaration,
  GoogleFunctionCall,
  MCPTool,
  MCPToolCallArgs,
} from './types.js';
import { generateToolCallId } from '../utils/id.js';

// ============================================================================
// OpenAI Adapter
// ============================================================================

/**
 * Convert Veto tool definition to OpenAI format.
 *
 * @param tool - Veto tool definition
 * @returns OpenAI tool format
 *
 * @example
 * ```typescript
 * const openAITool = toOpenAI({
 *   name: 'get_weather',
 *   description: 'Get current weather',
 *   inputSchema: { type: 'object', properties: { city: { type: 'string' } } }
 * });
 * ```
 */
export function toOpenAI(tool: ToolDefinition): OpenAITool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

/**
 * Convert OpenAI tool format to Veto definition.
 *
 * @param tool - OpenAI tool
 * @returns Veto tool definition
 */
export function fromOpenAI(tool: OpenAITool): ToolDefinition {
  return {
    name: tool.function.name,
    description: tool.function.description,
    inputSchema: tool.function.parameters ?? { type: 'object' },
  };
}

/**
 * Convert OpenAI tool call to Veto format.
 *
 * @param toolCall - OpenAI tool call from API response
 * @returns Veto tool call
 */
export function fromOpenAIToolCall(toolCall: OpenAIToolCall): ToolCall {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    args = {};
  }

  return {
    id: toolCall.id,
    name: toolCall.function.name,
    arguments: args,
    rawArguments: toolCall.function.arguments,
  };
}

/**
 * Convert multiple Veto tools to OpenAI format.
 *
 * @param tools - Veto tool definitions
 * @returns OpenAI tools array
 */
export function toOpenAITools(tools: readonly ToolDefinition[]): OpenAITool[] {
  return tools.map(toOpenAI);
}

// ============================================================================
// Anthropic Adapter
// ============================================================================

/**
 * Convert Veto tool definition to Anthropic format.
 *
 * @param tool - Veto tool definition
 * @returns Anthropic tool format
 *
 * @example
 * ```typescript
 * const anthropicTool = toAnthropic({
 *   name: 'get_weather',
 *   description: 'Get current weather',
 *   inputSchema: { type: 'object', properties: { city: { type: 'string' } } }
 * });
 * ```
 */
export function toAnthropic(tool: ToolDefinition): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

/**
 * Convert Anthropic tool format to Veto definition.
 *
 * @param tool - Anthropic tool
 * @returns Veto tool definition
 */
export function fromAnthropic(tool: AnthropicTool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema,
  };
}

/**
 * Convert Anthropic tool use to Veto format.
 *
 * @param toolUse - Anthropic tool use block from API response
 * @returns Veto tool call
 */
export function fromAnthropicToolUse(toolUse: AnthropicToolUse): ToolCall {
  return {
    id: toolUse.id,
    name: toolUse.name,
    arguments: toolUse.input,
  };
}

/**
 * Convert multiple Veto tools to Anthropic format.
 *
 * @param tools - Veto tool definitions
 * @returns Anthropic tools array
 */
export function toAnthropicTools(tools: readonly ToolDefinition[]): AnthropicTool[] {
  return tools.map(toAnthropic);
}

// ============================================================================
// Google (Gemini) Adapter
// ============================================================================

/**
 * Convert Veto tool definition to Google function declaration.
 *
 * @param tool - Veto tool definition
 * @returns Google function declaration
 */
export function toGoogleFunctionDeclaration(
  tool: ToolDefinition
): GoogleFunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  };
}

/**
 * Convert Veto tools to Google tool format.
 *
 * Google's format wraps all function declarations in a single tool object.
 *
 * @param tools - Veto tool definitions
 * @returns Google tool with function declarations
 *
 * @example
 * ```typescript
 * const googleTool = toGoogleTool([
 *   { name: 'get_weather', ... },
 *   { name: 'search', ... }
 * ]);
 * // { functionDeclarations: [...] }
 * ```
 */
export function toGoogleTool(tools: readonly ToolDefinition[]): GoogleTool {
  return {
    functionDeclarations: tools.map(toGoogleFunctionDeclaration),
  };
}

/**
 * Convert Google function declaration to Veto definition.
 *
 * @param func - Google function declaration
 * @returns Veto tool definition
 */
export function fromGoogleFunctionDeclaration(
  func: GoogleFunctionDeclaration
): ToolDefinition {
  return {
    name: func.name,
    description: func.description,
    inputSchema: func.parameters ?? { type: 'object' },
  };
}

/**
 * Convert Google tool to Veto definitions.
 *
 * @param tool - Google tool with function declarations
 * @returns Array of Veto tool definitions
 */
export function fromGoogleTool(tool: GoogleTool): ToolDefinition[] {
  return tool.functionDeclarations.map(fromGoogleFunctionDeclaration);
}

/**
 * Convert Google function call to Veto format.
 *
 * @param functionCall - Google function call from API response
 * @returns Veto tool call
 */
export function fromGoogleFunctionCall(functionCall: GoogleFunctionCall): ToolCall {
  return {
    id: generateToolCallId(),
    name: functionCall.name,
    arguments: functionCall.args,
  };
}

// ============================================================================
// MCP (Model Context Protocol) Adapter
// ============================================================================

/**
 * Convert Veto tool definition to MCP format.
 *
 * @param tool - Veto tool definition
 * @returns MCP tool format
 */
export function toMCP(tool: ToolDefinition): MCPTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.inputSchema.properties as Record<string, unknown> | undefined,
      required: tool.inputSchema.required ? [...tool.inputSchema.required] : undefined,
    },
  };
}

/**
 * Convert MCP tool format to Veto definition.
 *
 * @param tool - MCP tool
 * @returns Veto tool definition
 */
export function fromMCP(tool: MCPTool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: tool.inputSchema.properties as Record<string, import('../types/tool.js').JsonSchemaProperty> | undefined,
      required: tool.inputSchema.required,
    },
  };
}

/**
 * Convert MCP tool call arguments to Veto format.
 *
 * @param toolCall - MCP tool call arguments
 * @returns Veto tool call
 */
export function fromMCPToolCall(toolCall: MCPToolCallArgs): ToolCall {
  return {
    id: generateToolCallId(),
    name: toolCall.name,
    arguments: toolCall.arguments ?? {},
  };
}

/**
 * Convert multiple Veto tools to MCP format.
 *
 * @param tools - Veto tool definitions
 * @returns MCP tools array
 */
export function toMCPTools(tools: readonly ToolDefinition[]): MCPTool[] {
  return tools.map(toMCP);
}

/**
 * Detect whether a tool object matches the MCP tool shape.
 *
 * MCP tools have a top-level `inputSchema` with `type: "object"` and
 * no `input_schema` (Anthropic) or `function` (OpenAI) properties.
 */
export function isMCPTool(tool: unknown): tool is MCPTool {
  if (typeof tool !== 'object' || tool === null) return false;
  const t = tool as Record<string, unknown>;
  if (typeof t.name !== 'string') return false;
  if (typeof t.inputSchema !== 'object' || t.inputSchema === null) return false;
  const schema = t.inputSchema as Record<string, unknown>;
  if (schema.type !== 'object') return false;
  // Exclude Anthropic (has input_schema) and OpenAI (has function) shapes
  if ('input_schema' in t) return false;
  if ('function' in t) return false;
  if ('type' in t && t.type === 'function') return false;
  return true;
}

// ============================================================================
// MCP Economic Context Extraction
// ============================================================================

/**
 * Extract economic context from MCP tool call metadata.
 *
 * MCP servers can include economic metadata in tool call arguments or
 * _meta fields. This function looks for the `economic_context` convention:
 *
 * ```json
 * {
 *   "name": "search_api",
 *   "arguments": {
 *     "query": "...",
 *     "_meta": {
 *       "economic_context": {
 *         "cost": 0.01,
 *         "currency": "USD",
 *         "protocol": "mpp",
 *         "payer": "cus_stripe_123"
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * Returns null if no economic context is found.
 */
export function extractMCPEconomicContext(
  toolCall: MCPToolCallArgs
): EconomicContext | null {
  const args = toolCall.arguments;
  if (!args) return null;

  // Check _meta.economic_context (preferred convention)
  const meta = args._meta as Record<string, unknown> | undefined;
  if (meta?.economic_context && typeof meta.economic_context === 'object') {
    return parseMCPEconomicContext(meta.economic_context as Record<string, unknown>);
  }

  // Check top-level economic_context (alternative)
  if (args.economic_context && typeof args.economic_context === 'object') {
    return parseMCPEconomicContext(args.economic_context as Record<string, unknown>);
  }

  return null;
}

function parseMCPEconomicContext(
  data: Record<string, unknown>
): EconomicContext | null {
  const cost = typeof data.cost === 'number' ? data.cost : undefined;
  if (cost === undefined || !Number.isFinite(cost) || cost < 0) return null;

  const currency = typeof data.currency === 'string' ? data.currency : 'USD';
  const VALID_PROTOCOLS = new Set<string>(['x402', 'mpp', 'ap2', 'custom']);
  const protocol: EconomicProtocol = typeof data.protocol === 'string'
      && VALID_PROTOCOLS.has(data.protocol)
    ? data.protocol as EconomicProtocol
    : 'custom';
  const payer = typeof data.payer === 'string' ? data.payer : undefined;

  const { cost: _, currency: _c, protocol: _p, payer: _py, ...rest } = data;
  const protocol_metadata = Object.keys(rest).length > 0 ? rest : undefined;

  return { cost, currency, payer, protocol, protocol_metadata };
}

// ============================================================================
// Generic Adapter Factory
// ============================================================================

/**
 * Adapter interface for converting between formats.
 */
export interface ProviderAdapter<TTool, TToolCall> {
  /** Convert Veto tool to provider format */
  toProviderTool(tool: ToolDefinition): TTool;
  /** Convert provider tool to Veto format */
  fromProviderTool(tool: TTool): ToolDefinition;
  /** Convert provider tool call to Veto format */
  fromProviderToolCall(toolCall: TToolCall): ToolCall;
  /** Convert multiple Veto tools to provider format */
  toProviderTools(tools: readonly ToolDefinition[]): TTool[];
}

/**
 * OpenAI adapter instance.
 */
export const openAIAdapter: ProviderAdapter<OpenAITool, OpenAIToolCall> = {
  toProviderTool: toOpenAI,
  fromProviderTool: fromOpenAI,
  fromProviderToolCall: fromOpenAIToolCall,
  toProviderTools: toOpenAITools,
};

/**
 * Anthropic adapter instance.
 */
export const anthropicAdapter: ProviderAdapter<AnthropicTool, AnthropicToolUse> = {
  toProviderTool: toAnthropic,
  fromProviderTool: fromAnthropic,
  fromProviderToolCall: fromAnthropicToolUse,
  toProviderTools: toAnthropicTools,
};

/**
 * MCP adapter instance.
 */
export const mcpAdapter: ProviderAdapter<MCPTool, MCPToolCallArgs> = {
  toProviderTool: toMCP,
  fromProviderTool: fromMCP,
  fromProviderToolCall: fromMCPToolCall,
  toProviderTools: toMCPTools,
};

/**
 * Get an adapter for a specific provider.
 *
 * @param provider - Provider name
 * @returns Provider adapter
 * @throws Error if provider is not supported
 *
 * @example
 * ```typescript
 * const adapter = getAdapter('openai');
 * const providerTools = adapter.toProviderTools(vetoTools);
 * ```
 */
export function getAdapter(
  provider: 'openai'
): ProviderAdapter<OpenAITool, OpenAIToolCall>;
export function getAdapter(
  provider: 'anthropic'
): ProviderAdapter<AnthropicTool, AnthropicToolUse>;
export function getAdapter(
  provider: 'mcp'
): ProviderAdapter<MCPTool, MCPToolCallArgs>;
export function getAdapter(
  provider: Provider
): ProviderAdapter<unknown, unknown> {
  switch (provider) {
    case 'openai':
      return openAIAdapter;
    case 'anthropic':
      return anthropicAdapter;
    case 'mcp':
      return mcpAdapter;
    case 'google':
      throw new Error(
        'Google adapter not available via getAdapter(). Use toGoogleTool() and fromGoogleFunctionCall() directly.'
      );
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
