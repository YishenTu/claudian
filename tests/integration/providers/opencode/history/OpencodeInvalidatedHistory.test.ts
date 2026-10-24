import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { seedFakeOpencodeSession, writeFakeOpencodeHistoryCLI } from '@test/helpers/providers/opencode/FakeOpencodeHistoryServer';
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
    root = realpathSync(mkdtempSync(path.join(tmpdir(), 'opencode-invalidated-history-')));
    const xdgDataHome = path.join(root, 'xdg');
    // The changed launch configuration names a real native config file.
    writeFileSync(path.join(root, 'opencode.json'), '{}');
    databasePath = path.join(xdgDataHome, 'opencode', 'opencode.db');
    environment = { HOME: root, XDG_DATA_HOME: xdgDataHome };
    settings = {
      providerConfigs: {
        opencode: { enabled: true, cliPath: writeFakeOpencodeHistoryCLI(root), environmentVariables: `XDG_DATA_HOME=${xdgDataHome}` },
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

  it('keeps a binding on its recorded database across a runtime change', async () => {
    const conversation = createConversation();

    // The recorded database fixes where the session lives, whatever record format created it.
    expect(changeRuntime(conversation)).toEqual([]);

    expect(history.resolveSessionIdForConversation(conversation)).toBe('session-original');
    expect(history.buildPersistedProviderState(conversation)).toEqual({ databasePath, nativeConversationContextEstablished: true });
    expect(await history.recoverConversationModelSelection!(conversation, root, { environment, settings }))
      .toBe('opencode:google/gemini-3.5-flash');
    const hydrated = await history.hydrateConversationHistory(conversation, root, { environment, settings });
    expect(hydrated.messages?.map(message => [message.role, message.content])).toEqual([
      ['user', 'Original prompt'],
      ['assistant', 'Original reply'],
    ]);
  });

  it('renders earlier sessions before the replacement session without the replayed history', async () => {
    const conversation = createConversation({});
    changeRuntime(conversation);
    Object.assign(conversation, await history.hydrateConversationHistory(conversation, root, { environment, settings }));
    // The replacement session has not seen this history, so the next send must replay it.
    expect(conversation.providerState?.nativeConversationContextEstablished).toBe(false);

    // The next send starts a fresh native session seeded with the hydrated history.
    const prompt = buildOpencodePrompt({ text: 'Follow up' }, conversation.messages);
    seedSession('session-next', [
      { role: 'user', text: prompt.text },
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
    const hydrated = await history.hydrateConversationHistory(conversation, root, { environment, settings });
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

    // A later retirement keeps the replacement session after the original one.
    Object.assign(conversation, (await history.resolveMissingConversationSession!(conversation, root, 'session-next')).changes);
    expect(history.resolveSessionIdForConversation(conversation)).toBeNull();
    expect(history.buildPersistedProviderState(conversation)).toEqual({
      databasePath,
      nativeConversationContextEstablished: false,
      previousSessions: [
        { sessionId: 'session-original' },
        { sessionId: 'session-next', databasePath },
      ],
    });
    const rehydrated = await history.hydrateConversationHistory(conversation, root, { environment, settings });
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
      ...createConversation({ databasePath: oldDatabase }),
      sessionId: 'session-old',
    };
    Object.assign(conversation, (await history.resolveMissingConversationSession!(conversation, root, 'session-old')).changes);

    changeRuntime(conversation, `XDG_DATA_HOME=${environment.XDG_DATA_HOME}`);

    // The old database is no longer trusted, so its history stays unreadable.
    expect(await history.recoverConversationModelSelection!(conversation, root, { environment, settings })).toBeNull();
    const hydrated = await history.hydrateConversationHistory(conversation, root, { environment, settings });
    expect(hydrated.messages ?? []).toEqual([]);
  });

  it('reads a session retired as missing once opencode serve reports it', async () => {
    const conversation: Conversation = { ...createConversation(), sessionId: 'session-migrated' };

    // A send found the session missing, so it became a recovery-only locator.
    Object.assign(conversation, (await history.resolveMissingConversationSession!(conversation, root, 'session-migrated')).changes);
    expect(history.resolveSessionIdForConversation(conversation)).toBeNull();
    expect((await history.hydrateConversationHistory(conversation, root, { environment, settings })).messages ?? []).toEqual([]);

    seedSession('session-migrated', [
      { role: 'user', text: 'Migrated prompt' },
      { role: 'assistant', text: 'Migrated reply' },
    ]);
    const migrated = await history.hydrateConversationHistory(conversation, root, { environment, settings });
    expect(migrated.messages?.map(message => message.content)).toEqual(['Migrated prompt', 'Migrated reply']);
  });

  it('reads a retired session without a recorded database from the current database', async () => {
    const conversation = createConversation({});

    // Only launch configuration changes; the native store stays where it was.
    expect(changeRuntime(conversation)).toEqual([conversation]);
    expect(history.resolveSessionIdForConversation(conversation)).toBeNull();

    expect(await history.recoverConversationModelSelection!(conversation, root, { environment, settings }))
      .toBe('opencode:google/gemini-3.5-flash');
    const hydrated = await history.hydrateConversationHistory(conversation, root, { environment, settings });
    expect(hydrated.messages?.map(message => message.content)).toEqual(['Original prompt', 'Original reply']);
  });

  it('skips a retired session without a recorded database when the current database lacks it', async () => {
    const oldDatabase = path.join(root, '.local', 'share', 'opencode', 'opencode.db');
    seedSession('session-old', [{ role: 'user', text: 'Old prompt' }], oldDatabase);
    startWithoutXdg();
    const conversation: Conversation = { ...createConversation({}), sessionId: 'session-old' };

    changeRuntime(conversation, `XDG_DATA_HOME=${environment.XDG_DATA_HOME}`);

    const hydrated = await history.hydrateConversationHistory(conversation, root, { environment, settings });
    expect(hydrated.messages ?? []).toEqual([]);
  });

  it('records the trusted database a live binding was read from so a runtime change keeps it', async () => {
    const conversation = createConversation({});
    Object.assign(conversation, await history.hydrateConversationHistory(conversation, root, { environment, settings }));
    expect(conversation.providerState?.databasePath).toBe(databasePath);

    expect(changeRuntime(conversation)).toEqual([]);

    expect(conversation.sessionId).toBe('session-original');
    expect(history.buildPersistedProviderState(conversation)).toEqual({ databasePath, nativeConversationContextEstablished: true });
  });

  function startWithoutXdg(): void {
    const config = (settings.providerConfigs as Record<string, Record<string, unknown>>).opencode;
    config.environmentVariables = '';
    config.environmentHash = undefined;
    opencodeSettingsReconciler.reconcileModelWithEnvironment(settings, []);
  }

  function createConversation(binding: { databasePath?: string } = { databasePath }): Conversation {
    return {
      createdAt: startedAt,
      id: 'conv-opencode',
      lastActivityAt: startedAt,
      messages: [],
      providerId: 'opencode',
      providerState: { ...binding, nativeConversationContextEstablished: true },
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
    const model = [...messages].reverse().find(message => message.model)?.model;
    seedFakeOpencodeSession(target, sessionId, {
      ...(model ? { model } : {}),
      messages: messages.map((message, index) => {
        const created = startedAt + index;
        const id = `${sessionId}-message-${index}`;
        return message.role === 'user'
          ? { id, type: 'user', text: message.text, time: { created } }
          : { id, type: 'assistant', content: [{ type: 'text', text: message.text }], time: { created, completed: created }, ...(message.model ? { model: message.model } : {}) };
      }),
    });
  }

});
