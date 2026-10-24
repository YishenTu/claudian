import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { seedFakeOpencodeSession, writeFakeOpencodeHistoryCLI } from '@test/helpers/providers/opencode/FakeOpencodeHistoryServer';

import type { ProviderHistoryPathContext } from '@/core/providers/types';
import type { Conversation } from '@/core/types';
import { OpencodeConversationHistoryService } from '@/providers/opencode/history/OpencodeConversationHistoryService';

describe('OpencodeConversationHistoryService', () => {
  const originalPlatform = process.platform;
  let tmpRoot: string;
  let settings: Record<string, unknown>;

  beforeEach(() => {
    tmpRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'claudian-opencode-conversation-history-')));
    settings = { providerConfigs: { opencode: { cliPath: writeFakeOpencodeHistoryCLI(tmpRoot) } } };
  });

  function context(environment: NodeJS.ProcessEnv): ProviderHistoryPathContext {
    return { environment, settings, vaultPath: tmpRoot };
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    rmSync(tmpRoot, { force: true, recursive: true });
  });

  it('retries after a session-level hydration diagnostic', async () => {
    const dbPath = path.join(tmpRoot, 'opencode.db');
    const sessionId = 'session-retry';
    const conversation = createConversation(sessionId, dbPath);
    const service = new OpencodeConversationHistoryService();
    const historyContext = context({ HOME: tmpRoot, OPENCODE_DB: dbPath });
    // The native database does not hold the session yet.
    writeFileSync(dbPath, '{}');

    Object.assign(conversation, await service.hydrateConversationHistory(conversation, tmpRoot, historyContext));

    expect(conversation.messages).toEqual([expect.objectContaining({
      id: 'opencode-hydration-error-session-session-retry',
      role: 'assistant',
      content: expect.stringContaining('Session not found: session-retry'),
    })]);
    // A failed read proves no native context.
    expect(conversation.providerState).toEqual({ databasePath: dbPath });

    seedDatabase(dbPath, sessionId, 'Recovered prompt');
    Object.assign(conversation, await service.hydrateConversationHistory(conversation, tmpRoot, historyContext));

    expect(conversation.messages).toEqual([
      {
        assistantMessageId: undefined,
        content: 'Recovered prompt',
        id: `message-${sessionId}`,
        role: 'user',
        timestamp: 1_000,
        userMessageId: `message-${sessionId}`,
      },
    ]);
  }, 15_000);

  it('recovers an unstamped binding model from its native session', async () => {
    const dbPath = path.join(tmpRoot, 'model-history.db');
    const sessionId = 'session-model';
    seedFakeOpencodeSession(dbPath, sessionId, { model: { id: 'gemini-3.5-flash', providerID: 'google' }, messages: [] });
    const conversation = createConversation(sessionId, dbPath);

    await expect(new OpencodeConversationHistoryService()
      .recoverConversationModelSelection?.(conversation, tmpRoot, context({ HOME: tmpRoot, OPENCODE_DB: dbPath })))
      .resolves.toBe('opencode:google/gemini-3.5-flash');
  });

  it.each([
    ['an out-of-root database', 'linux'],
    ['a Windows AppData database', 'win32'],
  ] as const)('never opens %s or moves the binding off it', async (_, platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    const sessionId = 'session-untrusted-path';
    const home = path.join(tmpRoot, 'home');
    const xdgDataHome = path.join(tmpRoot, 'xdg');
    const currentPath = platform === 'win32'
      ? path.join(home, '.local', 'share', 'opencode', 'opencode.db')
      : path.join(xdgDataHome, 'opencode', 'opencode.db');
    const recordedPath = platform === 'win32'
      ? path.join(home, 'AppData', 'Roaming', 'opencode', 'opencode.db')
      : path.join(tmpRoot, 'synced-device', 'opencode.db');
    seedDatabase(currentPath, sessionId, 'Current prompt');
    seedDatabase(recordedPath, sessionId, 'Recorded prompt');
    const conversation = createConversation(sessionId, recordedPath);
    conversation.providerState!.futureResumeCursor = { token: 'cursor-1' };

    Object.assign(conversation, await new OpencodeConversationHistoryService().hydrateConversationHistory(
      conversation,
      tmpRoot,
      context(platform === 'win32'
        ? { APPDATA: path.join(home, 'AppData', 'Roaming'), HOME: home }
        : { HOME: home, XDG_DATA_HOME: xdgDataHome }),
    ));

    // Neither database is read; the recorded locator survives for a later trusted read.
    expect(conversation.messages).toEqual([expect.objectContaining({
      id: `opencode-hydration-error-session-${sessionId}`,
      content: expect.stringContaining(recordedPath),
    })]);
    expect(conversation.providerState).toEqual({
      databasePath: recordedPath,
      futureResumeCursor: { token: 'cursor-1' },
    });
  });

  it('sanitizes known fields while preserving unknown provider state', () => {
    const conversation = createConversation('session-1', '/tmp/opencode.db');
    conversation.providerState!.futureResumeCursor = { token: 'cursor-1' };

    expect(
      new OpencodeConversationHistoryService().buildPersistedProviderState(conversation),
    ).toEqual({
      databasePath: '/tmp/opencode.db',
      futureResumeCursor: { token: 'cursor-1' },
    });
  });

  describe('resolveMissingConversationSession', () => {
    it('retires a confirmed stale resume ID to history while preserving provider-owned state', async () => {
      const conversation = createConversation('missing-session', '/tmp/opencode.db');
      conversation.providerState!.futureResumeCursor = { token: 'cursor-1' };
      const service = new OpencodeConversationHistoryService();

      const update1 = await service.resolveMissingConversationSession(
        conversation,
        null,
        'missing-session',
      );
      expect(update1.outcome).toBe('reset');
      Object.assign(conversation, update1.changes);

      expect(conversation.sessionId).toBeNull();
      expect(conversation.providerState).toEqual({
        databasePath: '/tmp/opencode.db',
        futureResumeCursor: { token: 'cursor-1' },
        nativeConversationContextEstablished: false,
        previousSessions: [{ sessionId: 'missing-session', databasePath: '/tmp/opencode.db' }],
      });
      expect(service.resolveSessionIdForConversation(conversation)).toBeNull();
    });

    it('preserves a newer resume ID when the failure identifies another session', async () => {
      const conversation = createConversation('current-session', '/tmp/opencode.db');
      conversation.providerState!.futureResumeCursor = { token: 'cursor-1' };
      const service = new OpencodeConversationHistoryService();

      const update2 = await service.resolveMissingConversationSession(
        conversation,
        null,
        'stale-session',
      );
      expect(update2.outcome).toBe('preserve');
      Object.assign(conversation, update2.changes);

      expect(conversation.sessionId).toBe('current-session');
      expect(conversation.providerState).toEqual({
        databasePath: '/tmp/opencode.db',
        futureResumeCursor: { token: 'cursor-1' },
      });
    });
  });

  it('marks native context established when read-only hydration proves history exists', async () => {
    const dbPath = path.join(tmpRoot, 'opencode.db');
    seedDatabase(dbPath, 'session-established', 'Accepted prompt');
    const conversation = createConversation('session-established', dbPath);
    conversation.providerState = {
      ...conversation.providerState,
      futureResumeCursor: { token: 'cursor-1' },
      nativeConversationContextEstablished: false,
    };

    Object.assign(conversation, await new OpencodeConversationHistoryService().hydrateConversationHistory(
      conversation,
      tmpRoot,
      context({ HOME: tmpRoot, OPENCODE_DB: dbPath }),
    ));

    expect(conversation.providerState).toEqual({
      databasePath: dbPath,
      futureResumeCursor: { token: 'cursor-1' },
      nativeConversationContextEstablished: true,
    });
  });

  it('accepts an explicitly configured local database path', async () => {
    const sessionId = 'session-configured-path';
    const configuredPath = path.join(tmpRoot, 'custom', 'opencode-custom.db');
    seedDatabase(configuredPath, sessionId, 'Configured prompt');
    const conversation = createConversation(sessionId, configuredPath);

    Object.assign(conversation, await new OpencodeConversationHistoryService().hydrateConversationHistory(
      conversation,
      tmpRoot,
      context({ HOME: tmpRoot, OPENCODE_DB: configuredPath }),
    ));

    expect(conversation.messages.map(message => message.content)).toEqual(['Configured prompt']);
  });

  it('defers an ephemeral fork of an unstamped legacy binding to its first v2 send', async () => {
    const configuredPath = path.join(tmpRoot, 'custom', 'opencode.db');
    seedDatabase(configuredPath, 'legacy-source', 'Legacy prompt');

    await expect(new OpencodeConversationHistoryService().buildForkProviderState(
      'legacy-source',
      'msg-reply',
      { databasePath: configuredPath, sessionId: 'legacy-source' },
      tmpRoot,
      { environment: { HOME: tmpRoot, OPENCODE_DB: configuredPath } },
      { lifecycle: 'ephemeral' },
    )).resolves.toEqual({
      databasePath: configuredPath,
      forkSource: { sessionId: 'legacy-source', resumeAt: 'msg-reply' },
      nativeConversationContextEstablished: true,
    });
  });
});

function seedDatabase(databasePath: string, sessionId: string, text: string): void {
  seedFakeOpencodeSession(databasePath, sessionId, {
    messages: [{ id: `message-${sessionId}`, type: 'user', text, time: { created: 1_000 } }],
  });
}

function createConversation(sessionId: string, databasePath: string): Conversation {
  return {
    createdAt: 1,
    id: 'conv-opencode',
    messages: [],
    providerId: 'opencode',
    providerState: { databasePath },
    sessionId,
    title: 'OpenCode conversation',
    lastActivityAt: 1,
  };
}
