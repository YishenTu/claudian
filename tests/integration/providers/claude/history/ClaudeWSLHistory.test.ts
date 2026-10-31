import '@/providers';

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';

import { claudeCatalogFixture } from '@test/helpers/claudeModels';
import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { testDate } from '@test/helpers/testClock';
import { createWindowsHostFS } from '@test/helpers/WindowsHostFS';
import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { ConversationPersistenceStore } from '@/app/storage/ConversationPersistenceStore';
import { getInstallationKey } from '@/core/device/InstallationKey';
import { createProviderHistoryPathContext } from '@/core/providers/historyPathContext';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { ClaudianSettings, Conversation } from '@/core/types';
import { createClaudianAPI } from '@/features/chat/session-messaging/ClaudianAPI';
import { SessionMessagingService } from '@/features/chat/session-messaging/SessionMessagingService';
import { loadSDKSessionMessages } from '@/providers/claude/history/ClaudeHistoryStore';

vi.mock('fs', async () => ({ ...await vi.importActual<typeof import('fs')>('fs') }));
vi.mock('fs/promises', async () => ({ ...await vi.importActual<typeof import('fs/promises')>('fs/promises') }));
vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const root = '\\\\wsl$\\Ubuntu\\home\\linux-user\\.claude\\projects\\-mnt-c-Vault';
// Each case owns its native session: the registered history service caches session locations across tests.
const sessionPath = (sessionId: string) => `${root}\\${sessionId}.jsonl`;
const context = { executionTarget: { method: 'wsl', distroName: 'Ubuntu', platformFamily: 'unix', platformOs: 'linux' } as const,
  environment: { HOME: '/home/linux-user', TMPDIR: '/tmp' }, hostPlatform: 'win32' as const };
const timestamp = testDate().toISOString();
const rows = (values: unknown[]) => values.map(value => JSON.stringify(value)).join('\n') + '\n';

let native: WSLProcessFixture;
let host: ReturnType<typeof createWindowsHostFS>;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  native = new WSLProcessFixture();
  native.environment = { HOME: '/home/linux-user' };
  vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
  host = createWindowsHostFS({ fs, fsPromises });
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); });

function wslSettings(environmentVariables = ''): ClaudianSettings {
  const key = getInstallationKey();
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  settings.model = 'claude-sonnet-4-5';
  settings.providerConfigs.claude = { ...claudeCatalogFixture(['claude-sonnet-4-5']),
    installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: { [key]: 'Ubuntu' }, environmentVariables };
  return settings;
}

function createRepository(settings: ClaudianSettings) {
  const persistence = new ConversationPersistenceStore(sharedVault.files, getInstallationKey());
  const repository = new ConversationRepository({ providers: ProviderRegistry, providerSettings: ProviderSettingsCoordinator,
    getSettings: () => settings, getVaultPath: () => 'C:\\Vault', onConversationDeleted: async () => {}, persistence,
  });
  return { repository, persistence };
}

// WindowsHostFS models Windows paths on POSIX hosts; on Windows they are real host paths.
const onWindows = process.platform === 'win32';

it.skipIf(onWindows)('plugin API read hydrates a WSL transcript through the repository with its provider configuration', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  await host.write(sessionPath('api-read'), rows([
    { type: 'user', uuid: 'u1', timestamp, message: { role: 'user', content: 'Question' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp,
      message: { role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'Answer from WSL history' }] } },
  ]));
  const { repository } = createRepository(wslSettings());
  repository.replaceAll([{ id: 'conversation-1', providerId: 'claude', sessionId: 'api-read', messages: [],
    selectedModel: 'claude-sonnet-4-5', title: 'WSL session', createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
  }]);
  const pool = createSessionRuntimePool(() => chatHost);
  const chatHost = await createChatFeatureHost({ sessionRuntimes: pool,
    ensureConversationMetadataLoaded: async () => {}, getConversationById: async id => repository.getById(id),
  });
  const service = new SessionMessagingService({ getHost: () => chatHost, getActiveConversationId: () => null, refreshModelControls: () => {} });
  try {
    expect(await createClaudianAPI(service).read('conversation-1')).toBe('Answer from WSL history');
    // The Linux HOME comes from distro environment probes (availability, then the read), run from the host vault.
    expect(native.requests.length).toBeGreaterThan(0);
    for (const request of native.requests) {
      expect(request.executable).toBe('/usr/bin/awk');
      expect(request.options).toMatchObject({ cwd: 'C:\\Vault', windowsVerbatimArguments: true });
    }
  } finally { await service.dispose(); }
});

