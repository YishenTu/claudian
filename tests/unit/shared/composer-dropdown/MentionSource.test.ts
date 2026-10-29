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

function source(
  overrides: Record<string, unknown> = {},
  options: ConstructorParameters<typeof MentionSource>[1] = {},
) {
  const value = new MentionSource({
    getCachedVaultFiles: () => [file('notes/Alpha.md', 5)],
    getCachedVaultFolders: () => [{ name: 'notes', path: 'notes' }],
    ...overrides,
  }, options);
  return { source: value };
}

describe('MentionSource', () => {
  it('ranks a large matching vault with bounded comparison work', () => {
    const count = 4096;
    const files = Array.from({ length: count }, (_, index) =>
      file(`Note ${String((index * 2053) % count).padStart(4, '0')}.md`));
    const { source: value } = source({
      getCachedVaultFiles: () => files,
      getCachedVaultFolders: () => [],
    });
    const compare = vi.spyOn(String.prototype, 'localeCompare');
    let items;
    let comparisons;
    try {
      items = value.load(value.match('@Note', 5)!, new AbortController().signal);
      comparisons = compare.mock.calls.length;
    } finally {
      compare.mockRestore();
    }
    expect(items.map(item => item.id)).toEqual(Array.from({ length: 100 }, (_, index) =>
      `vault-file:Note ${String(index).padStart(4, '0')}.md`));
    // Ranking the retained 100 suggestions should not sort all 4096 matches.
    expect(comparisons).toBeLessThan(count * 3);
  });

  it('ranks ancestor folders by their newest descendant and reflects timestamp changes', () => {
    const files = [file('Projects/old/a.md', 5), file('Projects/new/deep/b.md', 10), file('Projects/new/c.md', 2)];
    const { source: value } = source({
      getCachedVaultFiles: () => files,
      getCachedVaultFolders: () => [
        { name: 'Projects', path: 'Projects/' },
        { name: 'new', path: 'Projects\\new/' },
        { name: 'old', path: 'Projects/old' },
        { name: 'empty', path: 'Projects/empty' },
      ],
    });
    const lookup = () => value.load(value.match('@new', 4)!, new AbortController().signal);
    expect(lookup().map(item => item.id)).toEqual([
      'vault-folder:Projects/new', 'vault-file:Projects/new/deep/b.md', 'vault-file:Projects/new/c.md',
    ]);
    const folders = value.load(value.match('@Projects', 9)!, new AbortController().signal)
      .filter(item => item.id.startsWith('vault-folder:'));
    expect(folders.map(item => item.id)).toEqual([
      'vault-folder:Projects', 'vault-folder:Projects/new', 'vault-folder:Projects/old', 'vault-folder:Projects/empty',
    ]);
    files[1].stat.mtime = 1;
    expect(lookup().map(item => item.id)).toEqual([
      'vault-folder:Projects/new', 'vault-file:Projects/new/c.md', 'vault-file:Projects/new/deep/b.md',
    ]);
  });

  it('formats only retained suggestions while preserving file and folder ranking', async () => {
    const now = testDate().getTime();
    const files = Array.from({ length: 250 }, (_, index) => file(`folder${index % 60}/Note ${index}.md`, now + index + 1));
    const formatVaultFileMention = vi.fn((path: string) => `@${path} `);
    const { source: value } = source({
      getCachedVaultFiles: () => files,
      getCachedVaultFolders: () => Array.from({ length: 60 }, (_, index) => ({ name: `folder${index}`, path: `folder${index}` })),
    }, { formatVaultFileMention });
    const items = await value.load(value.match('@', 1)!, new AbortController().signal);
    expect(items).toHaveLength(150);
    expect(items.slice(0, 2)).toEqual([
      expect.objectContaining({ id: 'vault-file:folder9/Note 249.md', replacement: '@folder9/Note 249.md ' }),
      expect.objectContaining({ id: 'vault-folder:folder9', replacement: '@folder9/ ' }),
    ]);
    expect(formatVaultFileMention).toHaveBeenCalledTimes(100);
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
    const completed = '@[A \\] B](claudian-session:conv-1-a) summarize this';
    expect(value.match(completed, completed.length)).toBeNull();
    expect(value.match(`${completed} @Al`, completed.length + 4)).toEqual(expect.objectContaining({ query: 'Al' }));
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

it('mixes opt-in sessions with files by prefix then recency, including the empty query', async () => {
  const now = testDate().getTime();
  const { source: value } = source({
    getCachedVaultFolders: () => [],
    getCachedVaultFiles: () => [file('Alpha.md', now)],
  }, {
    getSessionItems: () => [
      { id: 'session:1', kind: 'value', label: 'Alpha review', replacement: 'token ', mtime: now - 1 },
      { id: 'session:2', kind: 'value', label: 'Review Alpha', replacement: 'token2 ', mtime: now + 1 },
    ],
  });
  const signal = new AbortController().signal;
  expect((await value.load(value.match('@', 1)!, signal)).map(item => item.id))
    .toEqual(['session:2', 'vault-file:Alpha.md', 'session:1']);
  expect((await value.load(value.match('@Alpha', 6)!, signal)).map(item => item.id))
    .toEqual(['vault-file:Alpha.md', 'session:1', 'session:2']);
  expect(await value.load(value.match('@missing', 8)!, signal)).toEqual([]);
});
