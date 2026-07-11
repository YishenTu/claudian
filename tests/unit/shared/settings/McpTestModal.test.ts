import { Notice } from 'obsidian';

import { NotifiedMutationError } from '@/core/storage/NotifiedMutationError';
import { McpTestModal } from '@/shared/settings/McpTestModal';

describe('McpTestModal mutation failures', () => {
  it('rolls back without duplicating a storage-owned Notice', async () => {
    const modal = Object.create(McpTestModal.prototype) as McpTestModal;
    const checkbox = { checked: false, disabled: false } as HTMLInputElement;
    const container = { toggleClass: jest.fn() } as unknown as HTMLElement;
    Object.assign(modal, {
      disabledTools: new Set<string>(),
      onToolToggle: jest.fn().mockRejectedValue(
        new NotifiedMutationError(
          'Failed to update .claude/mcp.json because it contains invalid JSON.',
        ),
      ),
      toolElements: new Map([['alpha', {} as HTMLElement]]),
      updateToggleAllButton: jest.fn(),
      updateToolState: jest.fn(),
    });

    await (modal as unknown as {
      handleToolToggle: (
        toolName: string,
        checkbox: HTMLInputElement,
        container: HTMLElement,
      ) => Promise<void>;
    }).handleToolToggle('alpha', checkbox, container);

    expect(checkbox.checked).toBe(true);
    expect(Notice).not.toHaveBeenCalled();
  });
});
