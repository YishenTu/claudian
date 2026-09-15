import {
  type FilesystemMentionEntry,
  FilesystemMentionSource,
} from '@/shared/composer-dropdown/FilesystemMentionSource';
import type { ComposerDropdownValueItem } from '@/shared/composer-dropdown/types';

const HOME = '/Users/alice';
const VAULT = '/Users/alice/Vault';

function expandHome(value: string): string {
  if (value === '~') return HOME;
  if (value.startsWith('~/')) return `${HOME}/${value.slice(2)}`;
  return value;
}

interface FakeFs {
  [dir: string]: FilesystemMentionEntry[];
}

function source(overrides: {
  fs?: FakeFs;
  enabled?: boolean;
  maxResults?: number;
  resolveBase?: () => string | null;
} = {}) {
  const fs: FakeFs = overrides.fs ?? {
    [HOME]: [
      { name: 'Documents', isDirectory: true },
      { name: '.hidden', isDirectory: true },
      { name: 'notes.md', isDirectory: false },
      { name: 'todo.txt', isDirectory: false },
    ],
    [`${HOME}/Documents`]: [
      { name: 'Projects', isDirectory: true },
      { name: 'resume.pdf', isDirectory: false },
    ],
  };
  return new FilesystemMentionSource({
    expandHome,
    isEnabled: () => overrides.enabled ?? true,
    maxResults: overrides.maxResults,
    readDirectory: async (dir) => fs[dir] ?? [],
    resolveBase: overrides.resolveBase ?? (() => VAULT),
  });
}

describe('FilesystemMentionSource', () => {
  it('only matches path-shaped queries and defers vault name lookups', () => {
    const value = source();
    expect(value.match('@/Users', 7)).toEqual(expect.objectContaining({ query: '/Users' }));
    expect(value.match('@~', 2)).toEqual(expect.objectContaining({ query: '~' }));
    expect(value.match('@notes', 6)).toBeNull();
    expect(value.match('@Alpha.md', 9)).toBeNull();
    expect(value.match('mail@/x', 7)).toBeNull();
  });

  it('matches relative queries when a vault base is available', () => {
    const value = source();
    expect(value.match('@./', 3)).toEqual(expect.objectContaining({ query: './' }));
    expect(value.match('@../', 4)).toEqual(expect.objectContaining({ query: '../' }));
    // With no base to resolve against, relative queries defer.
    const noBase = source({ resolveBase: () => null });
    expect(noBase.match('@../', 4)).toBeNull();
  });

  it('closes as soon as any space follows the path, and stays closed after it', () => {
    const value = source();
    // Any whitespace after the path terminates the mention: right after a
    // completed folder, and when the user keeps typing past the space.
    expect(value.match('@~/Workspace/ ', 14)).toBeNull();
    expect(value.match('@/Users/alice ', 14)).toBeNull();
    expect(value.match('@~/Workspace/ then', 18)).toBeNull();
    // Still active while the user is mid-path (no space yet).
    expect(value.match('@~/Workspace/', 13)).toEqual(
      expect.objectContaining({ query: '~/Workspace/' }),
    );
  });

  it('does not match when the feature is disabled', () => {
    const value = source({ enabled: false });
    expect(value.match('@/Users', 7)).toBeNull();
  });

  it('lists directories first, hides dotfiles, and offers only directly selectable entries', async () => {
    const value = source();
    const match = value.match('@~/', 3)!;
    const items = await value.load(match, new AbortController().signal);
    // Every entry is a directly selectable value item — no drill-down folders,
    // no "use this folder" affordance. Mirrors the vault mention source.
    expect(items.every((item) => item.kind === 'value')).toBe(true);
    expect(items.map((item) => item.label)).toEqual([
      `${HOME}/Documents/`,
      `${HOME}/notes.md`,
      `${HOME}/todo.txt`,
    ]);
  });

  it('selecting a directory inserts its path with a trailing slash and space', async () => {
    const value = source();
    const match = value.match('@~/', 3)!;
    const items = await value.load(match, new AbortController().signal);
    const folderItem = items.find(
      (item): item is ComposerDropdownValueItem =>
        item.kind === 'value' && item.label === `${HOME}/Documents/`,
    )!;
    expect(value.select(folderItem, match)).toEqual({
      kind: 'replace',
      text: `@${HOME}/Documents/ `,
    });
  });

  it('keeps browsing deeper as the user types the folder path', async () => {
    const value = source();
    const match = value.match('@~/Documents/', 13)!;
    const items = await value.load(match, new AbortController().signal);
    expect(items.map((item) => item.label)).toEqual([
      `${HOME}/Documents/Projects/`,
      `${HOME}/Documents/resume.pdf`,
    ]);
  });

  it('lists a home directory for "@~/" without dropping the trailing slash', async () => {
    const value = source();
    const match = value.match('@~/', 3)!;
    const items = await value.load(match, new AbortController().signal);
    // If the trailing slash were lost, this would instead list HOME's parent.
    expect(items.map((item) => item.label)).toContain(`${HOME}/Documents/`);
    expect(items.map((item) => item.label)).not.toContain(`${HOME}/`);
  });

  it('browses relative "./" against the vault base', async () => {
    const value = source({
      fs: {
        [VAULT]: [
          { name: 'src', isDirectory: true },
          { name: 'README.md', isDirectory: false },
        ],
      },
    });
    const match = value.match('@./', 3)!;
    const items = await value.load(match, new AbortController().signal);
    expect(items.map((item) => item.label)).toEqual([
      `${VAULT}/src/`,
      `${VAULT}/README.md`,
    ]);
  });

  it('browses relative "../" above the vault base', async () => {
    const parent = '/Users/alice';
    const value = source({
      fs: {
        [parent]: [
          { name: 'Vault', isDirectory: true },
          { name: 'Other', isDirectory: true },
        ],
      },
    });
    const match = value.match('@../', 4)!;
    const items = await value.load(match, new AbortController().signal);
    expect(items.map((item) => item.label)).toEqual([
      `${parent}/Other/`,
      `${parent}/Vault/`,
    ]);
  });

  it('reveals dotfiles when the filter starts with a dot', async () => {
    const value = source();
    const match = value.match('@~/.', 4)!;
    const items = await value.load(match, new AbortController().signal);
    expect(items.map((item) => item.label)).toEqual([`${HOME}/.hidden/`]);
  });

  it('filters by the trailing basename prefix', async () => {
    const value = source();
    const match = value.match('@~/no', 5)!;
    const items = await value.load(match, new AbortController().signal);
    expect(items.map((item) => item.label)).toEqual([`${HOME}/notes.md`]);
  });

  it('inserts an absolute path with a trailing space when selecting a file', async () => {
    const value = source();
    const match = value.match('@~/no', 5)!;
    const [item] = await value.load(match, new AbortController().signal);
    const fileItem = item as ComposerDropdownValueItem;
    expect(value.select(fileItem, match)).toEqual({
      kind: 'replace',
      text: `@${HOME}/notes.md `,
    });
  });

  it('caps results at maxResults', async () => {
    const many: FilesystemMentionEntry[] = Array.from({ length: 10 }, (_, i) => ({
      name: `file${i}.md`,
      isDirectory: false,
    }));
    const value = source({ fs: { [HOME]: many }, maxResults: 3 });
    const match = value.match('@~/', 3)!;
    const items = await value.load(match, new AbortController().signal);
    expect(items).toHaveLength(3);
  });
});
