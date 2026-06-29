import {
  createWslPathMapper,
  inferWslDistroFromWindowsPath,
} from '@/utils/wslPathMapper';

describe('wslPathMapper', () => {
  const mapper = createWslPathMapper('Ubuntu');

  it('maps Windows drive paths in both directions', () => {
    expect(mapper.toWslPath('C:\\Vault\\Note.md')).toBe('/mnt/c/Vault/Note.md');
    expect(mapper.toHostPath('/mnt/c/Vault/Note.md')).toBe('C:\\Vault\\Note.md');
  });

  it('maps matching WSL UNC paths and rejects another distro', () => {
    expect(mapper.toWslPath('\\\\wsl$\\Ubuntu\\home\\tong\\vault')).toBe('/home/tong/vault');
    expect(mapper.toWslPath('\\\\wsl$\\Debian\\home\\tong\\vault')).toBeNull();
    expect(mapper.toHostPath('/home/tong/.claude')).toBe(
      '\\\\wsl$\\Ubuntu\\home\\tong\\.claude',
    );
  });

  it('infers a distro from a WSL UNC path', () => {
    expect(inferWslDistroFromWindowsPath('\\\\wsl$\\Ubuntu\\home\\tong')).toBe('Ubuntu');
    expect(inferWslDistroFromWindowsPath('C:\\Vault')).toBeUndefined();
  });
});
