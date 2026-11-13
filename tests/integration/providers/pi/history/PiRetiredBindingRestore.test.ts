import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { testDate, testTime } from '@test/helpers/testClock';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { registerProviderModules } from '@/core/providers/registerProviderModules';
import type { ClaudianSettings, Conversation } from '@/core/types';
import { claudeProviderRegistration } from '@/providers/claude/registration';
import { piProviderRegistration } from '@/providers/pi/registration';

registerProviderModules([claudeProviderRegistration, piProviderRegistration]);

let root: string;
let vault: string;
let sessionDir: string;

/** A native tree whose second prompt was edited into a sibling branch. */
function writeSession(sessionId: string, startedAt: string): string {
  const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
  fs.writeFileSync(sessionFile, [
    { type: 'session', id: sessionId, cwd: vault, timestamp: startedAt },
    { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'First prompt' } },
    { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: 'First answer' } },
    { type: 'message', id: 'u2', parentId: null, message: { role: 'user', content: 'Edited prompt' } },
    { type: 'message', id: 'a2', parentId: 'u2', message: { role: 'assistant', content: 'Edited answer' } },
  ].map(entry => JSON.stringify(entry)).join('\n'));
  return sessionFile;
}

function liveConversation(id: string, sessionId: string, sessionFile: string): Conversation {
  return {
    id, providerId: 'pi', title: id, selectedModel: 'pi:test/model',
    createdAt: testDate().getTime(), lastActivityAt: testDate({ seconds: 30 }).getTime(),
    sessionId, messages: [], isPinned: false,
    providerState: { sessionFile, sessionId, leafEntryId: 'a2' },
  };
}

/** The shape an earlier version left after retiring the live binding, optionally marked as retired. */
function retiredByEarlierVersion(conversation: Conversation, marker: Record<string, unknown> = {}): Conversation {
  const { sessionFile, sessionId, leafEntryId } = conversation.providerState as Record<string, string>;
  return {
    ...conversation, sessionId: null,
    providerState: { ...marker, previousSessions: [{ sessionFile, sessionId, leafEntryId }] },
  };
}

function fixture(conversations: Conversation[]) {
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS) satisfies ClaudianSettings;
  settings.providerConfigs = {
    ...settings.providerConfigs,
    pi: { enabled: true, environmentVariables: `PI_CODING_AGENT_SESSION_DIR=${sessionDir}\nHOME=${root}` },
  };
  const saveMetadata = vi.fn().mockResolvedValue(undefined);
  const repository = new ConversationRepository({
    providers: ProviderRegistry,
    providerSettings: ProviderSettingsCoordinator,
    getSettings: () => settings,
    getVaultPath: () => vault,
    persistence: {
      metadataReader: {
        revalidate: vi.fn().mockResolvedValue([]),
        load: vi.fn().mockResolvedValue(null),
        scan: vi.fn().mockResolvedValue({ records: [], complete: true, invalidMetadataCount: 0 }),
        loadMetadata: vi.fn().mockResolvedValue(null),
        scanMetadata: vi.fn().mockResolvedValue({ metadata: [], complete: true, invalidMetadataCount: 0 }),
        listMetadata: vi.fn().mockResolvedValue([]),
      },
      saveMetadata,
      deleteCurrentMetadata: vi.fn().mockResolvedValue(undefined),
      assignMetadataToDevice: vi.fn().mockResolvedValue(undefined),
    } as never,
    onConversationDeleted: async () => undefined,
  });
  repository.replaceAll(conversations);
  return { repository, saveMetadata };
}

describe('Pi sessions retired by an earlier version', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-pi-restore-'));
    vault = path.join(root, 'vault');
    sessionDir = path.join(root, 'sessions');
    fs.mkdirSync(vault);
    fs.mkdirSync(sessionDir);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([
    ['unmarked', {}],
    ['marked', { bindingRetired: true }],
  ])('reads an available %s retired session as history without restoring its binding', async (_case, marker) => {
    // The conversation's own session, still in the configured store, once restored as the live binding.
    const live = liveConversation('conv-a', 'session-a', writeSession('session-a', testTime({ seconds: 1 })));
    const retired = retiredByEarlierVersion(live, marker);
    const { repository, saveMetadata } = fixture([structuredClone(retired)]);

    const hydrated = await repository.ensureHydrated('conv-a');

    expect(hydrated?.messages.map(message => message.content)).toEqual(['Edited prompt', 'Edited answer']);
    // Tree navigation belongs to a live binding only.
    expect(hydrated?.messages.find(message => message.content === 'Edited prompt')?.treeBranches).toBeUndefined();
    const cached = repository.getCachedConversation('conv-a');
    expect(cached?.sessionId).toBeNull();
    expect(cached?.providerState).toEqual(retired.providerState);
    expect(saveMetadata).not.toHaveBeenCalled();
  });
});
