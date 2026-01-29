import { testMcpServer } from '@/core/mcp/McpTester';
import type { ClaudianMcpServer } from '@/core/types';

// Mock the MCP SDK transports and client
jest.mock('@modelcontextprotocol/sdk/client', () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    getServerVersion: jest.fn().mockReturnValue({ name: 'test-server', version: '1.0.0' }),
    listTools: jest.fn().mockResolvedValue({
      tools: [
        { name: 'tool1', description: 'A test tool', inputSchema: { type: 'object' } },
        { name: 'tool2' },
      ],
    }),
    close: jest.fn(),
  })),
}));

jest.mock('@modelcontextprotocol/sdk/client/sse', () => ({
  SSEClientTransport: jest.fn(),
}));

jest.mock('@modelcontextprotocol/sdk/client/stdio', () => ({
  StdioClientTransport: jest.fn(),
}));

jest.mock('@modelcontextprotocol/sdk/client/streamableHttp', () => ({
  StreamableHTTPClientTransport: jest.fn(),
}));

jest.mock('@/utils/env', () => ({
  getEnhancedPath: jest.fn((p?: string) => p || '/usr/bin'),
}));

jest.mock('@/utils/mcp', () => ({
  parseCommand: jest.fn((cmd: string, args?: string[]) => {
    if (args && args.length > 0) return { cmd, args };
    const parts = cmd.split(' ');
    return { cmd: parts[0] || '', args: parts.slice(1) };
  }),
}));

describe('testMcpServer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('stdio server', () => {
    it('should connect and return tools for a valid stdio server', async () => {
      const server: ClaudianMcpServer = {
        name: 'test',
        config: { command: 'node server.js', args: ['--port', '3000'] },
        enabled: true,
        contextSaving: false,
      };

      const result = await testMcpServer(server);

      expect(result.success).toBe(true);
      expect(result.serverName).toBe('test-server');
      expect(result.serverVersion).toBe('1.0.0');
      expect(result.tools).toHaveLength(2);
      expect(result.tools[0].name).toBe('tool1');
      expect(result.tools[0].description).toBe('A test tool');
      expect(result.tools[1].name).toBe('tool2');
    });

    it('should return error for missing command', async () => {
      const { parseCommand } = jest.requireMock('@/utils/mcp');
      parseCommand.mockReturnValueOnce({ cmd: '', args: [] });

      const server: ClaudianMcpServer = {
        name: 'empty',
        config: { command: '' },
        enabled: true,
        contextSaving: false,
      };

      const result = await testMcpServer(server);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Missing command');
      expect(result.tools).toEqual([]);
    });
  });

  describe('sse server', () => {
    it('should connect to an SSE server', async () => {
      const server: ClaudianMcpServer = {
        name: 'sse-test',
        config: { type: 'sse' as const, url: 'https://example.com/sse' },
        enabled: true,
        contextSaving: false,
      };

      const result = await testMcpServer(server);

      expect(result.success).toBe(true);
      expect(result.tools).toHaveLength(2);
    });
  });

  describe('http server', () => {
    it('should connect to an HTTP server', async () => {
      const server: ClaudianMcpServer = {
        name: 'http-test',
        config: { type: 'http' as const, url: 'https://example.com/api' },
        enabled: true,
        contextSaving: false,
      };

      const result = await testMcpServer(server);

      expect(result.success).toBe(true);
    });

    it('should pass headers when configured', async () => {
      const server: ClaudianMcpServer = {
        name: 'http-auth',
        config: {
          type: 'http' as const,
          url: 'https://example.com/api',
          headers: { Authorization: 'Bearer token' },
        },
        enabled: true,
        contextSaving: false,
      };

      const result = await testMcpServer(server);

      expect(result.success).toBe(true);
    });
  });

  describe('error handling', () => {
    it('should return error when transport creation fails', async () => {
      const { SSEClientTransport } = jest.requireMock('@modelcontextprotocol/sdk/client/sse');
      SSEClientTransport.mockImplementationOnce(() => {
        throw new Error('Transport init failed');
      });

      const server: ClaudianMcpServer = {
        name: 'bad-sse',
        config: { type: 'sse' as const, url: 'https://example.com/sse' },
        enabled: true,
        contextSaving: false,
      };

      const result = await testMcpServer(server);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Transport init failed');
      expect(result.tools).toEqual([]);
    });

    it('should return generic error for non-Error transport failures', async () => {
      const { StreamableHTTPClientTransport } = jest.requireMock('@modelcontextprotocol/sdk/client/streamableHttp');
      StreamableHTTPClientTransport.mockImplementationOnce(() => {
        throw 'string error'; // eslint-disable-line no-throw-literal
      });

      const server: ClaudianMcpServer = {
        name: 'bad-http',
        config: { type: 'http' as const, url: 'https://example.com' },
        enabled: true,
        contextSaving: false,
      };

      const result = await testMcpServer(server);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid server configuration');
    });

    it('should return error when connection fails', async () => {
      const { Client } = jest.requireMock('@modelcontextprotocol/sdk/client');
      Client.mockImplementationOnce(() => ({
        connect: jest.fn().mockRejectedValue(new Error('Connection refused')),
        close: jest.fn(),
      }));

      const server: ClaudianMcpServer = {
        name: 'refused',
        config: { command: 'node server.js' },
        enabled: true,
        contextSaving: false,
      };

      const result = await testMcpServer(server);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection refused');
    });

    it('should return unknown error for non-Error connection failures', async () => {
      const { Client } = jest.requireMock('@modelcontextprotocol/sdk/client');
      Client.mockImplementationOnce(() => ({
        connect: jest.fn().mockRejectedValue(42),
        close: jest.fn(),
      }));

      const server: ClaudianMcpServer = {
        name: 'weird-error',
        config: { command: 'node server.js' },
        enabled: true,
        contextSaving: false,
      };

      const result = await testMcpServer(server);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });

    it('should handle listTools failure gracefully (partial success)', async () => {
      const { Client } = jest.requireMock('@modelcontextprotocol/sdk/client');
      Client.mockImplementationOnce(() => ({
        connect: jest.fn(),
        getServerVersion: jest.fn().mockReturnValue({ name: 'partial', version: '0.1' }),
        listTools: jest.fn().mockRejectedValue(new Error('listTools not supported')),
        close: jest.fn(),
      }));

      const server: ClaudianMcpServer = {
        name: 'partial',
        config: { command: 'node server.js' },
        enabled: true,
        contextSaving: false,
      };

      const result = await testMcpServer(server);

      expect(result.success).toBe(true);
      expect(result.serverName).toBe('partial');
      expect(result.tools).toEqual([]);
    });

    it('should handle close errors silently', async () => {
      const { Client } = jest.requireMock('@modelcontextprotocol/sdk/client');
      Client.mockImplementationOnce(() => ({
        connect: jest.fn(),
        getServerVersion: jest.fn().mockReturnValue(null),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn().mockRejectedValue(new Error('close failed')),
      }));

      const server: ClaudianMcpServer = {
        name: 'close-fail',
        config: { command: 'node server.js' },
        enabled: true,
        contextSaving: false,
      };

      const result = await testMcpServer(server);

      expect(result.success).toBe(true);
      expect(result.serverName).toBeUndefined();
    });
  });
});