it.skipIf(onWindows)('restores WSL transcript tool paths at their Windows host paths through the provider history service', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  await host.write(sessionPath('path-mapping'), rows([
    { type: 'user', uuid: 'u1', timestamp, message: { role: 'user', content: 'Read the note' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp, message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/mnt/c/Vault/note.md' } },
    ] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'read-1', content: 'Note body' },
    ] } },
  ]));
  const settings = wslSettings();
  const history = await ProviderRegistry.getConversationHistoryService('claude').hydrateConversationHistory(
    { sessionId: 'path-mapping', messages: [] }, 'C:\\Vault',
    createProviderHistoryPathContext(settings, 'claude', 'C:\\Vault'),
  );
  expect(history.messages?.flatMap(message => message.toolCalls ?? [])).toEqual([expect.objectContaining({
    id: 'read-1', name: 'Read', input: { file_path: 'C:\\Vault\\note.md' }, result: 'Note body',
  })]);
});

it.skipIf(onWindows)('recovers legacy TaskOutput files while hydrating WSL history before neutral consumers read them', async () => {
  await host.write(sessionPath('task-output'), rows([
    { type: 'user', uuid: 'u1', timestamp, message: { role: 'user', content: 'Read result' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp, message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'out-1', name: 'TaskOutput', input: { task_id: 'worker' } },
    ] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp, message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'out-1', content: '<output>[Truncated. Full output: /tmp/task.output]</output>' },
    ] } },
  ]));
  await host.write('\\\\wsl$\\Ubuntu\\tmp\\task.output', JSON.stringify({ type: 'result', result: 'Legacy WSL output' }));
  const result = await loadSDKSessionMessages('C:\\Vault', 'task-output', undefined, undefined, context);
  expect(result.messages.flatMap(message => message.toolCalls ?? []).find(tool => tool.id === 'out-1')?.result)
    .toBe('Legacy WSL output');
});

it.skipIf(onWindows).each(['save', 'compact'] as const)('uses asynchronously resolved Linux HOME for metadata %s and rejects stale store context', async operation => {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  vi.stubEnv('HOME', 'C:\\Users\\windows');
  onTestFinished(() => { vi.unstubAllEnvs(); });
  const settings = wslSettings(`TEST_STORE=${operation}`);
  const providerState = { subagentData: { task: { id: 'task', agentId: 'worker', mode: 'sync',
    status: 'completed', description: 'Work', toolCalls: [], result: 'R'.repeat(100_000) } } };
  const conversation: Conversation = { id: `metadata-${operation}`, providerId: 'claude', sessionId: `metadata-${operation}`, messages: [],
    providerState, createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(), title: 'Metadata',
  };
  await host.write(`${root}\\metadata-${operation}\\subagents\\agent-worker.jsonl`, '');
  const { repository, persistence } = createRepository(settings);
  // Each step starts from unsaved metadata; a step that does not persist leaves none.
  const run = async () => {
    await persistence.deleteCurrentMetadata(conversation.id).catch(() => undefined);
    repository.replaceAll([structuredClone(conversation)]);
    await (operation === 'save' ? repository.rename(conversation.id, 'Saved') : repository.compactPersistedProviderState(() => false));
    return persistence.metadataReader.loadMetadata(conversation.id);
  };
  // A cold save persists the full state; a cold compaction leaves the metadata unwritten.
  const retained = operation === 'save' ? providerState : 'unsaved';
  const persistedState = async () => { const metadata = await run(); return metadata ? metadata.providerState : 'unsaved'; };

  // Cold synchronous projections retain state without probing.
  expect(await persistedState()).toEqual(retained);
  expect(native.requests).toHaveLength(0);
  await ProviderRegistry.getConversationHistoryService('claude').getConversationSessionAvailability!(
    conversation, 'C:\\Vault', createProviderHistoryPathContext(settings, 'claude', 'C:\\Vault'),
  );
  expect(native.requests).toHaveLength(1);
  const compacted = await run();
  expect(compacted).not.toBeNull();
  expect(compacted?.providerState).toBeUndefined();

  settings.providerConfigs.claude!.environmentVariables = `TEST_STORE=${operation}\nCLAUDE_CONFIG_DIR=/different-store`;
  expect(await persistedState()).toEqual(retained);
  expect(native.requests).toHaveLength(1);
});

let sharedVault: DesktopVault;
beforeAll(async () => { sharedVault = await DesktopVault.create(); });
afterAll(async () => { await sharedVault.dispose(); });
