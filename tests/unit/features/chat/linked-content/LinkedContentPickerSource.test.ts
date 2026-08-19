import { TFile, TFolder } from 'obsidian';

import { LinkedContentPickerSource } from '@/features/chat/linked-content/LinkedContentPickerSource';

function createFile(path: string): TFile {
  const file = new TFile();
  Object.assign(file, {
    path,
    name: path.split('/').pop() ?? '',
    basename: (path.split('/').pop() ?? '').replace(/\.[^.]+$/, ''),
    extension: path.split('.').pop() ?? '',
  });
  return file;
}

function createFolder(path: string): TFolder {
  const folder = new TFolder();
  Object.assign(folder, { path, name: path.split('/').pop() ?? '' });
  return folder;
}

describe('LinkedContentPickerSource', () => {
  it('synchronously combines None, visible folders, Markdown Notes, and other files', () => {
    const source = new LinkedContentPickerSource({
      getCachedVaultFiles: () => [
        createFile('Notes/Plan.md'),
        createFile('Assets/Plan.pdf'),
        createFile('.obsidian/workspace.json'),
      ],
      getCachedVaultFolders: () => [
        createFolder('Projects'),
        createFolder('Projects'),
        createFolder('.hidden'),
      ],
    });

    expect(source.list()).toEqual([
      expect.objectContaining({ kind: 'none', label: 'None', path: null }),
      expect.objectContaining({ kind: 'folder', label: 'Projects', detail: 'Projects' }),
      expect.objectContaining({ kind: 'file', label: 'Plan.pdf', detail: 'Assets/Plan.pdf' }),
      expect.objectContaining({ kind: 'file', label: 'Plan', detail: 'Notes/Plan.md' }),
    ]);
  });

  it('normalizes cached paths with the core codec and ignores invalid entries', () => {
    const source = new LinkedContentPickerSource({
      getCachedVaultFiles: () => [createFile('Notes\\Draft.md'), createFile('../outside.md')],
      getCachedVaultFolders: () => [],
    });

    const items = source.list();

    expect(items).toContainEqual(expect.objectContaining({ path: 'Notes/Draft.md' }));
    expect(items).not.toContainEqual(expect.objectContaining({ path: '../outside.md' }));
  });
});
