// @test-ci {"native":true,"inputs":["tests/helpers/providers/opencode/OpencodeNativePeer.cjs"]}
import '@/providers';

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { writeOpencodeNativePeer } from '@test/helpers/providers/opencode/OpencodeNativePeer';
import { turn } from '@test/helpers/providers/opencode/OpencodeSharedServerFixture';
import { type OpencodeWSLPeerLaunch, routeOpencodeWSLPeer } from '@test/helpers/providers/opencode/OpencodeWSLPeer';
import { createWindowsHostFS } from '@test/helpers/WindowsHostFS';
import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import { getInstallationKey } from '@/core/device/InstallationKey';
import type { ProviderExecutionEvent } from '@/core/execution';
import { createOpencodeWorkspaceServices } from '@/providers/opencode/app/OpencodeWorkspaceServices';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import { resolveOpencodeTarget } from '@/providers/opencode/runtime/OpencodeExecutionTarget';

vi.mock('fs', async () => ({ ...await vi.importActual<typeof import('fs')>('fs') }));
vi.mock('fs/promises', async () => ({ ...await vi.importActual<typeof import('fs/promises')>('fs/promises') }));
vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const distro = '\\\\wsl$\\Ubuntu';
const toLinux = (value: string) => value.startsWith(distro) ? value.slice(distro.length).replaceAll('\\', '/') : value;
const hostPath = (linux: string) => distro + linux.replaceAll('/', '\\');

