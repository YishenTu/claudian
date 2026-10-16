// Retired-binding migration (#1647): delete this file after 2027-01-16.
import '@/providers';

import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { testDate, testTime } from '@test/helpers/testClock';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { ClaudianSettings, Conversation } from '@/core/types';
import { clearPiResumeState } from '@/providers/pi/types';

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

/** The shape an earlier version left after retiring the live binding. */
function retiredByEarlierVersion(conversation: Conversation): Conversation {
  const { sessionFile, sessionId, leafEntryId } = conversation.providerState as Record<string, string>;
  return { ...conversation, sessionId: null, providerState: { previousSessions: [{ sessionFile, sessionId, leafEntryId }] } };
}

function fixture(conversations: Conversation[]) {
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS) as ClaudianSettings & Record<string, any>;
  settings.providerConfigs = {
    ...settings.providerConfigs,
    pi: { enabled: true, environmentVariables: `PI_CODING_AGENT_SESSION_DIR=${sessionDir}\nHOME=${root}` },
  };
  const saveMetadata = jest.fn().mockResolvedValue(undefined);
  const repository = new ConversationRepository({
    providers: ProviderRegistry,
    providerSettings: ProviderSettingsCoordinator,
    getSettings: () => settings,
    getVaultPath: () => vault,
    persistence: {
      metadataReader: {
        revalidate: jest.fn().mockResolvedValue([]),
        load: jest.fn().mockResolvedValue(null),
        scan: jest.fn().mockResolvedValue({ records: [], complete: true, invalidMetadataCount: 0 }),
        loadMetadata: jest.fn().mockResolvedValue(null),
        scanMetadata: jest.fn().mockResolvedValue({ metadata: [], complete: true, invalidMetadataCount: 0 }),
        listMetadata: jest.fn().mockResolvedValue([]),
      },
      saveMetadata,
      deleteCurrentMetadata: jest.fn().mockResolvedValue(undefined),
      assignMetadataToDevice: jest.fn().mockResolvedValue(undefined),
    } as never,
    onConversationDeleted: async () => undefined,
  });
  repository.replaceAll(conversations);
  return { repository, saveMetadata };
}

async function treeBranchesOfEditedPrompt(repository: ConversationRepository, id: string) {
  const conversation = await repository.ensureHydrated(id);
  return conversation?.messages.find(message => message.content === 'Edited prompt')?.treeBranches;
}

describe('Pi bindings retired by an earlier version', () => {
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

  it('restores the conversation\'s own session so its turns regain tree navigation', async () => {
    const live = liveConversation('conv-a', 'session-a', writeSession('session-a', testTime({ seconds: 1 })));
    const { repository, saveMetadata } = fixture([retiredByEarlierVersion(live)]);

    expect(await treeBranchesOfEditedPrompt(repository, 'conv-a')).toEqual(['u1', 'u2']);
    const restored = { sessionId: 'session-a', providerState: live.providerState };
    expect(repository.getCachedConversation('conv-a')).toMatchObject(restored);
    expect(saveMetadata).toHaveBeenCalledWith(expect.objectContaining(restored));
  });

  it('keeps a binding retired by the current version history-only', async () => {
    const retired = liveConversation('conv-a', 'session-a', writeSession('session-a', testTime({ seconds: 1 })));
    clearPiResumeState(retired);
    const { repository } = fixture([retired]);

    expect(await treeBranchesOfEditedPrompt(repository, 'conv-a')).toBeUndefined();
    expect(repository.getCachedConversation('conv-a')?.sessionId).toBeNull();
  });

  it('never binds an unsent fork to the source session it was retired into', async () => {
    // A pending fork retires into its source session, which existed before the fork was created.
    const source = liveConversation('conv-fork', 'session-source', writeSession('session-source', testTime({ seconds: -60 })));
    const { repository, saveMetadata } = fixture([retiredByEarlierVersion(source)]);

    expect(await treeBranchesOfEditedPrompt(repository, 'conv-fork')).toBeUndefined();
    expect(repository.getCachedConversation('conv-fork')?.sessionId).toBeNull();
    // The decision is recorded once, so later opens do not re-read the transcript header.
    expect(saveMetadata).toHaveBeenCalledWith(expect.objectContaining({
      providerState: expect.objectContaining({ bindingRetired: true }),
    }));
  });
});
