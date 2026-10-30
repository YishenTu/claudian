import '@/providers';

import { NativePeer } from '@test/helpers/deepseek/NativePeer';
import { withRuntimeHosts } from '@test/helpers/providerRuntimeHost';
import { testDate } from '@test/helpers/testClock';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import type { ConversationPersistence } from '@/app/storage/ConversationPersistenceStore';
import { getInstallationKey } from '@/core/device/InstallationKey';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import { runProcessProbe } from '@/core/process/ProcessProbe';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { Conversation } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { createClaudianAPI } from '@/features/chat/session-messaging/ClaudianAPI';
import { SessionMessagingService } from '@/features/chat/session-messaging/SessionMessagingService';
import { createDeepSeekWorkspaceServices } from '@/providers/deepseek/app/DeepSeekWorkspaceServices';

vi.mock('@/core/process/ProcessProbe', () => ({ runProcessProbe: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); });

it.each([
  ['C:\\Vault', '/mnt/c/Vault', undefined, '\\\\wsl$\\Ubuntu\\home\\alice\\.dsh'],
  ['\\\\wsl$\\Ubuntu\\home\\alice\\Vault', '/home/alice/Vault', '/opt/dsh', '\\\\wsl$\\Ubuntu\\opt\\dsh'],
])('reads the Linux transcript through the plugin API from %s', async (vaultPath, targetCwd, configuredHome, home) => {
  vi.stubGlobal('process', { ...process, platform: 'win32' });
  vi.mocked(runProcessProbe).mockClear().mockResolvedValue(`x\0/home/alice\0${configuredHome ? `x\0${configuredHome}\0` : '\0\0'}`);
  const time = testDate().getTime();
  const record = (seq: number, type: string, data: unknown) => ({ type: 'event', event: { type, seq, time: time + seq, data } });
  const records = [
    record(1, 'turn/start', { turn: 1 }),
    record(2, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Question' }] }),
    record(3, 'tool/call', { callId: 'edit', name: 'edit', arguments: { path: `${targetCwd}/note.md` } }),
    record(4, 'tool/result', { message: { toolCallId: 'edit', content: [{ type: 'text', text: 'edited' }] }, meta: { diffs: [{ path: `${targetCwd}/note.md`, oldText: 'old', newText: 'new' }] } }),
    record(5, 'assistant/message', { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'Reply from Linux' }] } }),
    record(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ];
  const peer = new NativePeer();
  peer.onCall = method => {
    if (method === 'session/list') return { items: [] };
    if (method === 'session/projections') return { asOfSeq: 6, values: { agentPreset: 'claudian' } };
    if (method === 'session/page') return { records, hasMore: false };
    throw new Error(`History activated ${method}`);
  };
  await peer.open();
  const settings = { providerConfigs: { deepseek: { enabled: true,
    installationMethodsByHost: { [getInstallationKey()]: 'wsl' },
    wslDistroOverridesByHost: { [getInstallationKey()]: 'Ubuntu' },
  } } };
  const lifecycle = new ProviderExecutionLifecycleRegistry();
  const host = withRuntimeHosts({ settings, workingDirectory: vaultPath, executionLifecycleRegistry: lifecycle });
  const start = vi.fn(async () => {
    const client = await peer.connect();
    return { profile: 'web' as const, client, onExit: () => () => {}, dispose: async () => client.dispose(),
      writePrompt: async () => {}, removePrompt: async () => {}, writeCodeMode: async () => {},
      readEphemeralReady: async () => false, offerEphemeralFork: async () => async () => {},
    };
  });
  const workspace = createDeepSeekWorkspaceServices(host, start);
  ProviderWorkspaceRegistry.setServices('deepseek', workspace);
  const repository = new ConversationRepository({
    providers: ProviderRegistry, providerSettings: ProviderSettingsCoordinator,
    getSettings: () => settings, getVaultPath: () => vaultPath, onConversationDeleted: async () => undefined,
    persistence: {
      metadataReader: { revalidate: vi.fn(), load: vi.fn(), scan: vi.fn(), loadMetadata: vi.fn(), scanMetadata: vi.fn(), listMetadata: vi.fn() },
      saveMetadata: async () => undefined, deleteCurrentMetadata: async () => undefined, assignMetadataToDevice: async () => undefined,
    } as ConversationPersistence,
  });
  repository.replaceAll([{ id: 'conversation', providerId: 'deepseek', sessionId: 'native-session', messages: [], title: 'WSL',
    providerState: { schemaVersion: 1, home, profile: 'web', preset: 'claudian' }, createdAt: time, lastActivityAt: time,
  } as Conversation]);
  const chatHost = { ensureConversationMetadataLoaded: async () => undefined,
    getConversationById: (id: string) => repository.getById(id), sessionRuntimes: { get: () => undefined },
  } as unknown as ChatFeatureHost;
  const service = new SessionMessagingService({ getHost: () => chatHost, getActiveConversationId: () => null, refreshModelControls: () => undefined });
  try {
    expect(await createClaudianAPI(service).read('conversation')).toBe('Reply from Linux');
    const tools = repository.getSync('conversation')?.messages.flatMap(message => message.toolCalls ?? []);
    expect(tools).toContainEqual(expect.objectContaining({ name: 'Edit', input: { file_path: `${vaultPath}\\note.md` }, diffData: expect.objectContaining({ filePath: `${vaultPath}\\note.md` }) }));
    expect(start).toHaveBeenCalledTimes(1);
    expect(runProcessProbe).toHaveBeenCalledTimes(1);
    // Synchronous model/settings projections do not probe Linux home or start another process.
    workspace.modelCatalog.getSnapshot();
    workspace.cliResolver.resolveFromSettings(settings);
    expect(runProcessProbe).toHaveBeenCalledTimes(1);
    expect(peer.calls.every(call => ['session/list', 'session/projections', 'session/page'].includes(call.method))).toBe(true);
    // A transition discards the generation's resolved home, even with unchanged launch settings.
    await workspace.deepseek.beginTransition(); workspace.deepseek.endTransition();
    vi.mocked(runProcessProbe).mockResolvedValue('x\0/home/alice\0x\0/changed/store\0');
    expect(await workspace.deepseek.read(async (_reader, home) => home)).toBe('\\\\wsl$\\Ubuntu\\changed\\store');
    expect(runProcessProbe).toHaveBeenCalledTimes(2);
  } finally {
    await service.dispose(); await workspace.dispose?.(); await lifecycle.dispose(); await peer.close();
    ProviderWorkspaceRegistry.setServices('deepseek', undefined);
  }
});
