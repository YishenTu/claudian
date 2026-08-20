import {
  isCollabGitOid,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
} from '../src';

describe('Collab wire identifiers', () => {
  it.each([
    ['Project', isCollabProjectId, 'p', `p${'a'.repeat(63)}`],
    ['Member', isCollabMemberId, 'm', `m${'a'.repeat(63)}`],
    ['opaque', isCollabOpaqueId, 'o', `o${'a'.repeat(127)}`],
  ])('accepts the minimum and maximum %s ID', (_name, validate, minimum, maximum) => {
    expect(validate(minimum)).toBe(true);
    expect(validate(maximum)).toBe(true);
  });

  it.each([
    ['Project', isCollabProjectId, `p${'a'.repeat(64)}`],
    ['Member', isCollabMemberId, `m${'a'.repeat(64)}`],
    ['opaque', isCollabOpaqueId, `o${'a'.repeat(128)}`],
  ])('rejects malformed and oversized %s IDs', (_name, validate, oversized) => {
    for (const value of ['', '-leading', 'contains.dot', 'white space', 'é', oversized, null, 1]) {
      expect(validate(value)).toBe(false);
    }
  });

  it('accepts only lowercase SHA-1 and SHA-256 Git object IDs', () => {
    expect(isCollabGitOid('a'.repeat(40))).toBe(true);
    expect(isCollabGitOid('b'.repeat(64))).toBe(true);
    expect(isCollabGitOid('A'.repeat(40))).toBe(false);
    expect(isCollabGitOid('a'.repeat(39))).toBe(false);
    expect(isCollabGitOid('a'.repeat(65))).toBe(false);
    expect(isCollabGitOid(null)).toBe(false);
  });
});
