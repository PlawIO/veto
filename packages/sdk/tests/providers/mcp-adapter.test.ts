import { describe, it, expect } from 'vitest';
import {
  toMCP,
  fromMCP,
  fromMCPToolCall,
  toMCPTools,
  isMCPTool,
  getAdapter,
} from '../../src/providers/adapters.js';
import type { ToolDefinition } from '../../src/types/tool.js';
import type { MCPTool } from '../../src/providers/types.js';

const sampleTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read the contents of a file',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read' },
    },
    required: ['path'],
  },
};

const sampleMCPTool: MCPTool = {
  name: 'read_file',
  description: 'Read the contents of a file',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to read' },
    },
    required: ['path'],
  },
};

describe('MCP Adapter', () => {
  describe('toMCP', () => {
    it('should convert Veto tool to MCP format', () => {
      const result = toMCP(sampleTool);

      expect(result).toEqual({
        name: 'read_file',
        description: 'Read the contents of a file',
        inputSchema: sampleTool.inputSchema,
      });
    });

    it('should handle tool without description', () => {
      const tool: ToolDefinition = {
        name: 'simple',
        inputSchema: { type: 'object' },
      };

      const result = toMCP(tool);

      expect(result.name).toBe('simple');
      expect(result.description).toBeUndefined();
    });
  });

  describe('fromMCP', () => {
    it('should convert MCP tool to Veto format', () => {
      const result = fromMCP(sampleMCPTool);

      expect(result.name).toBe('read_file');
      expect(result.description).toBe('Read the contents of a file');
      expect(result.inputSchema.type).toBe('object');
      expect(result.inputSchema.properties).toEqual({
        path: { type: 'string', description: 'File path to read' },
      });
      expect(result.inputSchema.required).toEqual(['path']);
    });

    it('should handle MCP tool without properties', () => {
      const mcpTool: MCPTool = {
        name: 'no_params',
        inputSchema: { type: 'object' },
      };

      const result = fromMCP(mcpTool);

      expect(result.name).toBe('no_params');
      expect(result.inputSchema.type).toBe('object');
      expect(result.inputSchema.properties).toBeUndefined();
    });

    it('should handle MCP tool without required fields', () => {
      const mcpTool: MCPTool = {
        name: 'optional_params',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
        },
      };

      const result = fromMCP(mcpTool);

      expect(result.inputSchema.required).toBeUndefined();
    });
  });

  describe('fromMCPToolCall', () => {
    it('should convert MCP tool call to Veto format', () => {
      const toolCall = {
        name: 'read_file',
        arguments: { path: '/etc/hosts' },
      };

      const result = fromMCPToolCall(toolCall);

      expect(result.name).toBe('read_file');
      expect(result.arguments).toEqual({ path: '/etc/hosts' });
      expect(result.id).toBeDefined();
      expect(result.id).toMatch(/^call_/);
    });

    it('should handle missing arguments', () => {
      const toolCall = { name: 'list_files' };

      const result = fromMCPToolCall(toolCall);

      expect(result.name).toBe('list_files');
      expect(result.arguments).toEqual({});
    });
  });

  describe('toMCPTools', () => {
    it('should convert multiple tools', () => {
      const tools: ToolDefinition[] = [
        sampleTool,
        { name: 'write_file', inputSchema: { type: 'object' } },
      ];

      const result = toMCPTools(tools);

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('read_file');
      expect(result[1].name).toBe('write_file');
    });
  });

  describe('isMCPTool', () => {
    it('should detect MCP tool format', () => {
      expect(isMCPTool(sampleMCPTool)).toBe(true);
    });

    it('should detect MCP tool without description', () => {
      expect(isMCPTool({
        name: 'test',
        inputSchema: { type: 'object' },
      })).toBe(true);
    });

    it('should reject null/undefined', () => {
      expect(isMCPTool(null)).toBe(false);
      expect(isMCPTool(undefined)).toBe(false);
    });

    it('should reject non-objects', () => {
      expect(isMCPTool('string')).toBe(false);
      expect(isMCPTool(42)).toBe(false);
    });

    it('should reject objects without name', () => {
      expect(isMCPTool({ inputSchema: { type: 'object' } })).toBe(false);
    });

    it('should reject objects without inputSchema', () => {
      expect(isMCPTool({ name: 'test' })).toBe(false);
    });

    it('should reject inputSchema without type: "object"', () => {
      expect(isMCPTool({
        name: 'test',
        inputSchema: { type: 'string' },
      })).toBe(false);
    });

    it('should reject OpenAI tool format', () => {
      const openAITool = {
        type: 'function',
        function: {
          name: 'test',
          parameters: { type: 'object' },
        },
      };
      expect(isMCPTool(openAITool)).toBe(false);
    });

    it('should reject Anthropic tool format', () => {
      const anthropicTool = {
        name: 'test',
        input_schema: { type: 'object' },
        inputSchema: { type: 'object' },
      };
      expect(isMCPTool(anthropicTool)).toBe(false);
    });
  });

  describe('getAdapter("mcp")', () => {
    it('should return MCP adapter', () => {
      const adapter = getAdapter('mcp');

      expect(adapter.toProviderTool).toBe(toMCP);
      expect(adapter.fromProviderTool).toBe(fromMCP);
      expect(adapter.fromProviderToolCall).toBe(fromMCPToolCall);
    });

    it('should round-trip tool definitions', () => {
      const adapter = getAdapter('mcp');
      const mcpTool = adapter.toProviderTool(sampleTool);
      const backToVeto = adapter.fromProviderTool(mcpTool);

      expect(backToVeto.name).toBe(sampleTool.name);
      expect(backToVeto.description).toBe(sampleTool.description);
      expect(backToVeto.inputSchema.type).toBe('object');
    });
  });
});
