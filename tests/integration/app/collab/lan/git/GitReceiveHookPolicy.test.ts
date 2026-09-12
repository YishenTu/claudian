import {
buildGitReceiveHookEnvironment
} from '@/app/collab/lan/git/GitReceiveHookPolicy';

describe('protected receive hook policy', () => {

  it('puts the exact Git directory first without passing an absolute path to the hook', () => {
    expect(buildGitReceiveHookEnvironment(
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Windows\\System32;C:\\Windows',
      'win32',
    )).toEqual({
      executable: 'git.exe',
      path: 'C:\\Program Files\\Git\\cmd;C:\\Windows\\System32;C:\\Windows',
    });
    expect(buildGitReceiveHookEnvironment(
      '/opt/custom/bin/custom-git',
      '/usr/local/bin:/usr/bin',
      'darwin',
    )).toEqual({
      executable: 'custom-git',
      path: '/opt/custom/bin:/usr/local/bin:/usr/bin',
    });
  });
});
