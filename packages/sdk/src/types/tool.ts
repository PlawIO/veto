/**
 * Core type definitions for tool schemas used across different AI providers.
 *
 * These types provide a unified representation of tool definitions that can be
 * converted to/from provider-specific formats (OpenAI, Anthropic, Google, etc.).
 *
 * @module types/tool
 */

/**
 * JSON Schema type definitions for tool parameters.
 * These follow the JSON Schema specification used by most AI providers.
 */
export type JsonSchemaType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';

/**
 * Property definition within a JSON Schema object.
 */
export interface JsonSchemaProperty {
  /** The data type of this property */
  type?: JsonSchemaType | JsonSchemaType[];
  /** Human-readable description of this property */
  description?: string;
  /** Allowed values for enum types */
  enum?: readonly (string | number | boolean | null)[];
  /** Default value if not provided */
  default?: unknown;
  /** For array types, the schema of array items */
  items?: JsonSchemaProperty;
  /** For object types, nested property definitions */
  properties?: Record<string, JsonSchemaProperty>;
  /** For object types, which properties are required */
  required?: readonly string[];
  /** Minimum value for numeric types */
  minimum?: number;
  /** Maximum value for numeric types */
  maximum?: number;
  /** Minimum length for string or array types */
  minLength?: number;
  /** Maximum length for string or array types */
  maxLength?: number;
  /** Regex pattern for string validation */
  pattern?: string;
  /** Composition: all schemas must match */
  allOf?: readonly JsonSchemaProperty[];
  /** Composition: any schema may match */
  anyOf?: readonly JsonSchemaProperty[];
  /** Composition: exactly one schema must match */
  oneOf?: readonly JsonSchemaProperty[];
  /** Additional properties allowed */
  additionalProperties?: boolean | JsonSchemaProperty;
}

/**
 * Complete JSON Schema definition for tool input parameters.
 */
export interface ToolInputSchema {
  /** Must be 'object' for tool parameters */
  type: 'object';
  /** Parameter definitions */
  properties?: Record<string, JsonSchemaProperty>;
  /** List of required parameter names */
  required?: readonly string[];
  /** Whether additional properties are allowed */
  additionalProperties?: boolean;
}

/**
 * Unified tool definition that works across providers.
 *
 * This is the canonical format used internally by Veto. Provider adapters
 * convert to/from this format.
 *
 * @example
 * ```typescript
 * const readFileTool: ToolDefinition = {
 *   name: 'read_file',
 *   description: 'Read the contents of a file at the specified path',
 *   inputSchema: {
 *     type: 'object',
 *     properties: {
 *       path: {
 *         type: 'string',
 *         description: 'The file path to read'
 *       }
 *     },
 *     required: ['path']
 *   }
 * };
 * ```
 */
export interface ToolDefinition {
  /** Unique identifier for the tool */
  name: string;
  /** Human-readable description of what the tool does */
  description?: string;
  /** JSON Schema defining the tool's input parameters */
  inputSchema: ToolInputSchema;
  /**
   * Optional metadata for internal use.
   * This is stripped before sending to providers.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Represents a tool call made by an AI agent.
 *
 * This captures the intent to invoke a specific tool with given arguments,
 * before the tool is actually executed.
 */
export interface ToolCall {
  /** Unique identifier for this specific tool call */
  id: string;
  /** Name of the tool being called */
  name: string;
  /** Arguments passed to the tool, parsed from JSON */
  arguments: Record<string, unknown>;
  /** Invocation headers associated with the tool call, when available */
  headers?: unknown;
  /** Raw JSON string of arguments (for providers that need it) */
  rawArguments?: string;
}

/**
 * Result of executing a tool call.
 */
export interface ToolResult {
  /** The ID of the tool call this is responding to */
  toolCallId: string;
  /** The name of the tool that was called */
  toolName: string;
  /** The result content (string or structured data) */
  content: unknown;
  /** Whether the tool execution resulted in an error */
  isError?: boolean;
}

/**
 * Handler function type for tool execution.
 *
 * @param args - The validated arguments for the tool
 * @returns The result of the tool execution
 */
export type ToolHandler<TArgs = Record<string, unknown>, TResult = unknown> = (
  args: TArgs
) => TResult | Promise<TResult>;

/**
 * A tool definition paired with its execution handler.
 */
export interface ExecutableTool<
  TArgs = Record<string, unknown>,
  TResult = unknown,
> extends ToolDefinition {
  /** The function to execute when this tool is called */
  handler: ToolHandler<TArgs, TResult>;
}

/**
 * Type guard to check if a tool definition has an attached handler.
 */
export function isExecutableTool(
  tool: ToolDefinition
): tool is ExecutableTool {
  return 'handler' in tool && typeof (tool as ExecutableTool).handler === 'function';
}

/**
 * Extracts the names from an array of tool definitions.
 */
export function getToolNames(tools: readonly ToolDefinition[]): string[] {
  return tools.map((tool) => tool.name);
}

/**
 * Finds a tool by name in an array of tool definitions.
 */
export function findToolByName(
  tools: readonly ToolDefinition[],
  name: string
): ToolDefinition | undefined {
  return tools.find((tool) => tool.name === name);
}