// Windows-shaped paths are real on a Windows host; WindowsHostFS refuses to shadow them there.
describe.skipIf(path.sep === '\\')('OpenCode sessions in a WSL distro', () => {
  let root: string;
  let launches: OpencodeWSLPeerLaunch[];
  afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  async function setup() {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-opencode-wsl-session-')));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'vault'));
    const peer = writeOpencodeNativePeer(path.join(root, 'opencode.cjs'), { scenario: 'workspace', version: '2.0.14' });
    const cli = '/opt/opencode/bin/opencode';
    const vault = hostPath(`${root}/vault`);
    // An explicit Linux config whose Windows plugin URL must reach the Linux process as a Linux URL.
    fs.mkdirSync(path.join(root, 'home', '.local', 'share', 'opencode'), { recursive: true });
    // The workspace peer keeps sessions beside its database without creating it, as OpencodeSharedServerFixture seeds it.
    fs.writeFileSync(path.join(root, 'home', '.local', 'share', 'opencode', 'opencode.db'), '');
    fs.writeFileSync(path.join(root, 'home', 'opencode.json'), JSON.stringify({ plugins: [{ package: 'file:///C:/Plugins/shared' }] }));
    const key = getInstallationKey();
    const app = await createProviderHostFixture({
      settings: { providerConfigs: { opencode: {
        enabled: true, visibleModels: ['local/chat'], environmentVariables: 'OPENCODE_CONFIG_CONTENT={}\nOPENCODE_CONFIG=~/opencode.json',
        installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: { [key]: 'Ubuntu' }, cliPathsByHost: { [key]: cli },
      } } },
      // The external lookup result: the WSL installation's configured Linux CLI.
      overrides: { workingDirectory: vault, getResolvedProviderCliPath: async () => cli },
    });
    const native = new WSLProcessFixture();
    // The Linux environment as WSL presents it, including the forwarded configured OPENCODE_CONFIG.
    native.environment = { HOME: `${root}/home`, OPENCODE_CONFIG: '~/opencode.json' };
    native.binaries.set(cli, { path: cli, version: 'opencode 2.0.14' });
    const translateDrive = native.translatePath;
    native.translatePath = value => value.startsWith(distro) ? toLinux(value) : translateDrive(value);
    launches = routeOpencodeWSLPeer(native, { command: cli, peer });
    vi.mocked(spawn).mockImplementation(native.spawn);
    // The distro's Linux tree is this real directory: the native peer reads its Linux paths directly,
    // and production reaches the same files through `\\wsl$`.
    const link = createWindowsHostFS({ fs, fsPromises }).local(hostPath(root));
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(root, link);
    // The session-tool relay locates Windows PowerShell through the Windows installation root.
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const workspace = await createOpencodeWorkspaceServices(app.host);
    onTestFinished(async () => { await workspace.dispose?.(); await app.dispose(); });
    const runtimeHost = app.host.getRuntimeHost('opencode');
    const session = new OpencodeExecutionBackend(runtimeHost, workspace).createSession({
      workingDirectory: vault, lifecycle: 'persistent', nativePersistence: 'provider-default',
      interactionPort: { requestApproval: async r => ({ interactionId: r.interactionId, decision: 'deny' }), askUserQuestion: async r => ({ interactionId: r.interactionId, answers: null }), dismissInteraction() {} },
    });
    onTestFinished(() => session.dispose());
    const createSession = (resumeSeed?: { providerSessionId: string; providerState: Record<string, unknown> }) => new OpencodeExecutionBackend(runtimeHost, workspace).createSession({
      ...(resumeSeed ? { resumeSeed } : {}),
      workingDirectory: vault, lifecycle: 'persistent', nativePersistence: 'provider-default',
      interactionPort: { requestApproval: async r => ({ interactionId: r.interactionId, decision: 'deny' }), askUserQuestion: async r => ({ interactionId: r.interactionId, answers: null }), dismissInteraction() {} },
    });
    return { cli, vault, native, workspace, runtimeHost, session, createSession };
  }

  it('loads the catalog, opens the session and maps live tool paths through the Linux server', async () => {
    const { cli, vault, native, workspace, runtimeHost, session, createSession } = await setup();
    // The prewarmed server is the one the catalog and the session share.
    await workspace.startRuntime?.();
    expect(launches).toHaveLength(1);
    await expect(workspace.metadataService.loadCatalog()).resolves.toBe(true);
    const output: ProviderExecutionEvent[] = [];
    let started!: () => void;
    const holding = new Promise<void>(resolve => { started = resolve; });
    const run = session.execute(turn('hold'));
    const done = (async () => {
      for await (const event of run.events) {
        output.push(event);
        if (event.type === 'text_delta' && event.text === 'hold') started();
      }
    })();
    await Promise.race([holding, done.then(() => { throw new Error('Native turn ended before the held output: ' + JSON.stringify(output)); })]);
    const target = await resolveOpencodeTarget(runtimeHost.config, vault);
    const environment = await workspace.serverService.targetEnvironment.resolve(target, vault, runtimeHost.environmentText, cli);
    const control = await workspace.serverService.acquire(cli, vault, environment, undefined, target);
    try {
      const sessionID = session.getSnapshot().providerSessionId;
      expect(await control.request(`/api/session/${sessionID}`)).toMatchObject({ data: { location: { directory: `${root}/vault` } } });
      expect(await control.request('/fixture/config')).toMatchObject({ data: { config: { plugins: expect.arrayContaining([{ package: 'file:///mnt/c/Plugins/shared' }]) } } });
      const event = (type: string, data: Record<string, unknown> = {}) => control.request('/fixture/event', {
        method: 'POST', body: { type, data: { sessionID, assistantMessageID: 'msg_main', ...data } },
      });
      await event('session.tool.input.started', { id: 'read', name: 'read' });
      await event('session.tool.called', { id: 'read', input: { filePath: '/home/alice/notes.md' }, executed: true });
      await event('session.tool.success', { id: 'read', content: [{ type: 'text', text: 'Notes body' }], executed: true });
      await event('session.tool.input.started', { id: 'edit', name: 'edit' });
      await event('session.tool.called', { id: 'edit', input: { filePath: '/mnt/c/Vault/note.md', oldString: 'before', newString: 'after' }, executed: true });
      await event('session.tool.success', { id: 'edit', content: [{ type: 'text', text: 'Edited' }], executed: true, metadata: { files: [{
        patch: '--- /mnt/c/Vault/note.md\n+++ /mnt/c/Vault/note.md\n@@ -1 +1 @@\n-before\n+after\n',
      }] } });
      // Native output that names the file only in metadata.
      await event('session.tool.input.started', { id: 'meta', name: 'edit' });
      await event('session.tool.called', { id: 'meta', input: { oldString: 'a', newString: 'b' }, executed: true });
      await event('session.tool.success', { id: 'meta', content: [{ type: 'text', text: 'Edited' }], executed: true, metadata: { filepath: '/mnt/c/Vault/other.md', files: [{
        patch: '--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b\n',
      }] } });
      await event('session.execution.succeeded');
      await done;
    } finally { await control.dispose(); }
    expect(output.flatMap(event => event.type === 'tool_started' ? [[event.name, event.input.file_path]] : [])).toEqual([
      ['Read', '\\\\wsl$\\Ubuntu\\home\\alice\\notes.md'], ['Edit', 'C:\\Vault\\note.md'], ['Edit', undefined],
    ]);
    expect(output.flatMap(event => event.type === 'tool_completed' && event.resultDetails?.diff ? [event.resultDetails.diff.filePath] : [])).toEqual(['C:\\Vault\\note.md', 'C:\\Vault\\other.md']);
    // The Linux database location is recorded as the host locator a later resume must open.
    expect(session.getSnapshot().providerState).toMatchObject({ databasePath: hostPath(`${root}/home/.local/share/opencode/opencode.db`) });
    // Probes and every server ran inside the configured distro at the Linux vault path, and session
    // tools reach the host through the Windows PowerShell relay rather than a Linux-unreachable URL.
    expect(launches.length).toBeGreaterThan(0);
    for (const launch of launches) {
      expect([launch.cwd, launch.env.OPENCODE_DB, launch.env.CLAUDIAN_SESSION_TOOLS_URL]).toEqual([`${root}/vault`, `${root}/home/.local/share/opencode/opencode.db`, undefined]);
      expect(JSON.parse(launch.env.CLAUDIAN_SESSION_TOOLS_RELAY ?? '{}')).toMatchObject({ command: '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' });
    }
    for (const request of native.requests) expect(request.args).toEqual(expect.arrayContaining(['--distribution', 'Ubuntu', '--cd', `${root}/vault`]));

    // The recorded host locator opens again for a resume through the same Linux database.
    const resumed = createSession({ providerSessionId: session.getSnapshot().providerSessionId!, providerState: session.getSnapshot().providerState ?? {} });
    onTestFinished(() => resumed.dispose());
    const resumedOutput: ProviderExecutionEvent[] = [];
    for await (const event of resumed.execute(turn('resumed')).events) resumedOutput.push(event);
    expect(resumedOutput.filter(event => event.type === 'execution_error')).toEqual([]);
    expect(resumed.getSnapshot().providerSessionId).toBe(session.getSnapshot().providerSessionId);
  });
});
