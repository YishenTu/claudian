import { Client } from '@modelcontextprotocol/sdk/client';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp';

import { McpServerManager, McpService } from '@/core/mcp';
import { testMcpServer } from '@/core/mcp/McpTester';
import { MCP_CONFIG_PATH, McpStorage } from '@/core/storage/McpStorage';
import type {
  ClaudianMcpServer,
  McpHttpServerConfig,
  McpServerConfig,
  McpSSEServerConfig,
  McpStdioServerConfig,
} from '@/core/types/mcp';
import {
  DEFAULT_MCP_SERVER,
  getMcpServerType,
  inferMcpServerType,
  isValidMcpServerConfig,
} from '@/core/types/mcp';
import {
  extractMcpMentions,
  parseCommand,
  splitCommandString,
} from '@/utils/mcp';

jest.mock('@modelcontextprotocol/sdk/client', () => ({
  Client: jest.fn(),
}));

jest.mock('@modelcontextprotocol/sdk/client/stdio', () => ({
  StdioClientTransport: jest.fn(),
}));

jest.mock('@modelcontextprotocol/sdk/client/sse', () => ({
  SSEClientTransport: jest.fn(),
}));

jest.mock('@modelcontextprotocol/sdk/client/streamableHttp', () => ({
  StreamableHTTPClientTransport: jest.fn(),
}));

function createMemoryStorage(initialFile?: Record<string, unknown>): {
  storage: McpStorage;
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  if (initialFile) {
    files.set(MCP_CONFIG_PATH, JSON.stringify(initialFile));
  }

  const adapter = {
    exists: async (path: string) => files.has(path),
    read: async (path: string) => files.get(path) ?? '',
    write: async (path: string, content: string) => {
      files.set(path, content);
    },
  };

  return { storage: new McpStorage(adapter as any), files };
}

// ============================================================================
// MCP Type Tests
// ============================================================================

describe('MCP Types', () => {
  describe('getMcpServerType', () => {
    it('should return stdio for command-based config', () => {
      const config: McpStdioServerConfig = { command: 'npx' };
      expect(getMcpServerType(config)).toBe('stdio');
    });

    it('should return stdio for config with explicit type', () => {
      const config: McpStdioServerConfig = { type: 'stdio', command: 'docker' };
      expect(getMcpServerType(config)).toBe('stdio');
    });

    it('should return sse for SSE config', () => {
      const config: McpSSEServerConfig = { type: 'sse', url: 'http://localhost:3000/sse' };
      expect(getMcpServerType(config)).toBe('sse');
    });

    it('should return http for HTTP config', () => {
      const config: McpHttpServerConfig = { type: 'http', url: 'http://localhost:3000/mcp' };
      expect(getMcpServerType(config)).toBe('http');
    });

    it('should return http for URL without explicit type', () => {
      const config = { url: 'http://localhost:3000/mcp' } as McpServerConfig;
      expect(getMcpServerType(config)).toBe('http');
    });
  });

  describe('inferMcpServerType', () => {
    it('should infer stdio for command config', () => {
      const config: McpStdioServerConfig = { command: 'python', args: ['-m', 'server'] };
      expect(inferMcpServerType(config)).toBe('stdio');
    });

    it('should infer sse for SSE config', () => {
      const config: McpSSEServerConfig = { type: 'sse', url: 'http://example.com/sse' };
      expect(inferMcpServerType(config)).toBe('sse');
    });

    it('should infer http for HTTP config', () => {
      const config: McpHttpServerConfig = { type: 'http', url: 'http://example.com/mcp' };
      expect(inferMcpServerType(config)).toBe('http');
    });

    it('should default URL-based config to http', () => {
      const config = { url: 'http://example.com' } as McpServerConfig;
      expect(inferMcpServerType(config)).toBe('http');
    });
  });

  describe('isValidMcpServerConfig', () => {
    it('should return true for valid stdio config', () => {
      expect(isValidMcpServerConfig({ command: 'npx' })).toBe(true);
      expect(isValidMcpServerConfig({ command: 'docker', args: ['exec', '-i'] })).toBe(true);
    });

    it('should return true for valid URL config', () => {
      expect(isValidMcpServerConfig({ url: 'http://localhost:3000' })).toBe(true);
      expect(isValidMcpServerConfig({ type: 'sse', url: 'http://localhost:3000/sse' })).toBe(true);
      expect(isValidMcpServerConfig({ type: 'http', url: 'http://localhost:3000/mcp' })).toBe(true);
    });

    it('should return false for invalid configs', () => {
      expect(isValidMcpServerConfig(null)).toBe(false);
      expect(isValidMcpServerConfig(undefined)).toBe(false);
      expect(isValidMcpServerConfig({})).toBe(false);
      expect(isValidMcpServerConfig({ command: 123 })).toBe(false);
      expect(isValidMcpServerConfig({ url: 123 })).toBe(false);
      expect(isValidMcpServerConfig('string')).toBe(false);
      expect(isValidMcpServerConfig(123)).toBe(false);
    });
  });

  describe('DEFAULT_MCP_SERVER', () => {
    it('should have enabled true by default', () => {
      expect(DEFAULT_MCP_SERVER.enabled).toBe(true);
    });

    it('should have contextSaving true by default', () => {
      expect(DEFAULT_MCP_SERVER.contextSaving).toBe(true);
    });
  });
});

