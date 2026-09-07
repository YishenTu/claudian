import {
  decodeLinkedContentPathFields,
  normalizeLinkedContentPath,
} from '@/core/path/LinkedContentPath';

describe('normalizeLinkedContentPath', () => {
  it.each([
    ['Notes/Plan.md', 'Notes/Plan.md'],
    ['Notes\\Plan.md', 'Notes/Plan.md'],
    ['./Projects//Roadmap/./Draft.md/', 'Projects/Roadmap/Draft.md'],
    ['Missing/Future.md', 'Missing/Future.md'],
  ])('normalizes %p to %p', (input, expected) => {
    expect(normalizeLinkedContentPath(input)).toBe(expected);
  });

  it.each([
    '',
    '.',
    './',
    '/absolute/path',
    'C:\\Vault\\Note.md',
    '\\outside\\Note.md',
    '\\\\server\\share\\Note.md',
    '../escape.md',
    'Notes/../escape.md',
    'Notes/\u0000bad.md',
    'Notes/\u001fbad.md',
  ])('rejects unsafe path %p', (input) => {
    expect(normalizeLinkedContentPath(input)).toBeNull();
  });
});

describe('decodeLinkedContentPathFields', () => {
  it('prefers a valid canonical path over legacy', () => {
    expect(decodeLinkedContentPathFields({
      linkedContentPath: 'Projects/Current',
      currentNote: 'Notes/Legacy.md',
    })).toEqual({
      path: 'Projects/Current',
      needsMigration: true,
      source: 'canonical',
    });
  });

  it('fails closed when canonical is present but invalid', () => {
    expect(decodeLinkedContentPathFields({
      linkedContentPath: '../escape',
      currentNote: 'Notes/Legacy.md',
    })).toEqual({
      path: undefined,
      needsMigration: true,
      source: 'invalid',
    });
  });

  it('does not preserve the removed Vault root sentinel', () => {
    expect(decodeLinkedContentPathFields({ linkedContentPath: '.' })).toEqual({
      path: undefined,
      needsMigration: true,
      source: 'invalid',
    });
  });

  it('uses legacy only when canonical is absent', () => {
    expect(decodeLinkedContentPathFields({ currentNote: 'Notes\\Legacy.md' }))
      .toEqual({
        path: 'Notes/Legacy.md',
        needsMigration: true,
        source: 'legacy',
      });
  });

  it('omits invalid legacy paths and requests migration', () => {
    expect(decodeLinkedContentPathFields({ currentNote: '/outside.md' }))
      .toEqual({
        path: undefined,
        needsMigration: true,
        source: 'invalid',
      });
  });

  it('reports an absent target without migration', () => {
    expect(decodeLinkedContentPathFields({})).toEqual({
      path: undefined,
      needsMigration: false,
      source: 'absent',
    });
  });
});
