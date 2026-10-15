import { resolveContextFiles } from '@/features/inline-edit/ui/contextMentionResolver';

const files = (...paths: string[]) => paths.map(path => ({ path }));

describe('resolveContextFiles', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('resolves mentions at the start of the message or after whitespace only', () => {
    const vault = files('note.md', 'test.com');
    expect(resolveContextFiles('@note.md', vault)).toEqual(['note.md']);
    expect(resolveContextFiles('check\n@note.md', vault)).toEqual(['note.md']);
    expect(resolveContextFiles('email@test.com', vault)).toEqual([]);
  });

  it('prefers the longest Vault path and stops before trailing punctuation', () => {
    expect(resolveContextFiles('Check @src/my file.md, then continue', files('src/my', 'src/my file.md')))
      .toEqual(['src/my file.md']);
  });

  it('normalizes typed separators and leading ./ but returns the Vault path', () => {
    expect(resolveContextFiles('Use @./src\\folder//file.md/ please', files('src/folder/file.md')))
      .toEqual(['src/folder/file.md']);
  });

  it('matches case-insensitively only on Windows', () => {
    const vault = files('SRC/FILE.MD');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    expect(resolveContextFiles('@src/file.md', vault)).toEqual(['SRC/FILE.MD']);
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(resolveContextFiles('@src/file.md', vault)).toEqual([]);
  });

  it('deduplicates repeated mentions in first-seen order and ignores unknown paths', () => {
    expect(resolveContextFiles('@b.md @missing/path @a.md @b.md', files('a.md', 'b.md')))
      .toEqual(['b.md', 'a.md']);
  });
});
