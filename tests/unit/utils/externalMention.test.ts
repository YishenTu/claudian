import {
  extractExternalMentionDirectories,
  isExternalMentionQuery,
  type PathKind,
  resolveExternalMentionDirectory,
} from '@/utils/externalMention';

const HOME = '/Users/alice';

function expandHome(value: string): string {
  if (value === '~') return HOME;
  if (value.startsWith('~/')) return `${HOME}/${value.slice(2)}`;
  return value;
}

/**
 * Fake filesystem: any path listed in `dirs` is a directory, any in `files` is a
 * file, everything else does not exist.
 */
function makeStat(dirs: string[], files: string[]) {
  const dirSet = new Set(dirs);
  const fileSet = new Set(files);
  return (absolutePath: string): PathKind => {
    if (dirSet.has(absolutePath)) return 'dir';
    if (fileSet.has(absolutePath)) return 'file';
    return null;
  };
}

describe('isExternalMentionQuery', () => {
  it('matches absolute, home, and Windows path shapes', () => {
    expect(isExternalMentionQuery('/Users/alice')).toBe(true);
    expect(isExternalMentionQuery('~')).toBe(true);
    expect(isExternalMentionQuery('~/Documents')).toBe(true);
    expect(isExternalMentionQuery('C:\\Users')).toBe(true);
    expect(isExternalMentionQuery('C:/Users')).toBe(true);
    expect(isExternalMentionQuery('\\\\server\\share')).toBe(true);
  });

  it('matches relative path shapes resolved against the vault', () => {
    expect(isExternalMentionQuery('.')).toBe(true);
    expect(isExternalMentionQuery('..')).toBe(true);
    expect(isExternalMentionQuery('./relative')).toBe(true);
    expect(isExternalMentionQuery('../sibling')).toBe(true);
    expect(isExternalMentionQuery('../../up/two')).toBe(true);
  });

  it('leaves ordinary vault name queries to the vault source', () => {
    expect(isExternalMentionQuery('')).toBe(false);
    expect(isExternalMentionQuery('notes')).toBe(false);
    expect(isExternalMentionQuery('notes/Alpha.md')).toBe(false);
    expect(isExternalMentionQuery('.hidden')).toBe(false);
  });
});

describe('resolveExternalMentionDirectory', () => {
  const deps = {
    expandHome,
    resolveBase: () => '/home/user/vault',
    statPath: makeStat(
      [
        '/Users', '/Users/alice', '/Users/alice/Documents', '/Users/alice/Documents/Projects',
        '/home', '/home/user', '/home/user/vault', '/home/user/vault/notes', '/home/user/shared',
      ],
      ['/Users/alice/Documents/notes.md', '/home/user/shared/data.csv'],
    ),
  };

  it('resolves the deepest existing directory of a path', () => {
    expect(resolveExternalMentionDirectory('~/Documents/Projects', deps))
      .toBe('/Users/alice/Documents/Projects');
  });

  it('resolves a file to its containing directory', () => {
    expect(resolveExternalMentionDirectory('/Users/alice/Documents/notes.md', deps))
      .toBe('/Users/alice/Documents');
  });

  it('stops at the deepest existing ancestor when the tail does not exist', () => {
    expect(resolveExternalMentionDirectory('/Users/alice/Documents/missing/deeper', deps))
      .toBe('/Users/alice/Documents');
  });

  it('ignores trailing prose glued onto the path', () => {
    expect(resolveExternalMentionDirectory('/Users/alice/Documents please summarize', deps))
      .toBe('/Users/alice');
  });

  it('resolves "./" against the vault base', () => {
    expect(resolveExternalMentionDirectory('./notes', deps)).toBe('/home/user/vault/notes');
  });

  it('resolves "../" above the vault base', () => {
    expect(resolveExternalMentionDirectory('../shared/data.csv', deps)).toBe('/home/user/shared');
  });

  it('returns null for a relative candidate when no base is available', () => {
    expect(resolveExternalMentionDirectory('./notes', { ...deps, resolveBase: () => null }))
      .toBeNull();
  });

  it('returns null for a bare name candidate', () => {
    expect(resolveExternalMentionDirectory('relative/path', deps)).toBeNull();
  });
});

describe('extractExternalMentionDirectories', () => {
  const deps = {
    expandHome,
    resolveBase: () => '/home/user/vault',
    statPath: makeStat(
      [
        '/Users', '/Users/alice', '/Users/alice/Documents', '/etc',
        '/home', '/home/user', '/home/user/vault', '/home/user/vault/sub',
      ],
      ['/Users/alice/Documents/notes.md', '/etc/hosts', '/home/user/vault/sub/a.md'],
    ),
  };

  it('collects unique directories from multiple mentions', () => {
    const text = 'Compare @/Users/alice/Documents/notes.md with @/etc/hosts';
    expect(extractExternalMentionDirectories(text, deps)).toEqual([
      '/Users/alice/Documents',
      '/etc',
    ]);
  });

  it('expands home-relative mentions', () => {
    expect(extractExternalMentionDirectories('read @~/Documents', deps)).toEqual([
      '/Users/alice/Documents',
    ]);
  });

  it('resolves relative mentions against the vault base', () => {
    expect(extractExternalMentionDirectories('open @./sub/a.md now', deps)).toEqual([
      '/home/user/vault/sub',
    ]);
    expect(extractExternalMentionDirectories('see @../ up', deps)).toEqual(['/home/user']);
  });

  it('ignores vault name @mentions and email-like tokens', () => {
    expect(extractExternalMentionDirectories('see @notes/Alpha.md or mail@example.com', deps))
      .toEqual([]);
  });

  it('deduplicates repeated directories', () => {
    const text = '@/etc/hosts and @/etc/hosts again';
    expect(extractExternalMentionDirectories(text, deps)).toEqual(['/etc']);
  });

  it('returns empty when there is no @', () => {
    expect(extractExternalMentionDirectories('nothing here', deps)).toEqual([]);
  });
});