// ============================================================================
// McpStorage Clipboard Parsing Tests
// ============================================================================

describe('McpStorage', () => {
  describe('parseClipboardConfig', () => {
    it('should parse full Claude Code format', () => {
      const json = JSON.stringify({
        mcpServers: {
          'my-server': { command: 'npx', args: ['server'] },
          'other-server': { type: 'sse', url: 'http://localhost:3000' },
        },
      });

      const result = McpStorage.parseClipboardConfig(json);

      expect(result.needsName).toBe(false);
      expect(result.servers).toHaveLength(2);
      expect(result.servers[0].name).toBe('my-server');
      expect(result.servers[0].config).toEqual({ command: 'npx', args: ['server'] });
      expect(result.servers[1].name).toBe('other-server');
    });

    it('should parse single server with name', () => {
      const json = JSON.stringify({
        'my-server': { command: 'docker', args: ['exec', '-i', 'container'] },
      });

      const result = McpStorage.parseClipboardConfig(json);

      expect(result.needsName).toBe(false);
      expect(result.servers).toHaveLength(1);
      expect(result.servers[0].name).toBe('my-server');
    });

    it('should parse single config without name', () => {
      const json = JSON.stringify({
        command: 'python',
        args: ['-m', 'server'],
      });

      const result = McpStorage.parseClipboardConfig(json);

      expect(result.needsName).toBe(true);
      expect(result.servers).toHaveLength(1);
      expect(result.servers[0].name).toBe('');
      expect(result.servers[0].config).toEqual({ command: 'python', args: ['-m', 'server'] });
    });

    it('should parse URL config without name', () => {
      const json = JSON.stringify({
        type: 'sse',
        url: 'http://localhost:3000/sse',
        headers: { Authorization: 'Bearer token' },
      });

      const result = McpStorage.parseClipboardConfig(json);

      expect(result.needsName).toBe(true);
      expect(result.servers).toHaveLength(1);
      expect(result.servers[0].config).toEqual({
        type: 'sse',
        url: 'http://localhost:3000/sse',
        headers: { Authorization: 'Bearer token' },
      });
    });

    it('should parse multiple named servers without mcpServers wrapper', () => {
      const json = JSON.stringify({
        server1: { command: 'npx' },
        server2: { url: 'http://localhost:3000' },
      });

      const result = McpStorage.parseClipboardConfig(json);

      expect(result.needsName).toBe(false);
      expect(result.servers).toHaveLength(2);
    });

    it('should throw for invalid JSON', () => {
      expect(() => McpStorage.parseClipboardConfig('not json')).toThrow('Invalid JSON');
    });

    it('should throw for non-object JSON', () => {
      expect(() => McpStorage.parseClipboardConfig('"string"')).toThrow('Invalid JSON object');
      expect(() => McpStorage.parseClipboardConfig('123')).toThrow('Invalid JSON object');
      expect(() => McpStorage.parseClipboardConfig('null')).toThrow('Invalid JSON object');
    });

    it('should throw for empty mcpServers', () => {
      const json = JSON.stringify({ mcpServers: {} });
      expect(() => McpStorage.parseClipboardConfig(json)).toThrow('No valid server configs');
    });

    it('should throw for invalid config format', () => {
      const json = JSON.stringify({ invalidKey: 'invalidValue' });
      expect(() => McpStorage.parseClipboardConfig(json)).toThrow('Invalid MCP configuration');
    });

    it('should skip invalid configs in mcpServers', () => {
      const json = JSON.stringify({
        mcpServers: {
          valid: { command: 'npx' },
          invalid: { notACommand: 'foo' },
        },
      });

      const result = McpStorage.parseClipboardConfig(json);

      expect(result.servers).toHaveLength(1);
      expect(result.servers[0].name).toBe('valid');
    });
  });

  describe('tryParseClipboardConfig', () => {
    it('should return parsed config for valid JSON', () => {
      const json = JSON.stringify({ command: 'npx' });
      const result = McpStorage.tryParseClipboardConfig(json);

      expect(result).not.toBeNull();
      expect(result!.needsName).toBe(true);
    });

    it('should return null for non-JSON text', () => {
      expect(McpStorage.tryParseClipboardConfig('hello world')).toBeNull();
      expect(McpStorage.tryParseClipboardConfig('not { json')).toBeNull();
    });

    it('should return null for text not starting with {', () => {
      expect(McpStorage.tryParseClipboardConfig('[]')).toBeNull();
      expect(McpStorage.tryParseClipboardConfig('  []')).toBeNull();
    });

    it('should handle whitespace before JSON', () => {
      const json = '  { "command": "npx" }';
      const result = McpStorage.tryParseClipboardConfig(json);

      expect(result).not.toBeNull();
    });

    it('should return null for invalid MCP config', () => {
      const json = JSON.stringify({ random: 'object' });
      expect(McpStorage.tryParseClipboardConfig(json)).toBeNull();
    });
  });

  describe('load/save', () => {
    it('should preserve unknown top-level keys and merge _claudian', async () => {
      const initial = {
        mcpServers: {
          legacy: { command: 'node' },
        },
        _claudian: {
          servers: {
            legacy: { enabled: false },
          },
          extra: { keep: true },
        },
        other: { keep: true },
      };
      const { storage, files } = createMemoryStorage(initial);

      const servers: ClaudianMcpServer[] = [
        {
          name: 'new-server',
          config: {
            type: 'http',
            url: 'http://localhost:3000/mcp',
            headers: { Authorization: 'Bearer token' },
          },
          enabled: false,
          contextSaving: false,
          description: 'New server',
        },
      ];

      await storage.save(servers);

      const saved = JSON.parse(files.get(MCP_CONFIG_PATH) || '{}') as Record<string, unknown>;
      expect(saved.other).toEqual({ keep: true });
      expect(saved.mcpServers).toEqual({
        'new-server': {
          type: 'http',
          url: 'http://localhost:3000/mcp',
          headers: { Authorization: 'Bearer token' },
        },
      });
      expect(saved._claudian).toEqual({
        extra: { keep: true },
        servers: {
          'new-server': {
            enabled: false,
            contextSaving: false,
            description: 'New server',
          },
        },
      });
    });

    it('should keep existing _claudian fields when metadata is defaulted', async () => {
      const initial = {
        mcpServers: {
          legacy: { command: 'node' },
        },
        _claudian: {
          extra: { keep: true },
        },
      };
      const { storage, files } = createMemoryStorage(initial);

      const servers: ClaudianMcpServer[] = [
        {
          name: 'default-meta',
          config: { command: 'npx' },
          enabled: DEFAULT_MCP_SERVER.enabled,
          contextSaving: DEFAULT_MCP_SERVER.contextSaving,
        },
      ];

      await storage.save(servers);

      const saved = JSON.parse(files.get(MCP_CONFIG_PATH) || '{}') as Record<string, unknown>;
      expect(saved._claudian).toEqual({ extra: { keep: true } });
      expect(saved.mcpServers).toEqual({ 'default-meta': { command: 'npx' } });
    });

    it('should load servers with metadata and defaults', async () => {
      const initial = {
        mcpServers: {
          stdio: { command: 'npx' },
          remote: { type: 'sse', url: 'http://localhost:3000/sse' },
        },
        _claudian: {
          servers: {
            stdio: { enabled: false, contextSaving: false, description: 'Local tools' },
          },
        },
      };
      const { storage } = createMemoryStorage(initial);

      const servers = await storage.load();

      expect(servers).toHaveLength(2);
      const stdio = servers.find((server) => server.name === 'stdio')!;
      const remote = servers.find((server) => server.name === 'remote')!;

      expect(stdio.enabled).toBe(false);
      expect(stdio.contextSaving).toBe(false);
      expect(stdio.description).toBe('Local tools');

      expect(remote.enabled).toBe(true);
      expect(remote.contextSaving).toBe(true);
    });

    it('should skip invalid server configs on load', async () => {
      const initial = {
        mcpServers: {
          valid: { command: 'npx' },
          invalid: { foo: 'bar' },
        },
        _claudian: {
          servers: {
            invalid: { enabled: false },
          },
        },
      };
      const { storage } = createMemoryStorage(initial);

      const servers = await storage.load();

      expect(servers).toHaveLength(1);
      expect(servers[0].name).toBe('valid');
      expect(servers[0].enabled).toBe(true);
      expect(servers[0].contextSaving).toBe(true);
    });

    it('should remove _claudian when only servers metadata exists', async () => {
      const initial = {
        mcpServers: {
          legacy: { command: 'node' },
        },
        _claudian: {
          servers: {
            legacy: { enabled: false },
          },
        },
      };
      const { storage, files } = createMemoryStorage(initial);

      const servers: ClaudianMcpServer[] = [
        {
          name: 'legacy',
          config: { command: 'node' },
          enabled: DEFAULT_MCP_SERVER.enabled,
          contextSaving: DEFAULT_MCP_SERVER.contextSaving,
        },
      ];

      await storage.save(servers);

      const saved = JSON.parse(files.get(MCP_CONFIG_PATH) || '{}') as Record<string, unknown>;
      expect(saved._claudian).toBeUndefined();
    });
  });
});

