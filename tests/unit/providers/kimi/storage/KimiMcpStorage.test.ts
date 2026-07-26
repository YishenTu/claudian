import { NotifiedMutationError } from '@/core/storage/NotifiedMutationError';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { ManagedMcpServer } from '@/core/types';
import {
  KIMI_MCP_CONFIG_PATH,
  KimiMcpStorage,
} from '@/providers/kimi/storage/KimiMcpStorage';

function createMockAdapter(files: Record<string, string> = {}): VaultFileAdapter {
  return {
    exists: jest.fn(async (targetPath: string) => targetPath in files),
    read: jest.fn(async (targetPath: string) => {
      if (!(targetPath in files)) {
        throw new Error(`File not found: ${targetPath}`);
      }
      return files[targetPath];
    }),
    write: jest.fn(async (targetPath: string, content: string) => {
      files[targetPath] = content;
    }),
  } as unknown as VaultFileAdapter;
}

const HAND_WRITTEN_CONFIG = JSON.stringify({
  mcpServers: {
    'local-tools': {
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { DEBUG: '1' },
      executor: 'kaos',
      cwd: '/opt/tools',
    },
    'remote-api': {
      url: 'https://example.com/mcp',
      bearerTokenEnvVar: 'REMOTE_TOKEN',
      enabled: false,
      disabledTools: ['dangerous_tool'],
    },
  },
  _claudian: {
    servers: {
      'local-tools': { contextSaving: false, description: 'Local helpers' },
    },
  },
  otherTopLevelKey: { keep: 'me' },
}, null, 2);

describe('KimiMcpStorage', () => {
  it('returns an empty list when the config file is missing or corrupt', async () => {
    expect(await new KimiMcpStorage(createMockAdapter({})).load()).toEqual([]);
    expect(await new KimiMcpStorage(createMockAdapter({
      [KIMI_MCP_CONFIG_PATH]: 'not json {',
    })).load()).toEqual([]);
    expect(await new KimiMcpStorage(createMockAdapter({
      [KIMI_MCP_CONFIG_PATH]: JSON.stringify({ mcpServers: 'nope' }),
    })).load()).toEqual([]);
  });

  it('translates kimi-native entries into managed servers', async () => {
    const storage = new KimiMcpStorage(createMockAdapter({
      [KIMI_MCP_CONFIG_PATH]: HAND_WRITTEN_CONFIG,
    }));

    expect(await storage.load()).toEqual([
      {
        name: 'local-tools',
        config: { command: 'node', args: ['server.js'], env: { DEBUG: '1' } },
        enabled: true,
        contextSaving: false,
        disabledTools: undefined,
        description: 'Local helpers',
      },
      {
        name: 'remote-api',
        config: { type: 'http', url: 'https://example.com/mcp' },
        enabled: false,
        contextSaving: true,
        disabledTools: ['dangerous_tool'],
        description: undefined,
      },
    ]);
  });

  it('maps explicit sse transport to the sse server type', async () => {
    const storage = new KimiMcpStorage(createMockAdapter({
      [KIMI_MCP_CONFIG_PATH]: JSON.stringify({
        mcpServers: {
          events: { transport: 'sse', url: 'https://example.com/sse', headers: { A: 'b' } },
        },
      }),
    }));

    expect(await storage.load()).toEqual([
      {
        name: 'events',
        config: { type: 'sse', url: 'https://example.com/sse', headers: { A: 'b' } },
        enabled: true,
        contextSaving: true,
        disabledTools: undefined,
        description: undefined,
      },
    ]);
  });

  it('round-trips while preserving hand-written and kimi-native fields', async () => {
    const files = { [KIMI_MCP_CONFIG_PATH]: HAND_WRITTEN_CONFIG };
    const storage = new KimiMcpStorage(createMockAdapter(files));

    const servers = await storage.load();
    await storage.save(servers);

    const written = JSON.parse(files[KIMI_MCP_CONFIG_PATH]);
    expect(written.otherTopLevelKey).toEqual({ keep: 'me' });
    expect(written.mcpServers['local-tools']).toEqual({
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { DEBUG: '1' },
      executor: 'kaos',
      cwd: '/opt/tools',
    });
    expect(written.mcpServers['remote-api']).toEqual({
      transport: 'http',
      url: 'https://example.com/mcp',
      bearerTokenEnvVar: 'REMOTE_TOKEN',
      enabled: false,
      disabledTools: ['dangerous_tool'],
    });
    expect(written._claudian.servers['local-tools']).toEqual({
      contextSaving: false,
      description: 'Local helpers',
    });
  });

  it('writes new servers in the kimi-native shape and drops variant keys on type change', async () => {
    const files = { [KIMI_MCP_CONFIG_PATH]: HAND_WRITTEN_CONFIG };
    const storage = new KimiMcpStorage(createMockAdapter(files));

    const servers: ManagedMcpServer[] = [
      {
        name: 'remote-api',
        config: { command: 'npx', args: ['-y', 'remote-mcp'] },
        enabled: true,
        contextSaving: true,
      },
      {
        name: 'fresh',
        config: { type: 'sse', url: 'https://example.com/sse' },
        enabled: false,
        contextSaving: false,
        disabledTools: ['old_tool'],
        description: 'Fresh server',
      },
    ];
    await storage.save(servers);

    const written = JSON.parse(files[KIMI_MCP_CONFIG_PATH]);
    // Variant switched from http to stdio: url/headers/bearerTokenEnvVar are gone,
    // but unrelated unknown fields would have survived.
    expect(written.mcpServers['remote-api']).toEqual({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'remote-mcp'],
    });
    expect(written.mcpServers.fresh).toEqual({
      transport: 'sse',
      url: 'https://example.com/sse',
      enabled: false,
      disabledTools: ['old_tool'],
    });
    expect(written._claudian.servers.fresh).toEqual({
      contextSaving: false,
      description: 'Fresh server',
    });
    // Removed servers are dropped from the managed map.
    expect(written.mcpServers['local-tools']).toBeUndefined();
  });

  it('creates the config file when saving into an empty vault', async () => {
    const files: Record<string, string> = {};
    const storage = new KimiMcpStorage(createMockAdapter(files));

    await storage.save([
      { name: 'solo', config: { command: 'run' }, enabled: true, contextSaving: true },
    ]);

    const written = JSON.parse(files[KIMI_MCP_CONFIG_PATH]);
    expect(written.mcpServers.solo).toEqual({ transport: 'stdio', command: 'run' });
    expect(written._claudian).toBeUndefined();
  });

  it('refuses to overwrite a corrupt config file', async () => {
    const storage = new KimiMcpStorage(createMockAdapter({
      [KIMI_MCP_CONFIG_PATH]: 'not json {',
    }));

    await expect(storage.save([
      { name: 'solo', config: { command: 'run' }, enabled: true, contextSaving: true },
    ])).rejects.toThrow(NotifiedMutationError);
  });
});
