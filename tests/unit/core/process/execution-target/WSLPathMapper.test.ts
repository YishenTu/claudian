import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';

describe('createExecutionPathMapper', () => {
  it('maps Windows drive paths into /mnt paths for WSL targets', () => {
    const mapper = createExecutionPathMapper({
      method: 'wsl',
      platformFamily: 'unix',
      platformOs: 'linux',
      distroName: 'Ubuntu',
    });

    expect(mapper.toTargetPath('C:\\repo\\src')).toBe('/mnt/c/repo/src');
    expect(mapper.toHostPath('/mnt/c/repo/src')).toBe('C:\\repo\\src');
  });

  it('maps \\\\wsl$ paths into Linux paths for the selected distro', () => {
    const mapper = createExecutionPathMapper({
      method: 'wsl',
      platformFamily: 'unix',
      platformOs: 'linux',
      distroName: 'Ubuntu',
    });

    expect(mapper.toTargetPath('\\\\wsl$\\Ubuntu\\home\\user\\repo')).toBe('/home/user/repo');
    expect(mapper.toHostPath('/home/user/repo')).toBe('\\\\wsl$\\Ubuntu\\home\\user\\repo');
  });

  it('rejects \\\\wsl$ paths from a different distro', () => {
    const mapper = createExecutionPathMapper({
      method: 'wsl',
      platformFamily: 'unix',
      platformOs: 'linux',
      distroName: 'Ubuntu',
    });

    expect(mapper.toTargetPath('\\\\wsl$\\Debian\\home\\user\\repo')).toBeNull();
  });

  it('keeps host-native paths unchanged', () => {
    const target: ExecutionTarget = {
      method: 'host-native',
      platformFamily: 'unix',
      platformOs: 'macos',
    };
    const mapper = createExecutionPathMapper(target);

    expect(mapper.toTargetPath('/Users/example/repo')).toBe('/Users/example/repo');
    expect(mapper.toHostPath('/Users/example/repo')).toBe('/Users/example/repo');
  });
});
