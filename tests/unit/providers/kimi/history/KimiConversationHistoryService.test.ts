import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Conversation } from '@/core/types';
import { KimiConversationHistoryService } from '@/providers/kimi/history/KimiConversationHistoryService';
import { encodeKimiSessionCwd } from '@/providers/kimi/history/KimiHistoryPathResolver';

describe('KimiConversationHistoryService', () => {
  let tempRoot: string;
  let vaultPath: string;
  let sessionDirectory: string;
  let wirePath: string;
  let fixture: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kimi-history-service-'));
    vaultPath = path.join(tempRoot, 'vault');
    sessionDirectory = path.join(
      tempRoot,
      '.kimi',
      'sessions',
      encodeKimiSessionCwd(vaultPath),
      'session-fixture',
    );
    wirePath = path.join(sessionDirectory, 'wire.jsonl');
    fixture = await fs.readFile(path.join(
      process.cwd(),
      'tests/unit/providers/kimi/fixtures/wire.jsonl',
    ), 'utf8');
    await fs.mkdir(sessionDirectory, { recursive: true });
    await fs.writeFile(wirePath, fixture, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  function createConversation(): Conversation {
    return {
      createdAt: 1,
      id: 'conversation-1',
      messages: [],
      providerId: 'kimi',
      providerState: { sessionDirectory: path.join(tempRoot, 'outside', 'session-fixture') },
      sessionId: 'session-fixture',
      title: 'Fixture',
      updatedAt: 1,
    };
  }

  it('hydrates idempotently, repairs path hints, and never mutates native history', async () => {
    const service = new KimiConversationHistoryService();
    const conversation = createConversation();
    const context = { environment: { HOME: tempRoot } };

    await service.hydrateConversationHistory(conversation, vaultPath, context);
    expect(conversation.messages).toHaveLength(6);
    expect(conversation.messages[0]).toMatchObject({
      content: 'Inspect the sample file.',
      role: 'user',
    });
    expect(conversation.providerState).toEqual({ sessionDirectory });

    await fs.writeFile(wirePath, '', 'utf8');
    await service.hydrateConversationHistory(conversation, vaultPath, context);
    expect(conversation.messages).toHaveLength(6);

    await service.deleteConversationSession(conversation, vaultPath, context);
    expect(await fs.readFile(wirePath, 'utf8')).toBe('');
    expect(await fs.stat(sessionDirectory)).toBeTruthy();
  });

  it('rehydrates when the session binding changes even if messages exist', async () => {
    const service = new KimiConversationHistoryService();
    const conversation = createConversation();
    const context = { environment: { HOME: tempRoot } };

    await service.hydrateConversationHistory(conversation, vaultPath, context);
    expect(conversation.messages).toHaveLength(6);

    await fs.writeFile(wirePath, [
      JSON.stringify({
        message: { payload: { user_input: 'Only question' }, type: 'TurnBegin' },
        timestamp: 42,
      }),
    ].join('\n'), 'utf8');
    conversation.sessionId = 'session-fixture';
    conversation.providerState = { sessionDirectory };
    (conversation as { id: string }).id = 'conversation-2';

    await service.hydrateConversationHistory(conversation, vaultPath, context);
    expect(conversation.messages.map(message => message.content)).toEqual(['Only question']);
  });

  it('leaves messages unchanged and discards untrusted hints when history is unavailable', async () => {
    const service = new KimiConversationHistoryService();
    const conversation = createConversation();
    conversation.sessionId = 'missing-session';

    await service.hydrateConversationHistory(conversation, vaultPath, {
      environment: { HOME: tempRoot },
    });

    expect(conversation.messages).toEqual([]);
    expect(conversation.providerState).toBeUndefined();
  });

  it('does nothing without a session id or path context', async () => {
    const service = new KimiConversationHistoryService();
    const conversation = createConversation();
    conversation.sessionId = null;

    await service.hydrateConversationHistory(conversation, vaultPath, {
      environment: { HOME: tempRoot } });
    expect(conversation.messages).toEqual([]);

    conversation.sessionId = 'session-fixture';
    await service.hydrateConversationHistory(conversation, vaultPath);
    expect(conversation.messages).toEqual([]);
  });

  it('does not support forking and resolves session ids from the conversation', () => {
    const service = new KimiConversationHistoryService();
    const conversation = createConversation();

    expect(service.isPendingForkConversation(conversation)).toBe(false);
    expect(service.buildForkProviderState('session-fixture', 'assistant-1', {
      sessionDirectory,
    })).toEqual({});
    expect(service.resolveSessionIdForConversation(conversation)).toBe('session-fixture');
    expect(service.resolveSessionIdForConversation(null)).toBeNull();
    expect(service.buildPersistedProviderState(conversation)).toEqual({
      sessionDirectory: path.join(tempRoot, 'outside', 'session-fixture'),
    });
    conversation.providerState = undefined;
    expect(service.buildPersistedProviderState(conversation)).toBeUndefined();
  });
});
