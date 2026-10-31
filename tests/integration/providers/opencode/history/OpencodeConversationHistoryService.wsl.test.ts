// @test-ci {"native":true,"inputs":["tests/helpers/providers/opencode/OpencodeNativePeer.cjs"]}
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { seedFakeOpencodeSession } from '@test/helpers/providers/opencode/FakeOpencodeHistoryServer';
import { writeOpencodeNativePeer } from '@test/helpers/providers/opencode/OpencodeNativePeer';
import { type OpencodeWSLPeerLaunch, routeOpencodeWSLPeer } from '@test/helpers/providers/opencode/OpencodeWSLPeer';
import { createWindowsHostFS } from '@test/helpers/WindowsHostFS';
import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import { getInstallationKey } from '@/core/device/InstallationKey';
import type { ProviderHistoryInput, ProviderHistoryPathContext } from '@/core/providers/types';
import { OpencodeConversationHistoryService } from '@/providers/opencode/history/OpencodeConversationHistoryService';

vi.mock('fs', async () => ({ ...await vi.importActual<typeof import('fs')>('fs') }));
vi.mock('fs/promises', async () => ({ ...await vi.importActual<typeof import('fs/promises')>('fs/promises') }));
vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let native: WSLProcessFixture;
beforeEach(() => {
  native = new WSLProcessFixture();
  vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks(); });

function context(distro: string, cliPath = 'opencode'): ProviderHistoryPathContext {
  const key = getInstallationKey();
  return { vaultPath: 'C:\\Vault', environmentText: '', environment: {}, config: {
    installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: { [key]: distro }, cliPathsByHost: { [key]: cliPath },
  } };
}

it('hydrates a draft without probing or initializing WSL when no native history exists', async () => {
  const input: ProviderHistoryInput = { sessionId: null, messages: [], providerState: {} };
  const initialize = vi.fn(async () => undefined);
  const service = new OpencodeConversationHistoryService({ getServerService: initialize });
  await expect(service.hydrateConversationHistory(input, 'C:\\Vault', context('Unavailable'))).resolves.toEqual(input);
  expect(initialize).not.toHaveBeenCalled();
  expect(native.requests).toEqual([]);
});

it('keeps model recovery best-effort when the WSL environment cannot be read', async () => {
  // wsl.exe fails before running anything in a distro that is not installed.
  native.reply = () => ({ code: 1, stderr: 'There is no distribution with the supplied name.\r\n' });
  const databasePath = '\\\\wsl$\\Unavailable\\home\\alice\\.local\\share\\opencode\\opencode.db';
  const input: ProviderHistoryInput = { sessionId: 'native', messages: [], providerState: { databasePath } };
  await expect(new OpencodeConversationHistoryService().recoverConversationModelSelection(input, 'C:\\Vault', context('Unavailable'))).resolves.toBeNull();
  expect(input.providerState?.databasePath).toBe(databasePath);
  // The failure comes from the Linux environment probe in the configured distro, not an earlier guard.
  expect(native.requests.map(request => [request.executable, request.args[request.args.indexOf('--distribution') + 1]])).toEqual([['/usr/bin/awk', 'Unavailable']]);
});

// Windows-shaped paths are real on a Windows host; WindowsHostFS refuses to shadow them there.
describe.skipIf(path.sep === '\\')('native history in a WSL distro', () => {
  const distro = '\\\\wsl$\\Ubuntu';
  const toLinux = (value: string) => value.startsWith(distro) ? value.slice(distro.length).replaceAll('\\', '/') : value;
  const hostPath = (linux: string) => distro + linux.replaceAll('/', '\\');
  let root: string;
  let cli: string;
  let launches: OpencodeWSLPeerLaunch[];

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-opencode-wsl-history-')));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'vault'));
    const peer = writeOpencodeNativePeer(path.join(root, 'opencode.cjs'), { scenario: 'history', version: '2.0.12', forkId: 'ses_child' });
    // A Linux-only installation: the host cannot resolve this path, only the distro's `command -v` can.
    cli = '/opt/opencode/bin/opencode';
    native.environment = { HOME: `${root}/home` };
    native.binaries.set(cli, { path: cli, version: 'opencode 2.0.12' });
    launches = routeOpencodeWSLPeer(native, { command: cli, peer }, value => value.startsWith(distro) ? toLinux(value) : null);
    // The distro's Linux tree is this real directory: the native peer reads its Linux paths directly,
    // and production reaches the same files through `\\wsl$`.
    const link = createWindowsHostFS({ fs, fsPromises }).local(hostPath(root));
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(root, link);
  });

  it('reads, recovers and forks a Linux session through a WSL server with host tool paths', async () => {
    const databasePath = `${root}/home/.local/share/opencode/opencode.db`;
    seedFakeOpencodeSession(databasePath, 'ses_parent', { model: { providerID: 'deepseek', id: 'chat' }, messages: [
      { id: 'msg_user', type: 'user', time: { created: 1 }, text: 'Read notes' },
      { id: 'msg_answer', type: 'assistant', time: { created: 2 }, content: [
        { type: 'tool', id: 'call_read', name: 'read', state: { status: 'completed', input: { filePath: '/mnt/c/Vault/notes.md' }, content: [{ type: 'text', text: 'Notes body' }] } },
        { type: 'tool', id: 'call_home', name: 'read', state: { status: 'completed', input: { filePath: '/home/alice/notes.md' }, content: [{ type: 'text', text: 'Home body' }] } },
        { type: 'text', text: 'Native answer' },
      ] },
    ] });
    const vault = hostPath(`${root}/vault`);
    const pathContext = { ...context('Ubuntu', cli), vaultPath: vault };
    const recorded = hostPath(databasePath);
    const input: ProviderHistoryInput = { sessionId: 'ses_parent', messages: [], providerState: { databasePath: recorded } };
    const history = new OpencodeConversationHistoryService();

    await expect(history.recoverConversationModelSelection(input, vault, pathContext)).resolves.toBe('opencode:deepseek/chat');
    const hydrated = await history.hydrateConversationHistory(input, vault, pathContext);
    expect(hydrated.messages?.map(message => message.content)).toEqual(['Read notes', 'Native answer']);
    expect(hydrated.messages?.[1].toolCalls?.map(tool => [tool.name, tool.input.file_path])).toEqual([
      ['Read', 'C:\\Vault\\notes.md'], ['Read', '\\\\wsl$\\Ubuntu\\home\\alice\\notes.md'],
    ]);
    await expect(history.buildForkProviderState('ses_parent', 'msg_answer', { databasePath: recorded }, vault, pathContext, { lifecycle: 'persistent' }))
      .resolves.toMatchObject({ databasePath: recorded, sessionId: 'ses_child' });
    // Every server ran in the distro at the Linux vault path against the Linux database.
    expect(launches).toHaveLength(3);
    for (const launch of launches) expect([launch.cwd, launch.env.OPENCODE_DB]).toEqual([`${root}/vault`, databasePath]);
  });
});