// ============================================================================
// MCP Utils Tests
// ============================================================================

describe('MCP Utils', () => {
  describe('extractMcpMentions', () => {
    it('should extract valid @mentions', () => {
      const validNames = new Set(['context7', 'code-exec', 'my_server']);
      const text = 'Use @context7 and @code-exec to help';

      const result = extractMcpMentions(text, validNames);

      expect(result.size).toBe(2);
      expect(result.has('context7')).toBe(true);
      expect(result.has('code-exec')).toBe(true);
    });

    it('should only extract valid names', () => {
      const validNames = new Set(['valid-server']);
      const text = 'Use @valid-server and @invalid-server';

      const result = extractMcpMentions(text, validNames);

      expect(result.size).toBe(1);
      expect(result.has('valid-server')).toBe(true);
      expect(result.has('invalid-server')).toBe(false);
    });

    it('should handle dots and underscores in names', () => {
      const validNames = new Set(['server.v2', 'my_server', 'test-server']);
      const text = '@server.v2 @my_server @test-server';

      const result = extractMcpMentions(text, validNames);

      expect(result.size).toBe(3);
    });

    it('should return empty set for no mentions', () => {
      const validNames = new Set(['server']);
      const text = 'No mentions here';

      const result = extractMcpMentions(text, validNames);

      expect(result.size).toBe(0);
    });

    it('should handle multiple same mentions', () => {
      const validNames = new Set(['server']);
      const text = '@server and @server again';

      const result = extractMcpMentions(text, validNames);

      expect(result.size).toBe(1);
    });

    it('should ignore @name/ filter mentions', () => {
      const validNames = new Set(['workspace']);
      const text = 'Use @workspace/ to filter files';

      const result = extractMcpMentions(text, validNames);

      expect(result.size).toBe(0);
    });

    it('should not match partial names from email addresses', () => {
      // The regex captures everything after @ until a non-valid char
      // So user@example.com captures 'example.com', not 'example'
      const validNames = new Set(['example']);
      const text = 'Contact user@example.com for help';

      const result = extractMcpMentions(text, validNames);

      // 'example.com' is captured, but 'example' alone is not in the capture
      // So it won't match the validNames set
      expect(result.size).toBe(0);
    });
  });

  describe('splitCommandString', () => {
    it('should split simple command', () => {
      expect(splitCommandString('docker exec -i')).toEqual(['docker', 'exec', '-i']);
    });

    it('should handle quoted arguments', () => {
      expect(splitCommandString('echo "hello world"')).toEqual(['echo', 'hello world']);
      expect(splitCommandString("echo 'hello world'")).toEqual(['echo', 'hello world']);
    });

    it('should handle mixed quotes', () => {
      expect(splitCommandString('cmd "arg 1" \'arg 2\'')).toEqual(['cmd', 'arg 1', 'arg 2']);
    });

    it('should handle empty string', () => {
      expect(splitCommandString('')).toEqual([]);
    });

    it('should handle multiple spaces', () => {
      expect(splitCommandString('cmd    arg1   arg2')).toEqual(['cmd', 'arg1', 'arg2']);
    });

    it('should preserve quotes content with special chars', () => {
      expect(splitCommandString('echo "hello=world"')).toEqual(['echo', 'hello=world']);
    });
  });

  describe('parseCommand', () => {
    it('should parse command without args', () => {
      const result = parseCommand('docker');
      expect(result.cmd).toBe('docker');
      expect(result.args).toEqual([]);
    });

    it('should parse command with inline args', () => {
      const result = parseCommand('docker exec -i container');
      expect(result.cmd).toBe('docker');
      expect(result.args).toEqual(['exec', '-i', 'container']);
    });

    it('should use provided args if given', () => {
      const result = parseCommand('docker', ['run', '-it']);
      expect(result.cmd).toBe('docker');
      expect(result.args).toEqual(['run', '-it']);
    });

    it('should prefer provided args over inline', () => {
      const result = parseCommand('docker exec', ['run']);
      expect(result.cmd).toBe('docker exec');
      expect(result.args).toEqual(['run']);
    });

    it('should handle empty command', () => {
      const result = parseCommand('');
      expect(result.cmd).toBe('');
      expect(result.args).toEqual([]);
    });
  });
});

