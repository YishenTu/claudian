import '@/providers';

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { testTime } from '@test/helpers/testClock';
import { createWindowsHostFS } from '@test/helpers/WindowsHostFS';
import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { encodeVaultPathForSDK } from '@/providers/claude/history/ClaudeHistoryPathResolver';

vi.mock('fs', async () => ({ ...await vi.importActual<typeof import('fs')>('fs') }));
vi.mock('fs/promises', async () => ({ ...await vi.importActual<typeof import('fs/promises')>('fs/promises') }));
vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const rows = (values: unknown[]) => values.map(value => JSON.stringify(value)).join('\n') + '\n';
const request = { providerSessionId: 'session-1', subagentId: 'worker', vaultPath: '' };

/** A subagent that reads one file at `filePath`, then answers. */
function sidecar(filePath: string) {
  return rows([
    { type: 'assistant', timestamp: testTime({ milliseconds: 0 }), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: filePath } },
    ] } },
    { type: 'user', timestamp: testTime({ milliseconds: 1000 }), message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'read-1', content: 'Note body' },
    ] } },
    { type: 'assistant', timestamp: testTime({ milliseconds: 2000 }), message: { role: 'assistant', content: [
      { type: 'text', text: 'Subagent answer' },
    ] } },
  ]);
}

async function createService(claude: Record<string, unknown>) {
  const { host } = await createProviderHostFixture({ vault: sharedVault, settings: { providerConfigs: { claude } } });
  const service = ProviderRegistry.createSubagentHistoryService(host, 'claude');
  if (!service) throw new Error('Claude registers a subagent history service');
  return service;
}

it('reads a configured native Claude directory from its real sidecar', async () => {
  const configDir = await fsPromises.mkdtemp(path.join(tmpdir(), 'claudian-claude-config-'));
  const vaultPath = await fsPromises.mkdtemp(path.join(tmpdir(), 'claudian-claude-vault-'));
  onTestFinished(async () => {
    await fsPromises.rm(configDir, { recursive: true, force: true });
    await fsPromises.rm(vaultPath, { recursive: true, force: true });
  });
  const file = path.join(configDir, 'projects', encodeVaultPathForSDK(vaultPath), 'session-1', 'subagents', 'agent-worker.jsonl');
  await fsPromises.mkdir(path.dirname(file), { recursive: true });
  await fsPromises.writeFile(file, sidecar(path.join(vaultPath, 'note.md')));
  const service = await createService({ environmentVariables: `CLAUDE_CONFIG_DIR=${configDir}` });

  await expect(service.loadToolCalls({ ...request, vaultPath })).resolves.toEqual([expect.objectContaining({
    id: 'read-1', name: 'Read', input: { file_path: path.join(vaultPath, 'note.md') }, status: 'completed', result: 'Note body',
  })]);
  await expect(service.loadFinalResult({ ...request, vaultPath })).resolves.toBe('Subagent answer');
});

// WindowsHostFS models Windows paths on POSIX hosts; on Windows they are real host paths.
it.skipIf(process.platform === 'win32')('resolves the Linux HOME before reading a WSL sidecar and maps its tool paths to the host', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.stubEnv('HOME', 'C:\\Users\\windows');
  onTestFinished(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); });
  const native = new WSLProcessFixture();
  native.environment = { HOME: '/home/linux-user' };
  vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
  const host = createWindowsHostFS({ fs, fsPromises });
  await host.write(
    '\\\\wsl$\\Ubuntu\\home\\linux-user\\.claude\\projects\\-mnt-c-Vault\\session-1\\subagents\\agent-worker.jsonl',
    sidecar('/mnt/c/Vault/note.md'),
  );
  const key = getInstallationKey();
  const service = await createService({ installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: { [key]: 'Ubuntu' } });

  await expect(service.loadToolCalls({ ...request, vaultPath: 'C:\\Vault' })).resolves.toEqual([expect.objectContaining({
    id: 'read-1', name: 'Read', input: { file_path: 'C:\\Vault\\note.md' }, status: 'completed', result: 'Note body',
  })]);
  await expect(service.loadFinalResult({ ...request, vaultPath: 'C:\\Vault' })).resolves.toBe('Subagent answer');
  // The Linux HOME comes from the distro, not the Windows environment.
  expect(native.requests.map(probe => probe.executable)).toContain('/usr/bin/awk');
});

let sharedVault: DesktopVault;
beforeAll(async () => { sharedVault = await DesktopVault.create(); });
afterAll(async () => { await sharedVault.dispose(); });
