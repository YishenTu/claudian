import { testDate } from '@test/helpers/testClock';
import type { TFile } from 'obsidian';

import { MentionSource } from '@/shared/composer-dropdown/MentionSource';

function file(path: string, mtime = 1): TFile {
  const name = path.split('/').pop() ?? path;
  return {
    basename: name.replace(/\.[^.]+$/, ''),
    extension: name.includes('.') ? name.split('.').pop() : '',
    name,
    path,
    stat: { ctime: mtime, mtime, size: 10 },
  } as TFile;
}

function source(overrides: Record<string, unknown> = {}) {
  const value = new MentionSource({
    getCachedVaultFiles: () => [file('notes/Alpha.md', 5)],
    getCachedVaultFolders: () => [{ name: 'notes', path: 'notes' }],
    normalizePathForVault: path => path ?? null,
    ...overrides,
  });
  return { source: value };
}

describe('MentionSource', () => {
  it('formats only retained suggestions while preserving file and folder ranking', async () => {
    const now = testDate().getTime();
    const files = Array.from({ length: 250 }, (_, index) => file(`folder${index % 60}/Note ${index}.md`, now + index + 1));
    const normalizePathForVault = jest.fn((path: string) => path);
    const { source: value } = source({
      getCachedVaultFiles: () => files,
      getCachedVaultFolders: () => Array.from({ length: 60 }, (_, index) => ({ name: `folder${index}`, path: `folder${index}` })),
      normalizePathForVault,
    });
    const items = await value.load(value.match('@', 1)!, new AbortController().signal);
    expect(items).toHaveLength(150);
    expect(items.slice(0, 2)).toEqual([
      expect.objectContaining({ id: 'vault-file:folder9/Note 249.md', replacement: '@folder9/Note 249.md ' }),
      expect.objectContaining({ id: 'vault-folder:folder9', replacement: '@folder9/ ' }),
    ]);
    expect(normalizePathForVault).toHaveBeenCalledTimes(150);
    files[0].stat.mtime = now + 1000;
    const updated = await value.load(value.match('@', 1)!, new AbortController().signal);
    expect(updated.slice(0, 2).map(item => item.id)).toEqual(['vault-file:folder0/Note 0.md', 'vault-folder:folder0']);
  });

  it('matches @ at a token boundary and preserves file names containing spaces', () => {
    const { source: value } = source();
    expect(value.match('Ask @Al', 7)).toEqual(expect.objectContaining({ query: 'Al' }));
    expect(value.match('mail@example', 12)).toBeNull();
    expect(value.match('@Alpha note', 11)).toEqual(expect.objectContaining({
      query: 'Alpha note',
    }));
    value.destroy();
  });

  it('lists and selects Vault files and folders', async () => {
    const { source: value } = source();
    const match = value.match('@alp', 4)!;
    const items = await value.load(match, new AbortController().signal);
    const fileItem = items.find(item => item.kind === 'value' && item.label === 'notes/Alpha.md');
    expect(fileItem).toEqual(expect.objectContaining({ replacement: '@notes/Alpha.md ' }));
    const action = value.select(fileItem as Extract<typeof fileItem, { kind: 'value' }>, match);
    expect(action).toEqual(expect.objectContaining({ kind: 'replace', text: '@notes/Alpha.md ' }));

    const rootItems = await value.load(value.match('@notes', 6)!, new AbortController().signal);
    expect(rootItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '@notes/' }),
    ]));
    value.destroy();
  });

  it('loads async extension folders without owning their feature semantics', async () => {
    const { source: value } = source();
    value.setExtensionFoldersLoader(async () => [{
      id: 'extension',
      kind: 'folder',
      label: "Member's Changes",
      load: () => [],
    }]);
    const items = await value.load(value.match('@member', 7)!, new AbortController().signal);
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'extension', label: "Member's Changes" }),
    ]));
    value.destroy();
  });

  it('keeps base mentions available when an optional extension fails', async () => {
    const { source: value } = source();
    value.setExtensionFoldersLoader(async () => {
      throw new Error('Reference source unavailable');
    });

    const items = await value.load(value.match('@alp', 4)!, new AbortController().signal);

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'notes/Alpha.md' }),
    ]));
    value.destroy();
  });

  it('resolves files inside a Vault Agents folder', async () => {
    const { source: value } = source({
      getCachedVaultFiles: () => [file('Agents/reviewer.md')],
      getCachedVaultFolders: () => [{ name: 'Agents', path: 'Agents' }],
    });
    const match = value.match('@Agents/rev', 11)!;
    const [item] = await value.load(match, new AbortController().signal);
    expect(item).toEqual(expect.objectContaining({
      kind: 'value', replacement: '@Agents/reviewer.md ',
    }));
    value.destroy();
  });
});
