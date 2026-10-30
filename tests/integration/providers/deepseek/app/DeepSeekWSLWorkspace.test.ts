import '@/providers';

import { NativePeer } from '@test/helpers/deepseek/NativePeer';
import { nativeRequest } from '@test/helpers/deepseek/NativeRequest';
import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { testDate } from '@test/helpers/testClock';
import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { ConversationPersistenceStore } from '@/app/storage/ConversationPersistenceStore';
import { getInstallationKey } from '@/core/device/InstallationKey';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { createClaudianAPI } from '@/features/chat/session-messaging/ClaudianAPI';
import { SessionMessagingService } from '@/features/chat/session-messaging/SessionMessagingService';
import { createDeepSeekWorkspaceServices } from '@/providers/deepseek/app/DeepSeekWorkspaceServices';
import { updateDeepSeekProviderSettings } from '@/providers/deepseek/settings';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const time = testDate().getTime();
const record = (seq: number, type: string, data: unknown) => ({ type: 'event', event: { type, seq, time: time + seq, data } });
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); });

/** A Windows workspace whose DeepSeek Host runs in WSL: the Linux probes reach the WSL process fixture, the Host is the shared peer. */
async function createWSLWorkspace(vaultPath: string, linuxEnvironment: Record<string, string | undefined>, onCall: NativePeer['onCall']) {
  const wsl = new WSLProcessFixture();
  wsl.environment = linuxEnvironment;
  vi.mocked(spawn).mockReset().mockImplementation(wsl.spawn);
  vi.stubEnv('SystemRoot', 'C:\\Windows');
  const peer = new NativePeer();
  peer.onCall = onCall;
  await peer.open();
  onTestFinished(() => peer.close());
  const key = getInstallationKey();
  const fixture = await createFeatureHostFixture({
    settings: { providerConfigs: { deepseek: { enabled: true, installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: { [key]: 'Ubuntu' } } } },
    providerOverrides: { workingDirectory: vaultPath },
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  const { start, lifecycle } = peer.process();
  const workspace = createDeepSeekWorkspaceServices(fixture.providerHost, start);
  ProviderWorkspaceRegistry.setServices('deepseek', workspace);
  onTestFinished(async () => { await workspace.dispose?.(); ProviderWorkspaceRegistry.setServices('deepseek', undefined); });
  const repository = new ConversationRepository({
    providers: ProviderRegistry, providerSettings: ProviderSettingsCoordinator,
    getSettings: () => fixture.settings, getVaultPath: () => vaultPath, onConversationDeleted: async () => undefined,
    persistence: new ConversationPersistenceStore(fixture.vault.files, fixture.storage.installationKey),
  });
  const host: ChatFeatureHost = await createChatFeatureHost({
    fixture, sessionRuntimes: createSessionRuntimePool(() => host),
    ensureConversationMetadataLoaded: async () => undefined,
    getConversationById: id => repository.getById(id),
  });
  const service = new SessionMessagingService({ getHost: () => host, getActiveConversationId: () => null, refreshModelControls: () => undefined });
  onTestFinished(() => service.dispose());
  return { wsl, peer, fixture, workspace, lifecycle, repository, api: createClaudianAPI(service) };
}

const state = (home: string) => ({ schemaVersion: 1, home, profile: 'web', preset: 'claudian' });

it.each([
  ['C:\\Vault', '/mnt/c/Vault', undefined, '\\\\wsl$\\Ubuntu\\home\\alice\\.dsh'],
  ['\\\\wsl$\\Ubuntu\\home\\alice\\Vault', '/home/alice/Vault', '/opt/dsh', '\\\\wsl$\\Ubuntu\\opt\\dsh'],
])('reads the Linux transcript through the plugin API from %s', async (vaultPath, targetCwd, configuredHome, home) => {
  const records = [
    // A tool record before any turn reaches the fallback mapper, which must still map its Linux path.
    record(0, 'tool/call', { callId: 'pre-turn-read', name: 'read', arguments: { path: `${targetCwd}/orphan.md` } }),
    record(1, 'turn/start', { turn: 1 }),
    record(2, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Question' }] }),
    record(3, 'tool/call', { callId: 'edit', name: 'edit', arguments: { path: `${targetCwd}/note.md` } }),
    record(4, 'tool/result', { message: { toolCallId: 'edit', content: [{ type: 'text', text: 'edited' }] }, meta: { diffs: [{ path: `${targetCwd}/note.md`, oldText: 'old', newText: 'new' }] } }),
    record(5, 'tool/call', { callId: 'spawn', name: 'subagent', arguments: { description: 'Review', prompt: 'check notes' } }),
    record(6, 'subagent/catalog', { childId: 'child', mode: 'one-shot', label: 'Review' }),
    record(7, 'tool/result', { message: { toolCallId: 'spawn', content: [{ type: 'text', text: 'started subagent child' }] } }),
    record(8, 'assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'Reply from Linux' }] } }),
    record(9, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
  const childRecords = [
    record(1, 'turn/start', { turn: 1 }),
    record(2, 'tool/call', { callId: 'read', name: 'read', arguments: { path: '/home/alice/notes.md' } }),
  ];
  const { wsl, peer, fixture, workspace, lifecycle, repository, api } = await createWSLWorkspace(vaultPath, { HOME: '/home/alice', DSH_HOME: configuredHome }, (method, args) => {
    if (method === 'session/list') return { items: [] };
    const request = nativeRequest(args);
    const child = request.sessionId === 'child' || request.address?.childSessionId === 'child';
    if (method === 'session/projections') return child ? { asOfSeq: 2, values: {} } : { asOfSeq: 9, values: { agentPreset: 'claudian' } };
    if (method === 'session/page') return { records: child ? childRecords : records, hasMore: false };
    throw new Error(`History activated ${method}`);
  });
  const homeProbes = () => wsl.requests.filter(request => request.executable === '/usr/bin/awk');
  repository.replaceAll([{ id: 'conversation', providerId: 'deepseek', sessionId: 'native-session', messages: [], title: 'WSL',
    providerState: state(home), createdAt: time, lastActivityAt: time,
  }]);
  expect(await api.read('conversation')).toBe('Reply from Linux');
  const tools = repository.getSync('conversation')?.messages.flatMap(message => message.toolCalls ?? []);
  expect(tools).toContainEqual(expect.objectContaining({ name: 'Edit', input: { file_path: `${vaultPath}\\note.md` }, diffData: expect.objectContaining({ filePath: `${vaultPath}\\note.md` }) }));
  expect(tools).toContainEqual(expect.objectContaining({ id: 'pre-turn-read', input: { file_path: `${vaultPath}\\orphan.md` } }));
  // Hydrated subagent transcripts map their Linux tool paths too.
  expect(tools?.find(tool => tool.id === 'spawn')?.subagent?.toolCalls).toMatchObject([{ id: 'read', input: { file_path: '\\\\wsl$\\Ubuntu\\home\\alice\\notes.md' } }]);
  // The Host launched in the distro with the Linux cwd and the store identity the saved conversation names.
  expect(lifecycle.launches).toHaveLength(1);
  expect(lifecycle.launches[0]).toMatchObject({ cliPath: 'dsh', cwd: vaultPath, execution: { targetCwd, home, target: { method: 'wsl', distroName: 'Ubuntu' } },
    sessionToolRelay: { command: POWERSHELL } });
  expect(homeProbes()).toHaveLength(1);
  expect(homeProbes()[0].args).toEqual(expect.arrayContaining(['--distribution', 'Ubuntu', '--cd', targetCwd]));
  // Boot probed the Linux home, then the session-tool relay's interop readiness, both once.
  expect(wsl.requests.map(request => request.executable)).toEqual(['/usr/bin/awk', POWERSHELL]);
  // Synchronous model/settings projections do not probe Linux home or start another process.
  workspace.modelCatalog.getSnapshot();
  workspace.cliResolver.resolveFromSettings(fixture.settings);
  expect(wsl.requests).toHaveLength(2);
  expect(lifecycle.starts).toBe(1);
  expect(peer.calls.every(call => ['session/list', 'session/projections', 'session/page'].includes(call.method))).toBe(true);
  // A transition discards the generation's resolved home, even with unchanged launch settings.
  await workspace.deepseek.beginTransition(); workspace.deepseek.endTransition();
  wsl.environment = { HOME: '/home/alice', DSH_HOME: '/changed/store' };
  expect(await workspace.deepseek.read(async (_reader, current) => current)).toBe('\\\\wsl$\\Ubuntu\\changed\\store');
  expect(homeProbes()).toHaveLength(2);
});

it('treats a drive-mounted Linux store case-sensitively for history, the skill catalog and archives', async () => {
  // DSH_HOME on /mnt/c maps to a drive path, which native Windows stores would compare case-insensitively.
  const { peer, workspace, fixture, repository, api } = await createWSLWorkspace('C:\\Vault', { HOME: '/home/alice', DSH_HOME: '/mnt/c/DeepSeek' }, method => {
    if (method === 'session/list') return { items: [
      { sessionId: 'host-cwd', agentAvailable: true, running: false, cwd: 'C:\\Vault', updatedAt: 3 },
      { sessionId: 'linux-cwd', agentAvailable: true, running: false, cwd: '/mnt/c/Vault', updatedAt: 2 },
    ] };
    if (method === 'session/projections') return { asOfSeq: 0, values: { agentPreset: 'claudian' } };
    if (method === 'skills/list') return { skills: [{ name: 'review', description: 'Review changes', modelInvocable: true }] };
    return { archivedSessionIds: [] };
  });
  // Prompts and side chats name the Linux working directory the Host runs in.
  expect(await ProviderRegistry.resolveExecutionWorkingDirectory(fixture.providerHost, 'deepseek', 'C:\\Vault')).toBe('/mnt/c/Vault');
  const variant = { sessionId: 'variant', providerState: state('C:\\deepseek'), messages: [] };
  const same = { sessionId: 'same', providerState: state('C:\\DeepSeek'), messages: [] };
  repository.replaceAll([{ id: 'variant', providerId: 'deepseek', ...variant, title: 'Variant', createdAt: time, lastActivityAt: time }]);
  await expect(api.read('variant')).rejects.toThrow(/different native store/);
  // A blank-tab catalog comes from a chat in this vault's Linux cwd, never from the other store's session id.
  const commands = await workspace.commandLoader!.loadCommands({ allowIsolatedMetadataCreation: true, conversation: repository.getSync('variant')!, plugin: fixture.providerHost });
  expect(commands).toMatchObject({ status: 'ready' });
  expect(peer.calls.filter(call => call.method === 'skills/list').map(call => nativeRequest(call.args).sessionId)).toEqual(['linux-cwd']);
  await workspace.sessionArchive!.setSessionsArchived([{ conversation: variant, isArchived: true }, { conversation: same, isArchived: true }]);
  expect(peer.calls.filter(call => call.method === 'workspace/archiveSession').map(call => nativeRequest(call.args).sessionId)).toEqual(['same']);
  // The next generation's Linux launch reserves the Linux shell tool although the plugin runs on Windows.
  await workspace.deepseek.beginTransition();
  updateDeepSeekProviderSettings(fixture.settings, { presetPlugins: '- id: tool-bash\n  name: custom-shell' });
  workspace.deepseek.endTransition();
  await expect(workspace.deepseek.read(async () => 'read')).rejects.toThrow(/already part of Claudian/);
});
