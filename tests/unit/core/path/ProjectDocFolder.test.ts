import { normalizeProjectDocFolder, projectDocFolderOf } from '@/core/path/ProjectDocFolder';

describe('normalizeProjectDocFolder', () => {
  it.each([
    ['Work\\Projects//Docs/', 'Work/Projects/Docs'],
    ['  Docs/Projects  ', 'Docs/Projects'],
    ['/Docs', 'Docs'],
    ['Docs/./Plans', 'Docs/Plans'],
    ['', ''],
    ['  ', ''],
    ['/', ''],
    ['.', ''],
    ['./', ''],
  ])('normalizes %p to the vault-relative folder %p (empty is the vault root)', (input, expected) => {
    expect(normalizeProjectDocFolder(input)).toBe(expected);
  });

  it.each(['../outside', 'Docs/../../outside', 'C:/Docs', 'C:\\Docs', '\\\\server\\share', 'Docs/\u0007'])(
    'rejects %p instead of falling back to another folder',
    (input) => {
      expect(normalizeProjectDocFolder(input)).toBeNull();
    },
  );
});

describe('projectDocFolderOf', () => {
  it.each([
    ['.claudian/projects/launch-1234abcd.md', '.claudian/projects'],
    ['Work/launch.md', 'Work'],
    ['launch.md', ''],
  ])('reads the folder of %p as %p', (docPath, expected) => {
    expect(projectDocFolderOf(docPath)).toBe(expected);
  });
});
