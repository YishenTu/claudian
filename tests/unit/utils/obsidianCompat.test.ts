import type { Workspace, WorkspaceLeaf } from 'obsidian';

import { focusWorkspaceLeaf } from '@/utils/obsidianCompat';

describe('obsidianCompat', () => {
  describe('focusWorkspaceLeaf', () => {
    it('uses revealLeaf when the workspace supports it', () => {
      const leaf = {} as WorkspaceLeaf;
      const workspace = {
        revealLeaf: jest.fn(),
        setActiveLeaf: jest.fn(),
      } as unknown as Workspace;

      focusWorkspaceLeaf(workspace, leaf);

      expect((workspace as unknown as { revealLeaf: jest.Mock }).revealLeaf).toHaveBeenCalledWith(leaf);
      expect(workspace.setActiveLeaf).not.toHaveBeenCalled();
    });

    it('falls back to setActiveLeaf for older Obsidian versions', () => {
      const leaf = {} as WorkspaceLeaf;
      const workspace = {
        setActiveLeaf: jest.fn(),
      } as unknown as Workspace;

      focusWorkspaceLeaf(workspace, leaf);

      expect(workspace.setActiveLeaf).toHaveBeenCalledWith(leaf, { focus: true });
    });
  });
});
