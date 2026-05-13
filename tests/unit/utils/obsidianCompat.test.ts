import type { Workspace, WorkspaceLeaf } from 'obsidian';

import { revealWorkspaceLeaf } from '@/utils/obsidianCompat';

describe('obsidianCompat', () => {
  describe('revealWorkspaceLeaf', () => {
    it('reveals the workspace leaf', async () => {
      const leaf = {} as WorkspaceLeaf;
      const workspace = {
        revealLeaf: jest.fn().mockResolvedValue(undefined),
      } as unknown as Workspace;

      await revealWorkspaceLeaf(workspace, leaf);

      expect((workspace as unknown as { revealLeaf: jest.Mock }).revealLeaf).toHaveBeenCalledWith(leaf);
    });
  });
});
