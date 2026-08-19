import {
  createProtectedReceiveHook,
  formatGitExecutableForReceiveHook,
} from '@/app/collab/lan/git/GitReceiveHookPolicy';

describe('protected receive hook policy', () => {
  it('is static and reads only Host-authenticated identity from the environment', () => {
    const hook = createProtectedReceiveHook();

    expect(hook).toContain('CLAUDIAN_COLLAB_MEMBER_REF');
    expect(hook).toContain('CLAUDIAN_COLLAB_GIT_EXECUTABLE');
    expect(hook).toContain('merge-base --is-ancestor');
    expect(hook).toContain('Protected ref update rejected.');
    expect(hook).not.toContain('member-alice');
    expect(hook).not.toContain('credential');
  });

  it('uses an MSYS-compatible executable path for Git for Windows hooks', () => {
    expect(formatGitExecutableForReceiveHook(
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'win32',
    )).toBe('C:/Program Files/Git/cmd/git.exe');
    expect(formatGitExecutableForReceiveHook('/usr/local/bin/git', 'darwin'))
      .toBe('/usr/local/bin/git');
  });
});
