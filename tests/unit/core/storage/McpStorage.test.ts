import { McpStorage } from '@/core/storage';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';

/** Mock adapter with exposed store for test assertions. */
type MockAdapter = VaultFileAdapter & { _store: Record<string, string> };

// Mock VaultFileAdapter with minimal implementation for McpStorage tests
function createMockAdapter(files: Record<string, string> = {}): MockAdapter {
  const store = { ...files };
  return {
    exists: async (path: string) => path in store,
    read: async (path: string) => {
      if (!(path in store)) throw new Error(`File not found: ${path}`);
      return store[path];
    },
    write: async (path: string, content: string) => {
      store[path] = content;
    },
    delete: async (path: string) => {
      delete store[path];
    },
    // Expose store for assertions
    _store: store,
  } as unknown as MockAdapter;
}

describe('McpStorage', () => {
  describe('load', () => {
    it('returns empty array when file does not exist', async () => {
      const adapter = createMockAdapter();
      const storage = new McpStorage(adapter);
      const servers = await storage.load();
      expect(servers).toEqual([]);
    });

    it('loads servers with disabledTools from _claudian metadata', async () => {
      const config = {
        mcpServers: {
          alpha: { command: 'alpha-cmd', args: ['--arg'] },
        },
        _claudian: {
          servers: {
            alpha: {
              enabled: true,
              contextSaving: true,
              disabledTools: ['tool_a', 'tool_b'],
            },
          },
        },
      };

      const adapter = createMockAdapter({
        '.claude/mcp.json': JSON.stringify(config),
      });
      const storage = new McpStorage(adapter);
      const servers = await storage.load();

      expect(servers).toHaveLength(1);
      expect(servers[0]).toMatchObject({
        name: 'alpha',
        config: { command: 'alpha-cmd', args: ['--arg'] },
        enabled: true,
        contextSaving: true,
        disabledTools: ['tool_a', 'tool_b'],
      });
    });

    it('filters out non-string disabledTools', async () => {
      const config = {
        mcpServers: {
          alpha: { command: 'alpha-cmd' },
        },
        _claudian: {
          servers: {
            alpha: {
              disabledTools: ['valid', 123, null, 'also_valid'],
            },
          },
        },
      };

      const adapter = createMockAdapter({
        '.claude/mcp.json': JSON.stringify(config),
      });
      const storage = new McpStorage(adapter);
      const servers = await storage.load();

      expect(servers[0].disabledTools).toEqual(['valid', 'also_valid']);
    });

    it('returns undefined disabledTools when array is empty', async () => {
      const config = {
        mcpServers: {
          alpha: { command: 'alpha-cmd' },
        },
        _claudian: {
          servers: {
            alpha: {
              disabledTools: [],
            },
          },
        },
      };

      const adapter = createMockAdapter({
        '.claude/mcp.json': JSON.stringify(config),
      });
      const storage = new McpStorage(adapter);
      const servers = await storage.load();

      expect(servers[0].disabledTools).toBeUndefined();
    });

    it('returns empty array on JSON parse error', async () => {
      const adapter = createMockAdapter({
        '.claude/mcp.json': 'invalid json{',
      });
      const storage = new McpStorage(adapter);

      const servers = await storage.load();
      expect(servers).toEqual([]);
    });
  });

  describe('save', () => {
    it('saves disabledTools to _claudian metadata', async () => {
      const adapter = createMockAdapter();
      const storage = new McpStorage(adapter);

      await storage.save([
        {
          name: 'alpha',
          config: { command: 'alpha-cmd' },
          enabled: true,
          contextSaving: true,
          disabledTools: ['tool_a', 'tool_b'],
        },
      ]);

      const saved = JSON.parse(adapter._store['.claude/mcp.json']);
      expect(saved._claudian.servers.alpha.disabledTools).toEqual(['tool_a', 'tool_b']);
    });

    it('trims and filters blank disabledTools on save', async () => {
      const adapter = createMockAdapter();
      const storage = new McpStorage(adapter);

      await storage.save([
        {
          name: 'alpha',
          config: { command: 'alpha-cmd' },
          enabled: true,
          contextSaving: true,
          disabledTools: ['  tool_a  ', '', '  ', 'tool_b'],
        },
      ]);

      const saved = JSON.parse(adapter._store['.claude/mcp.json']);
      expect(saved._claudian.servers.alpha.disabledTools).toEqual(['tool_a', 'tool_b']);
    });

    it('omits disabledTools from metadata when empty', async () => {
      const adapter = createMockAdapter();
      const storage = new McpStorage(adapter);

      await storage.save([
        {
          name: 'alpha',
          config: { command: 'alpha-cmd' },
          enabled: true,  // default
          contextSaving: true,  // default
          disabledTools: [],
        },
      ]);

      const saved = JSON.parse(adapter._store['.claude/mcp.json']);
      // No _claudian since all fields are default
      expect(saved._claudian).toBeUndefined();
    });

    it('preserves existing _claudian metadata when saving', async () => {
      const existing = {
        mcpServers: {
          alpha: { command: 'alpha-cmd' },
        },
        _claudian: {
          customField: 'should be preserved',
          servers: {
            alpha: { enabled: false },
          },
        },
      };

      const adapter = createMockAdapter({
        '.claude/mcp.json': JSON.stringify(existing),
      });
      const storage = new McpStorage(adapter);

      await storage.save([
        {
          name: 'alpha',
          config: { command: 'alpha-cmd' },
          enabled: true,
          contextSaving: true,
          disabledTools: ['tool_a'],
        },
      ]);

      const saved = JSON.parse(adapter._store['.claude/mcp.json']);
      expect(saved._claudian.customField).toBe('should be preserved');
      expect(saved._claudian.servers.alpha.disabledTools).toEqual(['tool_a']);
    });

    it('round-trips disabledTools correctly', async () => {
      const adapter = createMockAdapter();
      const storage = new McpStorage(adapter);

      const original = [
        {
          name: 'alpha',
          config: { command: 'alpha-cmd' },
          enabled: true,
          contextSaving: true,
          disabledTools: ['tool_a', 'tool_b'],
        },
        {
          name: 'beta',
          config: { command: 'beta-cmd' },
          enabled: false,
          contextSaving: false,
          disabledTools: undefined,
        },
      ];

      await storage.save(original);
      const loaded = await storage.load();

      expect(loaded).toHaveLength(2);
      expect(loaded[0]).toMatchObject({
        name: 'alpha',
        disabledTools: ['tool_a', 'tool_b'],
      });
      expect(loaded[1]).toMatchObject({
        name: 'beta',
        disabledTools: undefined,
      });
    });
  });
});
