/**
 * Provider-specific type definitions.
 *
 * This module defines the tool schema formats used by different AI providers,
 * allowing Veto to work transparently with each provider's format.
 *
 * @module providers/types
 */

import type { ToolInputSchema } from '../types/tool.js';

// ============================================================================
// OpenAI / Azure OpenAI Format
// ============================================================================

/**
 * OpenAI function definition format.
 *
 * @see https://platform.openai.com/docs/guides/function-calling
 */
export interface OpenAIFunctionDefinition {
  name: string;
  description?: string;
  parameters?: ToolInputSchema;
}

/**
 * OpenAI tool format (wraps function definition).
 */
export interface OpenAITool {
  type: 'function';
  function: OpenAIFunctionDefinition;
}

/**
 * OpenAI tool call from the API response.
 */
export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// ============================================================================
// Anthropic (Claude) Format
// ============================================================================

/**
 * Anthropic tool definition format.
 *
 * @see https://docs.anthropic.com/claude/docs/tool-use
 */
export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: ToolInputSchema;
}

/**
 * Anthropic tool use block from the API response.
 */
export interface AnthropicToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

// ============================================================================
// Google (Gemini) Format
// ============================================================================

/**
 * Google function declaration format.
 *
 * @see https://ai.google.dev/gemini-api/docs/function-calling
 */
export interface GoogleFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: ToolInputSchema;
}

/**
 * Google tool format (wraps function declarations).
 */
export interface GoogleTool {
  functionDeclarations: GoogleFunctionDeclaration[];
}

/**
 * Google function call from the API response.
 */
export interface GoogleFunctionCall {
  name: string;
  args: Record<string, unknown>;
}

// ============================================================================
// MCP (Model Context Protocol) Format
// ============================================================================

/**
 * MCP tool definition format.
 *
 * @see https://spec.modelcontextprotocol.io/specification/2025-03-26/server/tools/
 */
export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/**
 * MCP tool call arguments (passed to server.callTool).
 */
export interface MCPToolCallArgs {
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * MCP tool call result.
 */
export interface MCPToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

/**
 * MCP server client interface (subset needed for wrapping).
 */
export interface MCPServerClient {
  callTool(args: MCPToolCallArgs): Promise<MCPToolResult>;
}

// ============================================================================
// Provider Enum
// ============================================================================

/**
 * Supported AI providers.
 */
export type Provider = 'openai' | 'anthropic' | 'google' | 'mcp';

/**
 * Union type for all provider tool formats.
 */
export type ProviderTool = OpenAITool | AnthropicTool | GoogleTool | MCPTool;

/**
 * Union type for all provider tool call formats.
 */
export type ProviderToolCall = OpenAIToolCall | AnthropicToolUse | GoogleFunctionCall | MCPToolCallArgs;
