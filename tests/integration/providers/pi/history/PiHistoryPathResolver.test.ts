import * as nodeFS from 'node:fs';
import * as nodeFSPromises from 'node:fs/promises';

import { createWindowsHostFS } from '@test/helpers/WindowsHostFS';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { resolvePiSessionFileHint } from '@/providers/pi/history/PiHistoryPathResolver';

vi.mock('node:fs', async () => ({ ...(await vi.importActual<typeof import('node:fs')>('node:fs')) }));
vi.mock('node:fs/promises', async () => ({ ...(await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')) }));

// Windows hosts have real drive paths and distro shares, so the modeled host only runs elsewhere.
const onWindows = process.platform === 'win32';

describe.skipIf(onWindows)('Pi WSL history trust', () => {
  const key = getInstallationKey();
  const context = {
    hostPlatform: 'win32' as const,
    config: { installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: { [key]: 'Ubuntu' } },
    environment: { HOME: 'C:\\Users\\host' },
  };
  const unc = (linuxPath: string, distro = 'Ubuntu') => `\\\\wsl$\\${distro}${linuxPath.replaceAll('/', '\\')}`;
  // A POSIX test host joins file names below a UNC root with '/', where Windows uses '\\'.
  const windowsPath = (file: string | null) => file?.replaceAll('/', '\\') ?? null;

  it.each(['wsl$', 'wsl.localhost'])('reads default Linux sessions through %s without using Windows HOME', async server => {
    const files = createWindowsHostFS({ fs: nodeFS, fsPromises: nodeFSPromises });
    const linuxPath = '/home/alice/.pi/agent/sessions/vault/id.jsonl';
    await files.write(files.fromLinux(linuxPath), '');
    await files.write(files.fromLinux(linuxPath, 'Debian'), '');
    const candidate = `\\\\${server}\\Ubuntu${linuxPath.replaceAll('/', '\\')}`;
    expect(resolvePiSessionFileHint(candidate, 'id', 'C:\\Vault', context)).toBe(unc(linuxPath));
    expect(resolvePiSessionFileHint(candidate.replace('Ubuntu', 'Debian'), 'id', 'C:\\Vault', context)).toBeNull();
  });

  it.each(['/tmp/rejected.jsonl', '/srv/sessions/missing.jsonl'])('does not replace explicit WSL locator %s with a same-ID peer', async candidate => {
    const files = createWindowsHostFS({ fs: nodeFS, fsPromises: nodeFSPromises });
    await files.write(files.fromLinux('/srv/sessions/same-id.jsonl'), '');
    await files.write(files.fromLinux('/tmp/rejected.jsonl'), '');
    const configured = { ...context, environment: { PI_CODING_AGENT_SESSION_DIR: '/srv/sessions' } };
    expect(windowsPath(resolvePiSessionFileHint(null, 'same-id', 'C:\\Vault', configured))).toBe(unc('/srv/sessions/same-id.jsonl'));
    expect(resolvePiSessionFileHint(candidate, 'same-id', 'C:\\Vault', configured)).toBeNull();
  });

  it('does not trust a previous Linux home after the configured HOME changes', async () => {
    const files = createWindowsHostFS({ fs: nodeFS, fsPromises: nodeFSPromises });
    for (const user of ['alice', 'bob']) await files.write(files.fromLinux(`/home/${user}/.pi/agent/sessions/vault/id.jsonl`), '');
    const current = { ...context, environment: { HOME: '/home/bob' }, environmentText: 'HOME=/home/bob' };
    expect(resolvePiSessionFileHint('/home/alice/.pi/agent/sessions/vault/id.jsonl', null, 'C:\\Vault', current)).toBeNull();
    expect(resolvePiSessionFileHint('/home/bob/.pi/agent/sessions/vault/id.jsonl', null, 'C:\\Vault', current))
      .toBe(unc('/home/bob/.pi/agent/sessions/vault/id.jsonl'));
    // Inherited Windows environment values are not forwarded as Linux HOME.
    expect(resolvePiSessionFileHint('/home/alice/.pi/agent/sessions/vault/id.jsonl', null, 'C:\\Vault', { ...current, environmentText: '' }))
      .toBe(unc('/home/alice/.pi/agent/sessions/vault/id.jsonl'));
  });

  it.each(['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR'])('stops trusting default-home locators when %s selects another store', async key => {
    const files = createWindowsHostFS({ fs: nodeFS, fsPromises: nodeFSPromises });
    await files.write(files.fromLinux('/home/alice/.pi/agent/sessions/vault/id.jsonl'), '');
    const locator = '/home/alice/.pi/agent/sessions/vault/id.jsonl';
    const home = { ...context, environment: { HOME: '/home/alice' }, environmentText: 'HOME=/home/alice' };
    expect(resolvePiSessionFileHint(locator, null, 'C:\\Vault', home)).toBe(unc(locator));
    expect(resolvePiSessionFileHint(locator, null, 'C:\\Vault', {
      ...home, environment: { ...home.environment, [key]: '/new-store' },
    })).toBeNull();
  });

  it.each([
    ['PI_CODING_AGENT_DIR', ' ~/.pi-work ', '/home/alice/.pi-work/sessions/id.jsonl', unc('/home/alice/.pi-work/sessions/id.jsonl')],
    ['PI_CODING_AGENT_DIR', '~', '/home/alice/sessions/id.jsonl', unc('/home/alice/sessions/id.jsonl')],
    ['PI_CODING_AGENT_SESSION_DIR', ' ~/sessions ', '/home/alice/sessions/id.jsonl', unc('/home/alice/sessions/id.jsonl')],
    ['PI_CODING_AGENT_SESSION_DIR', 'C:\\Sessions', '/mnt/c/Sessions/id.jsonl', 'C:\\Sessions\\id.jsonl'],
    ['PI_CODING_AGENT_SESSION_DIR', './sessions', '/mnt/c/Vault/sessions/id.jsonl', 'C:\\Vault\\sessions\\id.jsonl'],
    ['PI_CODING_AGENT_SESSION_DIR', 'file:///srv/sessions', '/srv/sessions/id.jsonl', unc('/srv/sessions/id.jsonl')],
  ])('resolves Pi directory syntax for %s=%s', async (key, value, candidate, expected) => {
    const files = createWindowsHostFS({ fs: nodeFS, fsPromises: nodeFSPromises });
    await files.write(files.fromLinux(candidate), '');
    const result = resolvePiSessionFileHint(candidate, null, 'C:\\Vault', {
      ...context, environment: { HOME: '/home/alice', [key]: value }, environmentText: `HOME=/home/alice\n${key}=${value}`,
    });
    expect(result).toBe(expected);
  });

  it.each([
    ['an agent directory outside its sessions folder', { PI_CODING_AGENT_DIR: '~/.pi-work' }, 'HOME=/home/alice', '/home/alice/.pi-work/other/id.jsonl'],
    ['a forwarded home outside its sessions folder', {}, 'HOME=/home/alice', '/home/alice/.pi/agent/other.jsonl'],
    ['a hinted home outside its sessions folder', {}, '', '/home/alice/.pi/agent/other.jsonl'],
    ['the vault outside its agent folder', {}, '', '/mnt/c/Vault/.pi/other/id.jsonl'],
    ['the vault outside its sessions folder', {}, '', '/mnt/c/Vault/.pi/agent/id.jsonl'],
  ])('rejects %s', async (_name, environment, environmentText, candidate) => {
    const files = createWindowsHostFS({ fs: nodeFS, fsPromises: nodeFSPromises });
    await files.write(files.fromLinux(candidate), '');
    expect(resolvePiSessionFileHint(candidate, null, 'C:\\Vault', {
      ...context, environment: { HOME: '/home/alice', ...environment }, environmentText,
    })).toBeNull();
  });

  it('trusts vault-local sessions and resolves IDs from every trusted root', async () => {
    const files = createWindowsHostFS({ fs: nodeFS, fsPromises: nodeFSPromises });
    await files.write(files.fromLinux('/mnt/c/Vault/.pi/agent/sessions/vault-id.jsonl'), '');
    await files.write(files.fromLinux('/home/alice/.pi/agent/sessions/home-id.jsonl'), '');
    const home = { ...context, environment: { HOME: '/home/alice' }, environmentText: 'HOME=/home/alice' };
    expect(resolvePiSessionFileHint('/mnt/c/Vault/.pi/agent/sessions/vault-id.jsonl', null, 'C:\\Vault', { ...context, environment: {} }))
      .toBe('C:\\Vault\\.pi\\agent\\sessions\\vault-id.jsonl');
    expect(windowsPath(resolvePiSessionFileHint(null, 'vault-id', 'C:\\Vault', home))).toBe('C:\\Vault\\.pi\\agent\\sessions\\vault-id.jsonl');
    expect(resolvePiSessionFileHint('/home/alice/.pi/agent/sessions/home-id.jsonl', null, null, home))
      .toBe(unc('/home/alice/.pi/agent/sessions/home-id.jsonl'));
  });

  it.each([
    ['forwarded', 'HOME=/home/alice', '/home/alice', true],
    ['inherited while another variable is forwarded', 'OTHER=1', '/home/alice', false],
    ['a network-style path', 'HOME=//srv/alice', '//srv/alice', false],
  ])('uses a %s Linux HOME for ID-only lookup only when Pi would see it', async (_name, environmentText, home, trusted) => {
    const files = createWindowsHostFS({ fs: nodeFS, fsPromises: nodeFSPromises });
    await files.write(files.fromLinux('/home/alice/.pi/agent/sessions/id.jsonl'), '');
    await files.write(files.fromLinux('/srv/alice/.pi/agent/sessions/id.jsonl'), '');
    const result = resolvePiSessionFileHint(null, 'id', 'C:\\Vault', { ...context, environment: { HOME: home }, environmentText });
    expect(windowsPath(result)).toBe(trusted ? unc('/home/alice/.pi/agent/sessions/id.jsonl') : null);
  });

  it.each([{}, { piConfig: { configDir: '' } }, { piConfig: { configDir: 7 } }])('keeps the default config directory for package metadata %j', async pkg => {
    const files = createWindowsHostFS({ fs: nodeFS, fsPromises: nodeFSPromises });
    await files.write(files.fromLinux('/home/alice/package/package.json'), JSON.stringify(pkg));
    await files.write(files.fromLinux('/home/alice/.pi/agent/sessions/id.jsonl'), '');
    expect(resolvePiSessionFileHint('/home/alice/.pi/agent/sessions/id.jsonl', null, 'C:\\Vault', {
      ...context, environment: { HOME: '/home/alice', PI_PACKAGE_DIR: '~/package' }, environmentText: 'HOME=/home/alice\nPI_PACKAGE_DIR=~/package',
    })).toBe(unc('/home/alice/.pi/agent/sessions/id.jsonl'));
  });

  it('resolves a tilde package directory before reading its custom config-directory name', async () => {
    const files = createWindowsHostFS({ fs: nodeFS, fsPromises: nodeFSPromises });
    await files.write(files.fromLinux('/home/alice/package/package.json'), JSON.stringify({ piConfig: { configDir: '.custom-pi' } }));
    await files.write(files.fromLinux('/home/alice/.custom-pi/agent/sessions/id.jsonl'), '');
    expect(resolvePiSessionFileHint('/home/alice/.custom-pi/agent/sessions/id.jsonl', null, 'C:\\Vault', {
      ...context, environment: { HOME: '/home/alice', PI_PACKAGE_DIR: ' ~/package ' }, environmentText: 'HOME=/home/alice\nPI_PACKAGE_DIR=~/package',
    })).toBe(unc('/home/alice/.custom-pi/agent/sessions/id.jsonl'));
  });

  it('rejects an ID-only session whose direct file is a symlink out of the configured store', async () => {
    const files = createWindowsHostFS({ fs: nodeFS, fsPromises: nodeFSPromises });
    await files.write(String.raw`C:\Sessions\control.jsonl`, '');
    await files.write(String.raw`C:\Elsewhere\linked.jsonl`, '');
    nodeFS.symlinkSync(files.local(String.raw`C:\Elsewhere\linked.jsonl`), files.local(String.raw`C:\Sessions\linked.jsonl`));
    // Containment resolves real paths only for host-flavored paths, which drive paths are on Windows.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    onTestFinished(() => { Object.defineProperty(process, 'platform', platform); });
    const configured = { ...context, environment: { PI_CODING_AGENT_SESSION_DIR: '/mnt/c/Sessions' } };
    expect(windowsPath(resolvePiSessionFileHint(null, 'control', 'C:\\Vault', configured))).toBe('C:\\Sessions\\control.jsonl');
    // The direct-ID lookup follows the link by name; only the resolved-path containment check rejects it.
    expect(resolvePiSessionFileHint(null, 'linked', 'C:\\Vault', configured)).toBeNull();
  });

  it('maps explicit Linux store roots and rejects case-different paths and traversal', async () => {
    const files = createWindowsHostFS({ fs: nodeFS, fsPromises: nodeFSPromises });
    for (const file of ['/srv/Sessions/id.jsonl', '/srv/secret.jsonl']) await files.write(files.fromLinux(file), '');
    const configured = { ...context, environment: { PI_CODING_AGENT_SESSION_DIR: '/srv/Sessions' } };
    expect(resolvePiSessionFileHint(' /srv/Sessions/id.jsonl ', null, 'C:\\Vault', configured)).toBe(unc('/srv/Sessions/id.jsonl'));
    expect(resolvePiSessionFileHint(null, ' /srv/Sessions/id.jsonl ', 'C:\\Vault', configured)).toBe(unc('/srv/Sessions/id.jsonl'));
    expect(resolvePiSessionFileHint('/srv/sessions/id.jsonl', null, 'C:\\Vault', configured)).toBeNull();
    // Linux roots are case-sensitive even though the host share compares them case-insensitively.
    const lowercaseRoot = { ...context, environment: { PI_CODING_AGENT_SESSION_DIR: '/srv/sessions' } };
    expect(resolvePiSessionFileHint('/srv/Sessions/id.jsonl', null, 'C:\\Vault', lowercaseRoot)).toBeNull();
    expect(resolvePiSessionFileHint('/srv/Sessions/../secret.jsonl', null, 'C:\\Vault', configured)).toBeNull();
  });
});
