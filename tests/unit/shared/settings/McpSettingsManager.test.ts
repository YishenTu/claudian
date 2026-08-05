import { Notice } from 'obsidian';

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
    importPastedConfig: (text: string) => Promise<boolean>;
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

describe('McpSettingsManager pasted configuration import', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('imports multiple servers from explicitly supplied text', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const manager = createManager({ mcpStorage: { save } });

    await expect(manager.importPastedConfig(JSON.stringify({
      alpha: { command: 'alpha' },
      beta: { command: 'beta' },
    }))).resolves.toBe(true);

    expect(manager.servers).toEqual([
      {
        name: 'alpha',
        config: { command: 'alpha' },
        enabled: true,
        contextSaving: true,
      },
      {
        name: 'beta',
        config: { command: 'beta' },
        enabled: true,
        contextSaving: true,
      },
    ]);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid supplied text without reading the system clipboard', async () => {
    const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const clipboardRead = jest.fn(() => {
      throw new Error('clipboard must not be read');
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: clipboardRead },
      writable: true,
    });

    try {
      const manager = createManager();

      await expect(manager.importPastedConfig('{ invalid json')).resolves.toBe(false);

      expect(clipboardRead).not.toHaveBeenCalled();
      expect(Notice).toHaveBeenCalledWith('No valid mcp configuration found');
    } finally {
      if (originalClipboardDescriptor) {
        Object.defineProperty(navigator, 'clipboard', originalClipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, 'clipboard');
      }
    }
  });

  it('rolls back a pasted multi-server import when persistence fails', async () => {
    const manager = createManager({
      mcpStorage: { save: jest.fn().mockRejectedValue(new Error('write failed')) },
    });

    await expect(manager.importPastedConfig(JSON.stringify({
      alpha: { command: 'alpha' },
      beta: { command: 'beta' },
    }))).resolves.toBe(false);

    expect(manager.servers).toEqual([]);
    expect(Notice).toHaveBeenCalledWith('write failed');
  });
});

describe('McpSettingsManager server previews', () => {
  it('shows argument boundaries for stdio paths containing spaces', () => {
    const manager = createManager() as unknown as {
      getServerPreview: (
        server: {
          name: string;
          config: { command: string; args: string[] };
          enabled: boolean;
          contextSaving: boolean;
        },
        type: 'stdio'
      ) => string;
    };
    const iCloudPath =
      '/Users/alice/Library/Mobile Documents/iCloud~md~obsidian/Documents/My Vault/server.js';

    const preview = manager.getServerPreview(
      {
        name: 'icloud-server',
        config: { command: 'node', args: [iCloudPath, '--verbose'] },
        enabled: true,
        contextSaving: false,
      },
      'stdio'
    );

    expect(preview).toBe(`node "${iCloudPath}" --verbose`);
  });
});
