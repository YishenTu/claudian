import { NotifiedMutationError } from '@/core/storage/NotifiedMutationError';
import { McpSettingsManager } from '@/shared/settings/McpSettingsManager';

function createManager(overrides: Record<string, unknown> = {}) {
  const manager = Object.create(McpSettingsManager.prototype) as McpSettingsManager;
  Object.assign(manager, {
    mcpStorage: { save: jest.fn().mockResolvedValue(undefined) },
    broadcastMcpReload: jest.fn().mockResolvedValue(undefined),
    render: jest.fn(),
    servers: [],
    ...overrides,
  });
  return manager as unknown as {
    servers: Array<{ name: string; config: { command: string }; enabled: boolean; contextSaving: boolean }>;
    toggleServer: (server: unknown) => Promise<void>;
    saveServer: (server: unknown, existing: unknown) => Promise<void>;
  };
}

describe('McpSettingsManager persistence rollback', () => {
  it('restores a server enabled state when saving the toggle fails', async () => {
    const server = {
      name: 'alpha',
      config: { command: 'alpha' },
      enabled: true,
      contextSaving: true,
    };
    const manager = createManager({
      servers: [server],
      mcpStorage: { save: jest.fn().mockRejectedValue(new Error('write failed')) },
    });

    await expect(manager.toggleServer(server)).rejects.toThrow('write failed');

    expect(server.enabled).toBe(true);
  });

  it('restores the server list when adding a server fails', async () => {
    const manager = createManager({
      mcpStorage: {
        save: jest.fn().mockRejectedValue(new NotifiedMutationError('invalid JSON')),
      },
    });
    const server = {
      name: 'alpha',
      config: { command: 'alpha' },
      enabled: true,
      contextSaving: true,
    };

    await expect(manager.saveServer(server, null)).rejects.toThrow('invalid JSON');

    expect(manager.servers).toEqual([]);
  });
});
