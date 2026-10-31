import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import { getInstallationKey } from '@/core/device/InstallationKey';
import type { ClaudeConfigDirContext } from '@/providers/claude/config/ClaudeConfigDir';
import { claudeSettingsReconciler } from '@/providers/claude/env/ClaudeSettingsReconciler';
import { getClaudeHistoryContextForProjection, resolveClaudeHistoryContext } from '@/providers/claude/history/ClaudeHistoryContext';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const ubuntu = { method: 'wsl', distroName: 'Ubuntu', platformFamily: 'unix', platformOs: 'linux' } as const;
const vault = 'C:\\Vault';
const failure = 'Unable to resolve Claude Code configuration in the selected WSL distro';
let native: WSLProcessFixture;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  native = new WSLProcessFixture();
  native.environment = { HOME: '/home/linux-user' };
  vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
  // The store cache is module state: retire whatever an earlier test resolved.
  await resolveClaudeHistoryContext({ executionTarget: ubuntu, environment: { RESET: randomKey() } }, vault).catch(() => undefined);
  native.requests.length = 0;
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); });

let counter = 0;
const randomKey = () => `reset-${++counter}`;
const wslConfig = (distro = 'Ubuntu') => {
  const key = getInstallationKey();
  return { installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: { [key]: distro } };
};

describe('resolving the Linux store', () => {
  it('reads HOME, CLAUDE_CONFIG_DIR and TMPDIR in the distro and marks the context resolved', async () => {
    const resolved = await resolveClaudeHistoryContext({ executionTarget: ubuntu, environment: { KEEP: 'host' } }, vault);
    expect(resolved).toEqual({ executionTarget: ubuntu, vaultPath: vault, targetEnvironmentResolved: true,
      environment: { KEEP: 'host', HOME: '/home/linux-user', CLAUDE_CONFIG_DIR: '/home/linux-user/.claude', TMPDIR: '/tmp' } });
    native.environment = { HOME: '/home/linux-user', CLAUDE_CONFIG_DIR: '/srv/claude', TMPDIR: '/var/tmp' };
    expect((await resolveClaudeHistoryContext({ executionTarget: ubuntu, environment: { OTHER: '1' } }, vault))?.environment)
      .toMatchObject({ CLAUDE_CONFIG_DIR: '/srv/claude', TMPDIR: '/var/tmp' });
  });

  it('returns an already resolved or host-native context without probing', async () => {
    const resolved = await resolveClaudeHistoryContext({ executionTarget: ubuntu, environment: {} }, vault);
    native.requests.length = 0;
    expect(await resolveClaudeHistoryContext(resolved, vault)).toBe(resolved);
    const host = { config: { installationMethodsByHost: { [getInstallationKey()]: 'native-windows' } }, environment: {} };
    expect(await resolveClaudeHistoryContext(host, vault)).toBe(host);
    expect(native.requests).toHaveLength(0);
  });

  it.each([
    ['the probe fails', { HOME: '/home/linux-user' }, 127],
    ['HOME is missing', {}, 0],
    ['HOME is not a Linux path', { HOME: 'C:\\Users\\me' }, 0],
    ['TMPDIR is not a Linux path', { HOME: '/home/linux-user', TMPDIR: 'tmp' }, 0],
  ])('refuses to guess the store when %s', async (_case, environment: Record<string, string>, code) => {
    native.environment = environment;
    if (code) native.reply = request => request.executable === '/usr/bin/awk' ? { code } : undefined;
    await expect(resolveClaudeHistoryContext({ executionTarget: ubuntu, environment: {} }, vault)).rejects.toThrow(failure);
  });

  it('probes with the defined launch environment and forwards configured variables', async () => {
    await resolveClaudeHistoryContext({ executionTarget: ubuntu, environmentText: 'CUSTOM=1',
      environment: { CUSTOM: '1', UNSET: undefined } }, vault);
    const [probe] = native.requests;
    expect(probe.options.env).not.toHaveProperty('UNSET');
    expect(probe.options.env).toMatchObject({ CUSTOM: '1' });
    expect(String(probe.options.env?.WSLENV).split(':')).toContain('CUSTOM');
    expect(probe.options.cwd).toBe(vault);
  });
});

