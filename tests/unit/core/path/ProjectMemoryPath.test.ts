import { defaultProjectMemoryPath, normalizeProjectMemoryPath } from '@/core/path/ProjectMemoryPath';

describe('normalizeProjectMemoryPath', () => {
  it.each([
    ['Work/Projects/MEMORY.md', 'Work/Projects/MEMORY.md'],
    ['  Work\\Projects//Notes.md  ', 'Work/Projects/Notes.md'],
    ['/Work/MEMORY.md', 'Work/MEMORY.md'],
    ['./Work/./MEMORY.md', 'Work/MEMORY.md'],
    ['MEMORY.md', 'MEMORY.md'],
    ['Work/Notes.MD', 'Work/Notes.MD'],
    ['.claudian/projects/launch/MEMORY.md', '.claudian/projects/launch/MEMORY.md'],
  ])('normalizes %p to the vault-relative file %p', (input, expected) => {
    expect(normalizeProjectMemoryPath(input)).toBe(expected);
  });

  it.each([
    ['Work/MEMORY', 'Work/MEMORY.md'],
    ['Work/notes.txt', 'Work/notes.txt.md'],
    ['plan', 'plan.md'],
  ])('appends the missing .md extension to %p', (input, expected) => {
    expect(normalizeProjectMemoryPath(input)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    '/',
    '.',
    'Work/',
    'Work/.',
    'Work\\',
    '.md',
    'Work/.md',
    '../outside/MEMORY.md',
    'Work/../../outside.md',
    'C:/Docs/MEMORY.md',
    'C:\\Docs\\MEMORY.md',
    'C:MEMORY.md',
    '\\\\server\\share\\MEMORY.md',
    '//server/share/MEMORY.md',
    'Work/\u0007.md',
    'Work/what?.md',
    'Work/a:b.md',
    'Work/<plan>.md',
    'Wo|rk/plan.md',
    'Work/"plan".md',
    'Work/*.md',
  ])('rejects %p', (input) => {
    expect(normalizeProjectMemoryPath(input)).toBeNull();
  });
});

describe('defaultProjectMemoryPath', () => {
  it.each([
    ['Q3 Launch: Plan!', '.claudian/projects/q3-launch-plan/MEMORY.md'],
    ['  Équipe Été  ', '.claudian/projects/équipe-été/MEMORY.md'],
    ['', '.claudian/projects/project/MEMORY.md'],
    ['!!!', '.claudian/projects/project/MEMORY.md'],
    ['a'.repeat(80), `.claudian/projects/${'a'.repeat(48)}/MEMORY.md`],
  ])('derives the default for %p as %p', (name, expected) => {
    expect(defaultProjectMemoryPath(name)).toBe(expected);
    expect(normalizeProjectMemoryPath(expected)).toBe(expected);
  });
});
