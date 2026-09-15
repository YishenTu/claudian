import {
  decodeLinkedContentPathFields,
  normalizeEscapedLinkedContentPath,
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

  // The canonicalizer is also fed ground-truth vault paths (TFile.path, vault
  // rename events, UI selections). A file or folder whose real, on-disk name
  // contains entity-shaped text must keep that exact name.
  it.each([
    'Calendar/Meetings/People &amp; Teams/note.md',
    'R&amp;D Team/note.md',
    'a &lt; b &gt; c.md',
    'A &quot;quoted&quot; name.md',
    'Notes/&#10;x.md',
  ])('keeps the literal vault name %p verbatim', (input) => {
    expect(normalizeLinkedContentPath(input)).toBe(input);
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

describe('XML-escaped vault paths (issue #1230)', () => {
  it.each([
    ['Calendar/Meetings/People &amp; Teams/note.md', 'Calendar/Meetings/People & Teams/note.md'],
    ['R&amp;D Team/note.md', 'R&D Team/note.md'],
    ['a &lt; b &gt; c.md', 'a < b > c.md'],
    ['A &quot;quoted&quot; name.md', 'A "quoted" name.md'],
  ])('repairs escaped path %p to %p', (input, expected) => {
    expect(normalizeEscapedLinkedContentPath(input)).toBe(expected);
  });

  it('decodes one level only', () => {
    expect(normalizeEscapedLinkedContentPath('a &amp;lt; b.md')).toBe('a &lt; b.md');
  });

  it('leaves raw ampersand paths untouched', () => {
    expect(normalizeEscapedLinkedContentPath('People & Teams/R&D/note.md'))
      .toBe('People & Teams/R&D/note.md');
  });

  it('flags escaped canonical paths for migration', () => {
    expect(decodeLinkedContentPathFields({
      linkedContentPath: 'People &amp; Teams/note.md',
    })).toEqual({
      path: 'People & Teams/note.md',
      needsMigration: true,
      source: 'canonical',
    });
  });

  it('flags escaped legacy paths for migration', () => {
    expect(decodeLinkedContentPathFields({ currentNote: 'R&amp;D/note.md' }))
      .toEqual({
        path: 'R&D/note.md',
        needsMigration: true,
        source: 'legacy',
      });
  });

  it('rejects escapes that decode to control characters', () => {
    expect(normalizeEscapedLinkedContentPath('Notes/&#10;x.md')).toBeNull();
    expect(normalizeEscapedLinkedContentPath('Notes/&#9;x.md')).toBeNull();
  });
});
