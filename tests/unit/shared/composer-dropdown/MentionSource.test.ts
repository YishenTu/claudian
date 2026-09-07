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
  const onAttachFile = jest.fn();
  const onAgentMentionSelect = jest.fn();
  const value = new MentionSource({
    getCachedVaultFiles: () => [file('notes/Alpha.md', 5)],
    getCachedVaultFolders: () => [{ name: 'notes', path: 'notes' }],
    getExternalContexts: () => [],
    normalizePathForVault: path => path ?? null,
    onAgentMentionSelect,
    onAttachFile,
    ...overrides,
  });
  return { onAgentMentionSelect, onAttachFile, source: value };
}

describe('MentionSource', () => {
  it('opts input-driven loads into debounce while keeping the source API otherwise unchanged', () => {
    const { source: value } = source();

    expect(value.inputLoadPolicy).toBe('debounced');

    value.destroy();
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

  it('lists Vault files and folders and preserves attachment side effects', async () => {
    const { onAttachFile, source: value } = source();
    const match = value.match('@alp', 4)!;
    const items = await value.load(match, new AbortController().signal);
    const fileItem = items.find(item => item.kind === 'value' && item.label === 'notes/Alpha.md');
    expect(fileItem).toEqual(expect.objectContaining({ replacement: '@notes/Alpha.md ' }));
    const action = value.select(fileItem as Extract<typeof fileItem, { kind: 'value' }>, match);
    if (action.kind === 'replace') action.onApplied?.();
    expect(onAttachFile).toHaveBeenCalledWith('notes/Alpha.md');

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
      throw new Error('Collab unavailable');
    });

    const items = await value.load(value.match('@alp', 4)!, new AbortController().signal);

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'notes/Alpha.md' }),
    ]));
    value.destroy();
  });

  it('loads and selects provider-neutral Agent mentions', async () => {
    const { onAgentMentionSelect, source: value } = source();
    value.setAgentService({
      ensureLoaded: jest.fn(async () => undefined),
      isLoaded: () => true,
      searchAgents: () => [{
        id: 'reviewer',
        name: 'reviewer',
        description: 'Review changes',
        source: 'vault',
      }],
    });
    const [folder] = await value.load(value.match('@Agents', 7)!, new AbortController().signal);
    expect(folder).toEqual(expect.objectContaining({ id: 'agents', kind: 'folder' }));
    const [agent] = await (folder as Extract<typeof folder, { kind: 'folder' }>)
      .load('', new AbortController().signal);
    const action = value.select(agent as Extract<typeof agent, { kind: 'value' }>, value.match('@', 1)!);
    if (action.kind === 'replace') action.onApplied?.();
    expect(onAgentMentionSelect).toHaveBeenCalledWith('reviewer');
    value.destroy();
  });
});
