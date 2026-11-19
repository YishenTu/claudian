import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

import { testTime } from '@test/helpers/testClock';
import { createWindowsHostFS } from '@test/helpers/WindowsHostFS';
import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import { getInstallationKey } from '@/core/device/InstallationKey';
import type { ProviderHistoryPathContext } from '@/core/providers/types';
import { AntigravityConversationHistoryService } from '@/providers/antigravity/history/AntigravityConversationHistoryService';

// `\\wsl$` UNC paths exist only on Windows hosts, so the host filesystem is the external boundary.
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof fs>() }));
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof fsPromises>() }));
vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => { Object.defineProperty(process, 'platform', platform); });

const SESSION_ID = 'native-session';
const LINUX_STORE = '/home/alice/.gemini/antigravity-cli';

describe.skipIf(path.sep === '\\')('Antigravity WSL history on a simulated Windows host', () => {
  it('reads the Linux transcript and uploads through the distro and presents Linux tool paths as host paths', async () => {
    const native = new WSLProcessFixture();
    native.environment = { HOME: '/home/alice' };
    vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const files = createWindowsHostFS({ fs, fsPromises });
    const brain = `${LINUX_STORE}/brain/${SESSION_ID}`;
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const upload = files.local(files.fromLinux(`${brain}/.user_uploaded/uploaded_media_1.png`));
    await fsPromises.mkdir(path.dirname(upload), { recursive: true });
    await fsPromises.writeFile(upload, png);
    // A Linux name may contain a backslash, which Windows reads as a separator: it must not escape the uploads.
    const outside = files.local(files.fromLinux(`${LINUX_STORE}/secret.png`));
    await fsPromises.writeFile(outside, png);
    const steps = [
      { content: '<USER_REQUEST>\nWhat is in notes?\n</USER_REQUEST>', created_at: testTime(), source: 'USER_EXPLICIT',
        status: 'DONE', step_index: 0, type: 'USER_INPUT',
        media: [
          { mime_type: 'image/png', uri: `file://${brain}/.user_uploaded/uploaded_media_1.png` },
          { mime_type: 'image/png', uri: `file://${brain}/.user_uploaded/..%5C..%5C..%5Csecret.png` },
        ] },
      { created_at: testTime({ seconds: 1 }), source: 'MODEL', status: 'DONE', step_index: 1, type: 'PLANNER_RESPONSE', tool_calls: [
        { name: 'read_file', args: { Path: '/mnt/c/vault/notes.md' } },
        { name: 'run_command', args: { CommandLine: 'ls', Cwd: '/mnt/c/vault', toolSummary: 'List' } },
      ] },
      { created_at: testTime({ seconds: 2 }), source: 'MODEL', status: 'DONE', step_index: 2, type: 'PLANNER_RESPONSE', content: 'Reply from Linux' },
    ];
    await files.write(files.fromLinux(`${brain}/.system_generated/logs/transcript_full.jsonl`),
      steps.map(step => JSON.stringify(step)).join('\n') + '\n');
    const key = getInstallationKey();
    const pathContext: ProviderHistoryPathContext = {
      config: { enabled: true, installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: { [key]: 'Ubuntu' } },
      // The Windows profile must not decide where the Linux agy keeps its store.
      environment: { USERPROFILE: 'C:\\Users\\alice', HOME: 'C:\\Users\\alice' },
      environmentText: '',
      hostPlatform: 'win32',
      vaultPath: 'C:\\vault',
    };
    const service = new AntigravityConversationHistoryService();

    const hydrated = await service.hydrateConversationHistory({ messages: [], sessionId: SESSION_ID }, 'C:\\vault', pathContext);

    expect(hydrated.messages?.map(message => message.content)).toEqual(['What is in notes?', 'Reply from Linux']);
    expect(hydrated.messages?.[0].images?.map(image => image.name)).toEqual(['uploaded_media_1.png']);
    expect(hydrated.messages?.[0].images?.[0].data).toBe(png.toString('base64'));
    expect(hydrated.messages?.[1].toolCalls?.map(tool => tool.input)).toEqual([
      expect.objectContaining({ file_path: 'C:\\vault\\notes.md' }),
      expect.objectContaining({ Cwd: 'C:\\vault' }),
    ]);
    await expect(service.readNativeHistoryRevision({ messages: [], sessionId: SESSION_ID }, 'C:\\vault', pathContext))
      .resolves.toEqual(expect.any(String));
    // The store comes from the Linux environment of the configured distro and vault cwd.
    expect(native.requests.map(request => [request.executable, request.argv.slice(1)])).toEqual([
      ['/usr/bin/awk', ['HOME']], ['/usr/bin/awk', ['HOME']],
    ]);
    expect(native.requests[0].args).toEqual(expect.arrayContaining(['--distribution', 'Ubuntu', '--cd', '/mnt/c/vault']));
  });

  it('never falls back to the Windows profile store when the Linux home cannot be determined', async () => {
    const native = new WSLProcessFixture();
    native.environment = {};
    vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const files = createWindowsHostFS({ fs, fsPromises });
    // A native Windows agy's transcript under the same id belongs to a different installation.
    await files.write(`C:\\Users\\alice\\.gemini\\antigravity-cli\\brain\\${SESSION_ID}\\.system_generated\\logs\\transcript_full.jsonl`,
      JSON.stringify({ content: '<USER_REQUEST>\nWindows\n</USER_REQUEST>', created_at: testTime(), source: 'USER_EXPLICIT',
        status: 'DONE', step_index: 0, type: 'USER_INPUT' }) + '\n');
    const key = getInstallationKey();
    const service = new AntigravityConversationHistoryService();
    const input = { messages: [], sessionId: SESSION_ID };

    const hydrated = await service.hydrateConversationHistory(input, 'C:\\vault', {
      config: { installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: { [key]: 'Ubuntu' } },
      environment: { USERPROFILE: 'C:\\Users\\alice' }, environmentText: '', hostPlatform: 'win32', vaultPath: 'C:\\vault',
    });

    expect(hydrated.messages).toEqual([]);
    expect(native.requests.map(request => request.executable)).toEqual(['/usr/bin/awk']);
  });

  it('reads no history, without failing, when the selected distro cannot address the vault', async () => {
    const native = new WSLProcessFixture();
    native.environment = { HOME: '/home/alice' };
    vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const key = getInstallationKey();
    const vault = '\\\\wsl$\\Debian\\vault';
    const service = new AntigravityConversationHistoryService();
    const input = { messages: [], sessionId: SESSION_ID };
    const pathContext: ProviderHistoryPathContext = {
      config: { installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: { [key]: 'Ubuntu' } },
      environment: {}, environmentText: '', hostPlatform: 'win32', vaultPath: vault,
    };

    await expect(service.hydrateConversationHistory(input, vault, pathContext)).resolves.toMatchObject({ messages: [] });
    await expect(service.readNativeHistoryRevision(input, vault, pathContext)).resolves.toBeNull();
    expect(native.requests).toEqual([]);
  });
});