// ============================================================================
// McpTester Tests
// ============================================================================

describe('McpTester', () => {
  let mockClientInstance: {
    connect: jest.Mock;
    listTools: jest.Mock;
    close: jest.Mock;
    getServerVersion: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockClientInstance = {
      connect: jest.fn().mockResolvedValue(undefined),
      listTools: jest.fn().mockResolvedValue({
        tools: [{ name: 'tool-a', description: 'Tool A', inputSchema: { type: 'object' } }],
      }),
      close: jest.fn().mockResolvedValue(undefined),
      getServerVersion: jest.fn().mockReturnValue({ name: 'test-srv', version: '1.0.0' }),
    };
    (Client as jest.Mock).mockImplementation(() => mockClientInstance);
  });

  it('should test stdio server and return tools', async () => {
    const server: ClaudianMcpServer = {
      name: 'local',
      config: { command: 'node', args: ['server'] },
      enabled: true,
      contextSaving: false,
    };

    const result = await testMcpServer(server);

    expect(result.success).toBe(true);
    expect(result.serverName).toBe('test-srv');
    expect(result.serverVersion).toBe('1.0.0');
    expect(result.tools).toEqual([{ name: 'tool-a', description: 'Tool A', inputSchema: { type: 'object' } }]);
    expect(StdioClientTransport).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'node', args: ['server'] }),
    );
    expect(mockClientInstance.connect).toHaveBeenCalledTimes(1);
    expect(mockClientInstance.listTools).toHaveBeenCalledTimes(1);
  });

  it('should fail when stdio command is missing', async () => {
    const server: ClaudianMcpServer = {
      name: 'missing',
      config: { command: '' },
      enabled: true,
      contextSaving: false,
    };

    const result = await testMcpServer(server);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Missing command');
    expect(mockClientInstance.connect).not.toHaveBeenCalled();
  });

  it('should fail for invalid URL', async () => {
    const server: ClaudianMcpServer = {
      name: 'bad-url',
      config: { type: 'http', url: 'not-a-valid-url' },
      enabled: true,
      contextSaving: false,
    };

    const result = await testMcpServer(server);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(mockClientInstance.connect).not.toHaveBeenCalled();
  });

  it('should test http server and return tools', async () => {
    const server: ClaudianMcpServer = {
      name: 'http',
      config: { type: 'http', url: 'http://localhost:3000/mcp', headers: { Authorization: 'token' } },
      enabled: true,
      contextSaving: false,
    };

    const result = await testMcpServer(server);

    expect(result.success).toBe(true);
    expect(result.serverName).toBe('test-srv');
    expect(result.serverVersion).toBe('1.0.0');
    expect(result.tools).toEqual([{ name: 'tool-a', description: 'Tool A', inputSchema: { type: 'object' } }]);
    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ requestInit: { headers: { Authorization: 'token' } } }),
    );
  });

  it('should test sse server and return tools', async () => {
    const server: ClaudianMcpServer = {
      name: 'sse',
      config: { type: 'sse', url: 'http://localhost:3000/sse', headers: { Authorization: 'token' } },
      enabled: true,
      contextSaving: false,
    };

    const result = await testMcpServer(server);

    expect(result.success).toBe(true);
    expect(result.serverName).toBe('test-srv');
    expect(result.serverVersion).toBe('1.0.0');
    expect(result.tools).toEqual([{ name: 'tool-a', description: 'Tool A', inputSchema: { type: 'object' } }]);
    expect(SSEClientTransport).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ requestInit: { headers: { Authorization: 'token' } } }),
    );
  });

  it('should return failure when connect fails', async () => {
    mockClientInstance.connect.mockRejectedValue(new Error('Connection refused'));

    const server: ClaudianMcpServer = {
      name: 'fail',
      config: { type: 'http', url: 'http://localhost:3000/mcp' },
      enabled: true,
      contextSaving: false,
    };

    const result = await testMcpServer(server);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Connection refused');
  });

  it('should return partial success when listTools fails', async () => {
    mockClientInstance.listTools.mockRejectedValue(new Error('tools/list not supported'));

    const server: ClaudianMcpServer = {
      name: 'partial',
      config: { type: 'http', url: 'http://localhost:3000/mcp' },
      enabled: true,
      contextSaving: false,
    };

    const result = await testMcpServer(server);

    expect(result.success).toBe(true);
    expect(result.serverName).toBe('test-srv');
    expect(result.serverVersion).toBe('1.0.0');
    expect(result.tools).toEqual([]);
  });

  it('should return timeout error when connection times out', async () => {
    jest.useFakeTimers();
    try {
      mockClientInstance.connect.mockImplementation(
        (_transport: unknown, options?: { signal?: AbortSignal }) =>
          new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );

      const server: ClaudianMcpServer = {
        name: 'timeout',
        config: { type: 'http', url: 'http://localhost:3000/mcp' },
        enabled: true,
        contextSaving: false,
      };

      const resultPromise = testMcpServer(server);
      jest.advanceTimersByTime(10000);
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection timeout (10s)');
    } finally {
      jest.useRealTimers();
    }
  });
});

