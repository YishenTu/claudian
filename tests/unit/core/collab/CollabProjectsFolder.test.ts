import {
  DEFAULT_COLLAB_PROJECTS_FOLDER,
  parseCollabProjectsFolder,
} from '@/core/collab/CollabProjectsFolder';

describe('CollabProjectsFolder', () => {
  it('normalizes a nested portable Vault-relative folder', () => {
    expect(parseCollabProjectsFolder('  Shared/Collab Projects  ')).toEqual({
      ok: true,
      value: 'Shared/Collab Projects',
    });
    expect(parseCollabProjectsFolder('Cafe\u0301')).toEqual({
      ok: true,
      value: 'Caf\u00e9',
    });
    expect(DEFAULT_COLLAB_PROJECTS_FOLDER).toBe('workspace');
  });

  it.each([
    ['', 'empty'],
    ['/', 'absolute'],
    ['/workspace', 'absolute'],
    ['C:/workspace', 'windows-absolute'],
    ['workspace\\nested', 'separator'],
    ['workspace//nested', 'empty-segment'],
    ['workspace/./nested', 'dot-segment'],
    ['workspace/../nested', 'dot-segment'],
    ['workspace/<bad>', 'windows-invalid'],
    ['workspace/name.', 'windows-invalid'],
    ['workspace/name /nested', 'windows-invalid'],
    ['workspace/CON', 'windows-reserved'],
    ['workspace/COM¹.md', 'windows-reserved-superscript'],
    ['workspace/LPT²', 'windows-reserved-superscript'],
    ['workspace/.git', 'reserved-directory'],
    ['workspace/.claudian', 'reserved-directory'],
    ['workspace/.obsidian', 'reserved-directory'],
    ['workspace/control\u0001', 'control-character'],
  ])('rejects %s (%s)', (raw) => {
    expect(parseCollabProjectsFolder(raw)).toEqual(expect.objectContaining({
      ok: false,
    }));
  });

  it('rejects the active Obsidian configuration directory', () => {
    expect(parseCollabProjectsFolder('Shared/.vault-config/Projects', {
      obsidianConfigDirectory: '.vault-config',
    })).toEqual(expect.objectContaining({ ok: false }));
  });

  it('rejects oversized segments and complete paths', () => {
    expect(parseCollabProjectsFolder(`workspace/${'a'.repeat(121)}`))
      .toEqual(expect.objectContaining({ ok: false }));
    expect(parseCollabProjectsFolder(`${'a'.repeat(100)}/${'b'.repeat(75)}`))
      .toEqual(expect.objectContaining({ ok: false }));
  });
});