describe('synchronous projection', () => {
  it.each<[string, ClaudeConfigDirContext, boolean]>([
    ['an explicit WSL target', { executionTarget: ubuntu, environment: {} }, true],
    ['configured WSL on Windows', { config: wslConfig(), hostPlatform: 'win32', environment: {} }, true],
    ['configured WSL off Windows', { config: wslConfig(), hostPlatform: 'darwin', environment: {} }, false],
    ['native Windows', { config: { installationMethodsByHost: { [getInstallationKey()]: 'native-windows' } }, hostPlatform: 'win32', environment: {} }, false],
    ['an explicit host target despite WSL settings', { config: wslConfig(), executionTarget: { method: 'host-native', platformFamily: 'windows', platformOs: 'windows' }, hostPlatform: 'win32', environment: {} }, false],
  ])('withholds an unresolved store only for %s', (_case, context, unresolved) => {
    expect(getClaudeHistoryContextForProjection(context, vault)).toBe(unresolved ? null : context);
    expect(native.requests).toHaveLength(0);
  });

  it('returns a resolved context unchanged', async () => {
    const resolved = await resolveClaudeHistoryContext({ executionTarget: ubuntu, environment: {} }, vault);
    expect(getClaudeHistoryContextForProjection(resolved, vault)).toBe(resolved);
  });

  it('reuses the latest store only for identical inputs, ignoring environment order', async () => {
    const base: ClaudeConfigDirContext = { config: wslConfig(), hostPlatform: 'win32', environment: { A: '1', B: '2' } };
    const resolved = await resolveClaudeHistoryContext(base, vault);
    expect(getClaudeHistoryContextForProjection({ ...base, environment: { B: '2', A: '1' } }, vault)).toBe(resolved);
    expect(getClaudeHistoryContextForProjection({ ...base, environmentText: '' }, vault)).toBe(resolved);
    for (const changed of [
      { ...base, config: wslConfig('Debian') },
      { ...base, environment: { A: '1', B: '3' } },
      { ...base, environmentText: 'CLAUDE_CONFIG_DIR=/other' },
      { ...base, executionTarget: ubuntu, hostPlatform: 'linux' as const },
    ]) expect(getClaudeHistoryContextForProjection(changed, vault)).toBeNull();
    expect(getClaudeHistoryContextForProjection(base, 'D:\\Other')).toBeNull();
  });

  it('treats an omitted host platform as the current one when reusing the store', async () => {
    // Turn statistics omit hostPlatform; metadata projections supply the current platform.
    const omitted: ClaudeConfigDirContext = { config: wslConfig(), environment: { A: '1' } };
    const resolved = await resolveClaudeHistoryContext(omitted, vault);
    expect(getClaudeHistoryContextForProjection({ ...omitted, hostPlatform: 'win32' }, vault)).toBe(resolved);
  });

  it('keeps the store while the same inputs re-resolve, and a newer request retires it', async () => {
    const base: ClaudeConfigDirContext = { executionTarget: ubuntu, environment: { A: '1' } };
    const resolved = await resolveClaudeHistoryContext(base, vault);
    native.reply = () => ({ hold: true });
    const again = resolveClaudeHistoryContext(base, vault);
    await vi.waitFor(() => expect(native.requests).toHaveLength(2));
    expect(getClaudeHistoryContextForProjection(base, vault)).toEqual(resolved);
    native.requests[1].complete({ code: 127 });
    await expect(again).rejects.toThrow(failure);

    native.reply = undefined;
    await resolveClaudeHistoryContext(base, vault);
    native.environment = {};
    await expect(resolveClaudeHistoryContext({ ...base, environment: { A: '2' } }, vault)).rejects.toThrow(failure);
    expect(getClaudeHistoryContextForProjection(base, vault)).toBeNull();
  });

  it('forgets the store when Claude settings invalidate native sessions', async () => {
    // A configured CLI makes the runtime inputs fingerprinted, as in a real installation.
    const settings: { providerConfigs: { claude: Record<string, unknown> } } = { providerConfigs: { claude: { ...wslConfig(), cliPath: '/home/me/claude' } } };
    claudeSettingsReconciler.reconcileModelWithEnvironment(settings);
    const context = { config: wslConfig(), hostPlatform: 'win32' as const, environment: {} };
    await resolveClaudeHistoryContext(context, vault);
    expect(getClaudeHistoryContextForProjection(context, vault)).not.toBeNull();
    settings.providerConfigs.claude = { ...settings.providerConfigs.claude, environmentVariables: 'CLAUDE_CONFIG_DIR=/srv/claude' };
    expect(claudeSettingsReconciler.reconcileModelWithEnvironment(settings).sessionPolicy).toBe('invalidate');
    expect(getClaudeHistoryContextForProjection(context, vault)).toBeNull();
  });
});
