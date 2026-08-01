import type { App } from 'obsidian';

import type { ManagedMcpServer } from '@/core/types';
import { McpServerModal } from '@/shared/settings/McpServerModal';

describe('McpServerModal', () => {
  it('preserves iCloud paths as single arguments when an existing server is saved', () => {
    const iCloudPath =
      '/Users/alice/Library/Mobile Documents/iCloud~md~obsidian/Documents/My Vault/server.js';
    const existingServer: ManagedMcpServer = {
      name: 'icloud-server',
      config: {
        command: 'node',
        args: [iCloudPath, '--verbose'],
      },
      enabled: true,
      contextSaving: false,
    };
    const onSave = jest.fn();
    const modal = new McpServerModal({} as App, existingServer, onSave);
    const testModal = modal as unknown as {
      command: string;
      save(): void;
    };

    expect(testModal.command).toContain(`"${iCloudPath}"`);

    testModal.save();

    expect(onSave).toHaveBeenCalledWith(existingServer);
  });
});
