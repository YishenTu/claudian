import '@/providers';

import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';

import { createFeatureHostFixture } from '@test/helpers/FeatureHostFixture';
import { createChatFeatureHost } from '@test/helpers/features/chat/ChatFeatureHostFixture';
import { createSessionRuntimePool } from '@test/helpers/features/chat/SessionRuntimePoolHarness';
import { grokWSLToolUpdates } from '@test/helpers/providers/grokWSLTools';
import { testDate } from '@test/helpers/testClock';
import { createWindowsHostFS } from '@test/helpers/WindowsHostFS';
import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { ConversationPersistenceStore } from '@/app/storage/ConversationPersistenceStore';
import { getInstallationKey } from '@/core/device/InstallationKey';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { createClaudianAPI } from '@/features/chat/session-messaging/ClaudianAPI';
import { SessionMessagingService } from '@/features/chat/session-messaging/SessionMessagingService';

// `\\wsl$` UNC paths exist only on Windows hosts, so the host filesystem is the external boundary.
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof fs>() }));
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof fsPromises>() }));
vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.restoreAllMocks(); });

describe.skipIf(path.sep === '\\')('Grok WSL history on a simulated Windows host', () => {
  it.each([
    { homeKey: 'HOME', storedCwd: '/mnt/c/vault' },
    { homeKey: 'GROK_HOME', storedCwd: '/mnt/c/vault' },
    { homeKey: 'HOME', storedCwd: '/mnt/c/old-vault' },
    { homeKey: 'GROK_HOME', storedCwd: '/mnt/c/old-vault' },
  ] as const)('reads a WSL Grok transcript through the plugin API using Linux $homeKey stored under $storedCwd', async ({ homeKey, storedCwd }) => {
    const native = new WSLProcessFixture();
    native.environment = homeKey === 'HOME' ? { HOME: '/home/alice' } : { HOME: '/home/alice', GROK_HOME: '/opt/grok' };
    vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
    const key = getInstallationKey();
    const fixture = await createFeatureHostFixture({ settings: { providerConfigs: { grok: {
      enabled: true, installationMethodsByHost: { [key]: 'wsl' }, wslDistroOverridesByHost: { [key]: 'Ubuntu' },
    } } } });
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const root = homeKey === 'HOME' ? '\\\\wsl$\\Ubuntu\\home\\alice\\.grok\\sessions' : '\\\\wsl$\\Ubuntu\\opt\\grok\\sessions';
    // Prior-cwd transcripts require enumeration after rejecting the wrong-distro hint.
    const directory = path.win32.join(root, encodeURIComponent(storedCwd), 'native-session');
    const updates = [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Question' }, _meta: { promptIndex: 0 } },
      ...grokWSLToolUpdates,
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Reply from Linux' } },
      { sessionUpdate: 'turn_completed' },
    ].map(update => JSON.stringify({ method: 'session/update', timestamp: testDate().getTime(), params: { sessionId: 'native-session', update } })).join('\n');
    const files = createWindowsHostFS({ fs, fsPromises });
    await files.write(path.win32.join(directory, 'updates.jsonl'), updates);
    const repository = new ConversationRepository({
      providers: ProviderRegistry, providerSettings: ProviderSettingsCoordinator,
      getSettings: () => fixture.settings, getVaultPath: () => 'C:\\vault', onConversationDeleted: async () => undefined,
      persistence: new ConversationPersistenceStore(fixture.vault.files, fixture.storage.installationKey),
    });
    repository.replaceAll([{
      id: 'conversation', providerId: 'grok', sessionId: 'native-session', messages: [], title: 'WSL',
      providerState: { sessionDirectory: '\\\\wsl$\\OtherDistro\\opt\\grok\\sessions\\wrong\\native-session' },
      createdAt: testDate().getTime(), lastActivityAt: testDate().getTime(),
    }]);
    const host: ChatFeatureHost = await createChatFeatureHost({
      fixture, sessionRuntimes: createSessionRuntimePool(() => host),
      ensureConversationMetadataLoaded: async () => undefined,
      getConversationById: id => repository.getById(id),
    });
    const service = new SessionMessagingService({ getHost: () => host, getActiveConversationId: () => null, refreshModelControls: () => undefined });
    try {
      expect(await createClaudianAPI(service).read('conversation')).toBe('Reply from Linux');
      const tools = repository.getSync('conversation')?.messages.flatMap(message => message.toolCalls ?? []);
      expect(tools).toContainEqual(expect.objectContaining({ name: 'LS', input: expect.objectContaining({ path: 'C:\\vault\\notes' }) }));
      expect(tools).toContainEqual(expect.objectContaining({ name: 'Edit', diffData: expect.objectContaining({ filePath: 'C:\\vault\\note.md' }) }));
      expect(repository.getSync('conversation')?.providerState?.sessionDirectory).toBe(directory);
      // The store comes from the Linux environment of the configured distro and vault cwd.
      expect(native.requests.map(request => [request.executable, request.argv.slice(1)])).toEqual([['/usr/bin/awk', ['HOME', 'GROK_HOME']]]);
      expect(native.requests[0].args).toEqual(expect.arrayContaining(['--distribution', 'Ubuntu', '--cd', '/mnt/c/vault']));
    } finally { await service.dispose(); }
  });

});
