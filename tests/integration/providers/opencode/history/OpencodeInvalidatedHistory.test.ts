import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { testDate } from '@test/helpers/testClock';

import type { Conversation } from '@/core/types';
import { opencodeSettingsReconciler } from '@/providers/opencode/env/OpencodeSettingsReconciler';
import { OpencodeConversationHistoryService } from '@/providers/opencode/history/OpencodeConversationHistoryService';
import { buildOpencodePrompt } from '@/providers/opencode/runtime/buildOpencodePrompt';

interface SeedMessage {
  role: 'user' | 'assistant';
  text: string;
  model?: { providerID: string; id: string };
}

describe('OpenCode history after runtime invalidation', () => {
  const history = new OpencodeConversationHistoryService();
  const startedAt = testDate().getTime();
  let root: string;
  let databasePath: string;
  let environment: NodeJS.ProcessEnv;
  let settings: Record<string, unknown>;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'opencode-invalidated-history-'));
    const xdgDataHome = path.join(root, 'xdg');
    databasePath = path.join(xdgDataHome, 'opencode', 'opencode.db');
    environment = { HOME: root, XDG_DATA_HOME: xdgDataHome };
    settings = {
      providerConfigs: {
        opencode: { enabled: true, environmentVariables: `XDG_DATA_HOME=${xdgDataHome}` },
      },
    };
    // Record the starting runtime fingerprint.
    opencodeSettingsReconciler.reconcileModelWithEnvironment(settings, []);
    seedSession('session-original', [
      { role: 'user', text: 'Original prompt' },
      { role: 'assistant', text: 'Original reply', model: { providerID: 'google', id: 'gemini-3.5-flash' } },
    ]);
  });

  afterEach(() => {
    rmSync(root, { force: true, recursive: true });
  });

  it('keeps an invalidated unstamped conversation readable without resuming its old session', async () => {
    const conversation = createConversation();

    expect(changeRuntime(conversation)).toEqual([conversation]);

    expect(history.resolveSessionIdForConversation(conversation)).toBeNull();
    expect(await history.recoverConversationModelSelection!(conversation, root, { environment }))
      .toBe('opencode:google/gemini-3.5-flash');
    const hydrated = await history.hydrateConversationHistory(conversation, root, { environment });
    expect(hydrated.messages?.map(message => [message.role, message.content])).toEqual([
      ['user', 'Original prompt'],
      ['assistant', 'Original reply'],
    ]);
    // The replacement session has not seen this history, so the next send must replay it.
    expect(hydrated.providerState?.nativeConversationContextEstablished).toBe(false);
  });

  it('renders earlier sessions before the replacement session without the replayed history', async () => {
    const conversation = createConversation();
    changeRuntime(conversation);
    Object.assign(conversation, await history.hydrateConversationHistory(conversation, root, { environment }));

    // The next send starts a fresh native session seeded with the hydrated history.
    const [block] = buildOpencodePrompt({ text: 'Follow up' }, conversation.messages).blocks;
    seedSession('session-next', [
      { role: 'user', text: block.type === 'text' ? block.text : '' },
      { role: 'assistant', text: 'Next reply' },
    ]);
    conversation.sessionId = 'session-next';
    conversation.providerState = {
      ...conversation.providerState,
      databasePath,
      nativeConversationContextEstablished: true,
    };
    conversation.messages = [];

    expect(history.resolveSessionIdForConversation(conversation)).toBe('session-next');
    const hydrated = await history.hydrateConversationHistory(conversation, root, { environment });
    expect(hydrated.messages?.map(message => [message.role, message.content])).toEqual([
      ['user', 'Original prompt'],
      ['assistant', 'Original reply'],
      ['user', 'Follow up'],
      ['assistant', 'Next reply'],
    ]);
    // The native server cannot reach checkpoints in retired sessions, so they offer no fork/rewind.
    expect(hydrated.messages?.map(message => message.userMessageId ?? message.assistantMessageId)).toEqual([
      undefined, undefined, 'session-next-message-0', 'session-next-message-1',
    ]);

    // A second invalidation retires the replacement session after the original one.
    changeRuntime(conversation, 'OPENCODE_DISABLE_PROJECT_CONFIG=1');
    expect(history.resolveSessionIdForConversation(conversation)).toBeNull();
    expect(history.buildPersistedProviderState(conversation)).toEqual({
      nativeConversationContextEstablished: false,
      previousSessions: [
        { sessionId: 'session-original', databasePath },
        { sessionId: 'session-next', databasePath },
      ],
    });
    const rehydrated = await history.hydrateConversationHistory(conversation, root, { environment });
    expect(rehydrated.messages?.map(message => message.content)).toEqual([
      'Original prompt', 'Original reply', 'Follow up', 'Next reply',
    ]);
  });

  it('never reads a retired session from a database other than the one it recorded', async () => {
    // The binding was created before XDG_DATA_HOME existed, in the old default database.
    const oldDatabase = path.join(root, '.local', 'share', 'opencode', 'opencode.db');
    seedSession('session-old', [
      { role: 'user', text: 'Old prompt' },
      { role: 'assistant', text: 'Old reply', model: { providerID: 'google', id: 'old-model' } },
    ], oldDatabase);
    // The new default database holds another session under the same id.
    seedSession('session-old', [
      { role: 'user', text: 'Unrelated prompt' },
      { role: 'assistant', text: 'Unrelated reply', model: { providerID: 'google', id: 'unrelated-model' } },
    ]);
    startWithoutXdg();
    const conversation: Conversation = {
      ...createConversation(),
      sessionId: 'session-old',
      providerState: { databasePath: oldDatabase },
    };

    changeRuntime(conversation, `XDG_DATA_HOME=${environment.XDG_DATA_HOME}`);

    // The old database is no longer trusted, so its history stays unreadable.
    expect(await history.recoverConversationModelSelection!(conversation, root, { environment })).toBeNull();
    const hydrated = await history.hydrateConversationHistory(conversation, root, { environment });
    expect(hydrated.messages ?? []).toEqual([]);
  });

  it('reads a retired session without a recorded database from the current database', async () => {
    const conversation: Conversation = { ...createConversation(), providerState: {} };

    // Only launch configuration changes; the native store stays where it was.
    changeRuntime(conversation);

    expect(await history.recoverConversationModelSelection!(conversation, root, { environment }))
      .toBe('opencode:google/gemini-3.5-flash');
    const hydrated = await history.hydrateConversationHistory(conversation, root, { environment });
    expect(hydrated.messages?.map(message => message.content)).toEqual(['Original prompt', 'Original reply']);
  });

  it('skips a retired session without a recorded database when the current database lacks it', async () => {
    const oldDatabase = path.join(root, '.local', 'share', 'opencode', 'opencode.db');
    seedSession('session-old', [{ role: 'user', text: 'Old prompt' }], oldDatabase);
    startWithoutXdg();
    const conversation: Conversation = {
      ...createConversation(),
      sessionId: 'session-old',
      providerState: {},
    };

    changeRuntime(conversation, `XDG_DATA_HOME=${environment.XDG_DATA_HOME}`);

    const hydrated = await history.hydrateConversationHistory(conversation, root, { environment });
    expect(hydrated.messages ?? []).toEqual([]);
  });

  it('records the trusted database a live binding was read from before retiring it', async () => {
    const conversation: Conversation = { ...createConversation(), providerState: {} };
    Object.assign(conversation, await history.hydrateConversationHistory(conversation, root, { environment }));
    expect(conversation.providerState?.databasePath).toBe(databasePath);

    changeRuntime(conversation);

    expect(history.buildPersistedProviderState(conversation)).toEqual({
      nativeConversationContextEstablished: false,
      previousSessions: [{ sessionId: 'session-original', databasePath }],
    });
  });

  function startWithoutXdg(): void {
    const config = (settings.providerConfigs as Record<string, Record<string, unknown>>).opencode;
    config.environmentVariables = '';
    config.environmentHash = undefined;
    opencodeSettingsReconciler.reconcileModelWithEnvironment(settings, []);
  }

  function createConversation(): Conversation {
    return {
      createdAt: startedAt,
      id: 'conv-opencode',
      lastActivityAt: startedAt,
      messages: [],
      providerId: 'opencode',
      providerState: { databasePath, nativeConversationContextEstablished: true },
      sessionId: 'session-original',
      title: 'OpenCode conversation',
    };
  }

  function changeRuntime(
    conversation: Conversation,
    variable = `OPENCODE_CONFIG=${path.join(root, 'opencode.json')}`,
  ): Conversation[] {
    const config = (settings.providerConfigs as Record<string, Record<string, unknown>>).opencode;
    config.environmentVariables = `${String(config.environmentVariables)}\n${variable}`;
    const result = opencodeSettingsReconciler.reconcileModelWithEnvironment(settings, [conversation]);
    expect(result.changed).toBe(true);
    return result.invalidatedConversations;
  }

  function seedSession(sessionId: string, messages: SeedMessage[], target = databasePath): void {
    mkdirSync(path.dirname(target), { recursive: true });
    const db = new DatabaseSync(target);
    try {
      db.exec('CREATE TABLE IF NOT EXISTS session_message(id TEXT PRIMARY KEY, session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT)');
      messages.forEach((message, index) => {
        const created = startedAt + index;
        const data = message.role === 'user'
          ? { text: message.text, time: { created } }
          : { content: [{ type: 'text', text: message.text }], time: { created, completed: created }, ...(message.model ? { model: message.model } : {}) };
        db.prepare(`INSERT INTO session_message VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM session_message), ?, ?, ?)`).run(
          `${sessionId}-message-${index}`, sessionId, message.role, created, JSON.stringify(data),
        );
      });
    } finally {
      db.close();
    }
  }
});
