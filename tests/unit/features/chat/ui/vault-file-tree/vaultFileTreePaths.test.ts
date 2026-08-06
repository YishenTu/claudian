import {
  collectVaultFileTreePaths,
  isVisibleVaultPath,
  toVaultPath,
  type VaultFileTreeEntry,
} from '@/features/chat/ui/vault-file-tree/vaultFileTreePaths';

describe('vaultFileTreePaths', () => {
  it('keeps visible vault entries and gives folders Pierre directory identities', () => {
    const entries: VaultFileTreeEntry[] = [
      { kind: 'folder', path: '' },
      { kind: 'folder', path: '/' },
      { kind: 'folder', path: 'Projects' },
      { kind: 'file', path: 'Projects/Plan.md' },
      { kind: 'file', path: 'assets/diagram.canvas' },
      { kind: 'file', path: 'notes.v2.md' },
    ];

    expect(collectVaultFileTreePaths(entries)).toEqual([
      'Projects/',
      'Projects/Plan.md',
      'assets/diagram.canvas',
      'notes.v2.md',
    ]);
  });

  it('omits root and every path with a dot-prefixed segment', () => {
    expect(isVisibleVaultPath('')).toBe(false);
    expect(isVisibleVaultPath('/')).toBe(false);
    expect(isVisibleVaultPath('.obsidian/app.json')).toBe(false);
    expect(isVisibleVaultPath('Projects/.drafts/Plan.md')).toBe(false);
    expect(isVisibleVaultPath('Projects/.Plan.md')).toBe(false);
    expect(isVisibleVaultPath('Projects/Plan.v2.md')).toBe(true);
  });

  it('converts Pierre file and folder identities back to vault paths', () => {
    expect(toVaultPath('Projects/')).toBe('Projects');
    expect(toVaultPath('Projects/Plan.md')).toBe('Projects/Plan.md');
  });
});
