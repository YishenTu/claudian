/**
 * MCP (Model Context Protocol) tests.
 *
 * Tests for MCP types, storage parsing, service logic, and utilities.
 */

import * as childProcess from 'child_process';
import { EventEmitter } from 'events';
import * as http from 'http';
import { ReadableStream } from 'stream/web';

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
  consumeSseStream,
  extractMcpMentions,
  parseCommand,
  parseRpcId,
  postJsonRpc,
  resolveSseEndpoint,
  splitCommandString,
  tryParseJson,
  waitForRpcResponse,
} from '@/utils/mcp';

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

function createReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function createControlledStream(): {
  stream: ReadableStream<Uint8Array>;
  push: (data: string) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });

  return {
    stream,
    push: (data: string) => {
      if (!controller) throw new Error('Stream not initialized');
      controller.enqueue(encoder.encode(data));
    },
    close: () => {
      if (!controller) throw new Error('Stream not initialized');
      controller.close();
    },
  };
}

function encodeSseEvent(data: string, event?: string): string {
  const eventLine = event ? `event: ${event}\n` : '';
  return `${eventLine}data: ${data}\n\n`;
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

  describe('parseRpcId', () => {
    it('should parse number id', () => {
      expect(parseRpcId(1)).toBe(1);
      expect(parseRpcId(42)).toBe(42);
      expect(parseRpcId(0)).toBe(0);
    });

    it('should parse string id', () => {
      expect(parseRpcId('1')).toBe(1);
      expect(parseRpcId('42')).toBe(42);
      expect(parseRpcId('  123  ')).toBe(123);
    });

    it('should return null for invalid ids', () => {
      expect(parseRpcId(null)).toBeNull();
      expect(parseRpcId(undefined)).toBeNull();
      expect(parseRpcId('abc')).toBeNull();
      expect(parseRpcId('')).toBeNull();
      expect(parseRpcId(NaN)).toBeNull();
      expect(parseRpcId(Infinity)).toBeNull();
    });
  });

  describe('tryParseJson', () => {
    it('should parse valid JSON', () => {
      expect(tryParseJson('{"key": "value"}')).toEqual({ key: 'value' });
      expect(tryParseJson('[1, 2, 3]')).toEqual([1, 2, 3]);
      expect(tryParseJson('"string"')).toBe('string');
      expect(tryParseJson('123')).toBe(123);
      expect(tryParseJson('true')).toBe(true);
    });

    it('should return null for invalid JSON', () => {
      expect(tryParseJson('not json')).toBeNull();
      expect(tryParseJson('{invalid}')).toBeNull();
      expect(tryParseJson('')).toBeNull();
    });
  });

  describe('resolveSseEndpoint', () => {
    const baseUrl = new URL('http://localhost:3000/sse');

    it('should resolve endpoint from JSON object', () => {
      const result = resolveSseEndpoint('{"endpoint": "/messages"}', baseUrl);
      expect(result?.toString()).toBe('http://localhost:3000/messages');
    });

    it('should resolve messageEndpoint from JSON', () => {
      const result = resolveSseEndpoint('{"messageEndpoint": "/api/messages"}', baseUrl);
      expect(result?.toString()).toBe('http://localhost:3000/api/messages');
    });

    it('should resolve url from JSON', () => {
      const result = resolveSseEndpoint('{"url": "http://other.com/msg"}', baseUrl);
      expect(result?.toString()).toBe('http://other.com/msg');
    });

    it('should resolve messageUrl from JSON', () => {
      const result = resolveSseEndpoint('{"messageUrl": "/msg"}', baseUrl);
      expect(result?.toString()).toBe('http://localhost:3000/msg');
    });

    it('should resolve plain URL string', () => {
      const result = resolveSseEndpoint('/messages', baseUrl);
      expect(result?.toString()).toBe('http://localhost:3000/messages');
    });

    it('should resolve absolute URL string', () => {
      const result = resolveSseEndpoint('http://other.com/msg', baseUrl);
      expect(result?.toString()).toBe('http://other.com/msg');
    });

    it('should return null for empty data', () => {
      expect(resolveSseEndpoint('', baseUrl)).toBeNull();
      expect(resolveSseEndpoint('   ', baseUrl)).toBeNull();
    });

    it('should fall back to raw string as URL when JSON has no endpoint keys', () => {
      // When JSON doesn't have recognized endpoint keys, the raw string is tried as URL
      // This is expected fallback behavior
      const result = resolveSseEndpoint('{"other": "value"}', baseUrl);
      // The JSON string becomes a URL-encoded path
      expect(result).not.toBeNull();
      expect(result?.pathname).toContain('%7B');
    });

    it('should skip empty endpoint string in JSON', () => {
      // Empty endpoint string is falsy, so it's skipped
      // Falls back to trying the raw JSON as URL
      const result = resolveSseEndpoint('{"endpoint": ""}', baseUrl);
      expect(result).not.toBeNull(); // Falls back to raw string
    });

    it('should prefer endpoint over other keys', () => {
      const data = JSON.stringify({
        endpoint: '/primary',
        messageEndpoint: '/secondary',
        url: '/tertiary',
      });
      const result = resolveSseEndpoint(data, baseUrl);
      expect(result?.toString()).toBe('http://localhost:3000/primary');
    });
  });

  describe('consumeSseStream', () => {
    it('should parse events across chunks and ignore comments', async () => {
      const stream = createReadableStream([
        'event: message\ndata: hello',
        '\n\n: keepalive\n\n',
        'data: world\n\n',
      ]);
      const events: Array<{ event?: string; data: string }> = [];

      await consumeSseStream(stream as any, (event) => events.push(event));

      expect(events).toEqual([
        { event: 'message', data: 'hello' },
        { data: 'world' },
      ]);
    });
  });

  describe('waitForRpcResponse', () => {
    it('should resolve when handler is invoked', async () => {
      const pending = new Map<number, (msg: Record<string, unknown>) => void>();
      const promise = waitForRpcResponse(pending, 1, 1000);

      const handler = pending.get(1);
      expect(handler).toBeDefined();
      handler?.({ result: 'ok' });

      await expect(promise).resolves.toEqual({ result: 'ok' });
      expect(pending.has(1)).toBe(false);
    });

    it('should reject on timeout', async () => {
      jest.useFakeTimers();
      try {
        const pending = new Map<number, (msg: Record<string, unknown>) => void>();
        const promise = waitForRpcResponse(pending, 1, 50);

        jest.advanceTimersByTime(50);

        await expect(promise).rejects.toThrow('Response timeout (50ms)');
        expect(pending.has(1)).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('postJsonRpc', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('should set Content-Type header when missing', async () => {
      const fetchMock = jest.fn().mockResolvedValue(new Response('', { status: 200 }));
      globalThis.fetch = fetchMock as any;

      await postJsonRpc(new URL('http://localhost:3000/mcp'), { Authorization: 'token' }, { id: 1 });

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:3000/mcp',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'token',
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('should preserve existing Content-Type header', async () => {
      const fetchMock = jest.fn().mockResolvedValue(new Response('', { status: 200 }));
      globalThis.fetch = fetchMock as any;

      await postJsonRpc(
        new URL('http://localhost:3000/mcp'),
        { 'Content-Type': 'application/custom' },
        { id: 1 }
      );

      const options = fetchMock.mock.calls[0][1] as RequestInit;
      const headers = options.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/custom');
    });
  });
});

// ============================================================================
// McpTester Tests
// ============================================================================

describe('McpTester', () => {
  type MockChildProcess = EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: jest.Mock };
    killed: boolean;
    kill: jest.Mock;
  };

  const createMockChildProcess = (): MockChildProcess => {
    const child = new EventEmitter() as MockChildProcess;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: jest.fn() };
    child.killed = false;
    child.kill = jest.fn(() => {
      child.killed = true;
    });
    return child;
  };

  const mockHttpRequests = (
    responses: Array<{ statusCode?: number; body: string }>
  ): jest.SpyInstance => {
    return jest.spyOn(http, 'request').mockImplementation(((_options: http.RequestOptions, callback: (res: any) => void) => {
      const response = responses.shift() ?? { statusCode: 200, body: '' };
      const res = new EventEmitter() as EventEmitter & { statusCode?: number };
      res.statusCode = response.statusCode ?? 200;
      callback(res);

      const req = new EventEmitter() as EventEmitter & {
        write: jest.Mock;
        end: () => void;
      };
      req.write = jest.fn();
      req.end = () => {
        if (response.body) {
          res.emit('data', response.body);
        }
        res.emit('end');
      };
      return req as any;
    }) as any);
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should test stdio server and return tools', async () => {
    const child = createMockChildProcess();
    const spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue(child as any);
    const server: ClaudianMcpServer = {
      name: 'local',
      config: { command: 'node', args: ['server'] },
      enabled: true,
      contextSaving: false,
    };

    const resultPromise = testMcpServer(server);

    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          id: 1,
          result: { serverInfo: { name: 'local-srv', version: '1.0.0' } },
        }) + '\n'
      )
    );
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          id: 2,
          result: { tools: [{ name: 'tool-a', description: 'Tool A' }] },
        }) + '\n'
      )
    );

    const result = await resultPromise;

    expect(spawnSpy).toHaveBeenCalledWith('node', ['server'], expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }));
    expect(result.success).toBe(true);
    expect(result.serverName).toBe('local-srv');
    expect(result.serverVersion).toBe('1.0.0');
    expect(result.tools).toMatchObject([{ name: 'tool-a', description: 'Tool A' }]);
    expect(child.stdin.write).toHaveBeenCalledTimes(3);

    const writes = child.stdin.write.mock.calls.map((call) => JSON.parse(String(call[0]).trim()));
    expect(writes[0].method).toBe('initialize');
    expect(writes[1].method).toBe('notifications/initialized');
    expect(writes[2].method).toBe('tools/list');
    expect(child.kill).toHaveBeenCalled();
  });

  it('should fail when stdio command is missing', async () => {
    const spawnSpy = jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
      throw new Error('spawn should not be called');
    });
    const server: ClaudianMcpServer = {
      name: 'missing',
      config: { command: '' },
      enabled: true,
      contextSaving: false,
    };

    const result = await testMcpServer(server);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Missing command');
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('should test http server and return tools', async () => {
    const requestSpy = mockHttpRequests([
      {
        statusCode: 200,
        body: JSON.stringify({ result: { serverInfo: { name: 'http-srv', version: '2.0.0' } } }),
      },
      { statusCode: 200, body: '{}' },
      {
        statusCode: 200,
        body: JSON.stringify({ result: { tools: [{ name: 'tool-b' }] } }),
      },
    ]);
    const server: ClaudianMcpServer = {
      name: 'http',
      config: { type: 'http', url: 'http://localhost:3000/mcp', headers: { Authorization: 'token' } },
      enabled: true,
      contextSaving: false,
    };

    const result = await testMcpServer(server);

    expect(result.success).toBe(true);
    expect(result.serverName).toBe('http-srv');
    expect(result.serverVersion).toBe('2.0.0');
    expect(result.tools).toMatchObject([{ name: 'tool-b' }]);
    expect(requestSpy).toHaveBeenCalledTimes(3);

    const firstOptions = requestSpy.mock.calls[0][0] as { headers?: Record<string, string> };
    expect(firstOptions.headers?.Accept).toContain('text/event-stream');
  });

  it('should surface initialize errors for http servers', async () => {
    const requestSpy = mockHttpRequests([
      {
        statusCode: 200,
        body: JSON.stringify({ error: { message: 'init failed' } }),
      },
    ]);
    const server: ClaudianMcpServer = {
      name: 'http',
      config: { type: 'http', url: 'http://localhost:3000/mcp' },
      enabled: true,
      contextSaving: false,
    };

    const result = await testMcpServer(server);

    expect(result.success).toBe(false);
    expect(result.error).toBe('init failed');
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it('should auto-detect SSE response format from http server (streamable-http)', async () => {
    // Streamable HTTP servers may respond with SSE format (data: {...})
    mockHttpRequests([
      {
        statusCode: 200,
        body: 'data: ' + JSON.stringify({ result: { serverInfo: { name: 'streamable-srv', version: '1.0.0' } } }),
      },
      { statusCode: 200, body: '{}' },
      {
        statusCode: 200,
        body: 'data: ' + JSON.stringify({ result: { tools: [{ name: 'stream-tool' }] } }),
      },
    ]);
    const server: ClaudianMcpServer = {
      name: 'streamable',
      config: { type: 'http', url: 'http://localhost:3000/mcp' },
      enabled: true,
      contextSaving: false,
    };

    const result = await testMcpServer(server);

    expect(result.success).toBe(true);
    expect(result.serverName).toBe('streamable-srv');
    expect(result.serverVersion).toBe('1.0.0');
    expect(result.tools).toMatchObject([{ name: 'stream-tool' }]);
  });

  it('should fail with invalid response when neither JSON nor SSE format', async () => {
    mockHttpRequests([
      {
        statusCode: 200,
        body: 'not json and not sse format',
      },
    ]);
    const server: ClaudianMcpServer = {
      name: 'invalid-format',
      config: { type: 'http', url: 'http://localhost:3000/mcp' },
      enabled: true,
      contextSaving: false,
    };

    const result = await testMcpServer(server);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid response');
  });

  it('should fail when SSE data line contains invalid JSON', async () => {
    mockHttpRequests([
      {
        statusCode: 200,
        body: 'data: {not valid json}',
      },
    ]);
    const server: ClaudianMcpServer = {
      name: 'malformed-sse',
      config: { type: 'http', url: 'http://localhost:3000/mcp' },
      enabled: true,
      contextSaving: false,
    };

    const result = await testMcpServer(server);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid response');
  });

  it('should fail with empty response from http server', async () => {
    mockHttpRequests([
      {
        statusCode: 200,
        body: '',
      },
    ]);
    const server: ClaudianMcpServer = {
      name: 'empty-response',
      config: { type: 'http', url: 'http://localhost:3000/mcp' },
      enabled: true,
      contextSaving: false,
    };

    const result = await testMcpServer(server);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid response');
  });

  it('should return partial success when tools response is unparseable', async () => {
    mockHttpRequests([
      {
        statusCode: 200,
        body: JSON.stringify({ result: { serverInfo: { name: 'srv', version: '1.0' } } }),
      },
      { statusCode: 200, body: '{}' },
      {
        statusCode: 200,
        body: 'unparseable garbage',
      },
    ]);
    const server: ClaudianMcpServer = {
      name: 'partial',
      config: { type: 'http', url: 'http://localhost:3000/mcp' },
      enabled: true,
      contextSaving: false,
    };

    const result = await testMcpServer(server);

    expect(result.success).toBe(true);
    expect(result.serverName).toBe('srv');
    expect(result.tools).toEqual([]);
  });

  it('should test sse server and return tools', async () => {
    const originalFetch = globalThis.fetch;
    const postRequests: Array<{ url: string; body: string }> = [];
    const { stream, push, close } = createControlledStream();
    let endpointSent = false;

    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!init || init.method === 'GET') {
        if (!endpointSent) {
          endpointSent = true;
          push(encodeSseEvent(JSON.stringify({ endpoint: '/messages' })));
        }
        return new Response(stream as any, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      postRequests.push({ url, body: String(init.body ?? '') });
      try {
        const payload = JSON.parse(String(init.body ?? '{}')) as { method?: string };
        if (payload.method === 'initialize') {
          push(
            encodeSseEvent(
              JSON.stringify({
                id: 1,
                result: { serverInfo: { name: 'sse-srv', version: '3.0.0' } },
              })
            )
          );
        }
        if (payload.method === 'tools/list') {
          push(encodeSseEvent(JSON.stringify({ id: 2, result: { tools: [{ name: 'tool-c' }] } })));
          close();
        }
      } catch {
        // Ignore JSON parse errors for unexpected payloads
      }
      return new Response('{}', { status: 200 });
    });
    globalThis.fetch = fetchMock as any;

    try {
      const server: ClaudianMcpServer = {
        name: 'sse',
        config: { type: 'sse', url: 'http://localhost:3000/sse' },
        enabled: true,
        contextSaving: false,
      };

      const result = await testMcpServer(server);

      expect(result.success).toBe(true);
      expect(result.serverName).toBe('sse-srv');
      expect(result.serverVersion).toBe('3.0.0');
      expect(result.tools).toMatchObject([{ name: 'tool-c' }]);
      expect(postRequests).toHaveLength(3);
      expect(postRequests[0].url).toBe('http://localhost:3000/messages');

      const methods = postRequests.map((req) => JSON.parse(req.body).method);
      expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    } finally {
      globalThis.fetch = originalFetch;
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