// ============================================================================
// McpService Tests (Unit tests without plugin dependency)
// ============================================================================

describe('McpService', () => {
  function createService(servers: ClaudianMcpServer[]): McpService {
    const manager = new McpServerManager({
      load: jest.fn().mockResolvedValue(servers),
    });
    const service = new McpService(manager);
    // Directly set the manager's servers for testing
    (manager as any).servers = servers;
    return service;
  }

  describe('getActiveServers', () => {
    const servers: ClaudianMcpServer[] = [
      {
        name: 'always-on',
        config: { command: 'server1' },
        enabled: true,
        contextSaving: false,
      },
      {
        name: 'context-saving',
        config: { command: 'server2' },
        enabled: true,
        contextSaving: true,
      },
      {
        name: 'disabled',
        config: { command: 'server3' },
        enabled: false,
        contextSaving: false,
      },
      {
        name: 'disabled-context',
        config: { command: 'server4' },
        enabled: false,
        contextSaving: true,
      },
    ];

    it('should include enabled servers without context-saving', () => {
      const service = createService(servers);
      const result = service.getActiveServers(new Set());

      expect(result['always-on']).toBeDefined();
      expect(result['disabled']).toBeUndefined();
    });

    it('should exclude context-saving servers when not mentioned', () => {
      const service = createService(servers);
      const result = service.getActiveServers(new Set());

      expect(result['context-saving']).toBeUndefined();
    });

    it('should include context-saving servers when mentioned', () => {
      const service = createService(servers);
      const result = service.getActiveServers(new Set(['context-saving']));

      expect(result['context-saving']).toBeDefined();
      expect(result['always-on']).toBeDefined();
    });

    it('should never include disabled servers even when mentioned', () => {
      const service = createService(servers);
      const result = service.getActiveServers(new Set(['disabled', 'disabled-context']));

      expect(result['disabled']).toBeUndefined();
      expect(result['disabled-context']).toBeUndefined();
    });

    it('should return empty object for all disabled servers', () => {
      const disabledServers: ClaudianMcpServer[] = [
        { name: 's1', config: { command: 'c1' }, enabled: false, contextSaving: false },
        { name: 's2', config: { command: 'c2' }, enabled: false, contextSaving: true },
      ];

      const service = createService(disabledServers);
      const result = service.getActiveServers(new Set(['s1', 's2']));

      expect(Object.keys(result)).toHaveLength(0);
    });
  });

  describe('isValidMcpMention', () => {
    const servers: ClaudianMcpServer[] = [
      { name: 'enabled-context', config: { command: 'c1' }, enabled: true, contextSaving: true },
      { name: 'enabled-no-context', config: { command: 'c2' }, enabled: true, contextSaving: false },
      { name: 'disabled-context', config: { command: 'c3' }, enabled: false, contextSaving: true },
    ];

    it('should return true for enabled context-saving server', () => {
      const service = createService(servers);
      expect(service.isValidMcpMention('enabled-context')).toBe(true);
    });

    it('should return false for enabled non-context-saving server', () => {
      const service = createService(servers);
      expect(service.isValidMcpMention('enabled-no-context')).toBe(false);
    });

    it('should return false for disabled server', () => {
      const service = createService(servers);
      expect(service.isValidMcpMention('disabled-context')).toBe(false);
    });

    it('should return false for unknown server', () => {
      const service = createService(servers);
      expect(service.isValidMcpMention('unknown')).toBe(false);
    });
  });

  describe('getContextSavingServers', () => {
    const servers: ClaudianMcpServer[] = [
      { name: 's1', config: { command: 'c1' }, enabled: true, contextSaving: true },
      { name: 's2', config: { command: 'c2' }, enabled: true, contextSaving: false },
      { name: 's3', config: { command: 'c3' }, enabled: false, contextSaving: true },
      { name: 's4', config: { command: 'c4' }, enabled: true, contextSaving: true },
    ];

    it('should return only enabled context-saving servers', () => {
      const service = createService(servers);
      const result = service.getContextSavingServers();

      expect(result).toHaveLength(2);
      expect(result.map((s) => s.name)).toEqual(['s1', 's4']);
    });
  });

  describe('extractMentions', () => {
    const servers: ClaudianMcpServer[] = [
      { name: 'context7', config: { command: 'c1' }, enabled: true, contextSaving: true },
      { name: 'always-on', config: { command: 'c2' }, enabled: true, contextSaving: false },
      { name: 'disabled', config: { command: 'c3' }, enabled: false, contextSaving: true },
    ];

    it('should only extract enabled context-saving mentions', () => {
      const service = createService(servers);
      const result = service.extractMentions('Use @context7 and @always-on and @disabled');

      expect(result.size).toBe(1);
      expect(result.has('context7')).toBe(true);
    });

    it('should return empty set when no valid mentions exist', () => {
      const service = createService(servers);
      const result = service.extractMentions('No mentions here');

      expect(result.size).toBe(0);
    });
  });

  describe('helper methods', () => {
    it('should report server lists and enabled counts', () => {
      const servers: ClaudianMcpServer[] = [
        { name: 's1', config: { command: 'c1' }, enabled: true, contextSaving: true },
        { name: 's2', config: { command: 'c2' }, enabled: true, contextSaving: false },
        { name: 's3', config: { command: 'c3' }, enabled: false, contextSaving: true },
      ];
      const service = createService(servers);

      expect(service.getEnabledCount()).toBe(2);
      expect(service.getServerNames()).toEqual(['s1', 's2', 's3']);
      expect(service.getEnabledServerNames()).toEqual(['s1', 's2']);
      expect(service.hasServers()).toBe(true);
      expect(service.hasContextSavingServers()).toBe(true);
    });

    it('should return false when no servers are configured', () => {
      const service = createService([]);

      expect(service.getEnabledCount()).toBe(0);
      expect(service.getServerNames()).toEqual([]);
      expect(service.getEnabledServerNames()).toEqual([]);
      expect(service.hasServers()).toBe(false);
      expect(service.hasContextSavingServers()).toBe(false);
    });
  });
});
