import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Conversation } from '@/core/types';
import { GrokConversationHistoryService } from '@/providers/grok/history/GrokConversationHistoryService';
import { encodeGrokSessionCwd } from '@/providers/grok/history/GrokHistoryPathResolver';

describe('GrokConversationHistoryService', () => {
  let tempRoot: string;
  let vaultPath: string;
  let sessionDirectory: string;
  let updatesPath: string;
  let fixture: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'grok-history-service-'));
    vaultPath = path.join(tempRoot, 'vault');
    sessionDirectory = path.join(
      tempRoot,
      '.grok',
      'sessions',
      encodeGrokSessionCwd(vaultPath),
      'session-fixture',
    );
    updatesPath = path.join(sessionDirectory, 'updates.jsonl');
    fixture = await fs.readFile(path.join(
      process.cwd(),
      'tests/fixtures/providers/grok/history/multi-turn-updates.jsonl',
    ), 'utf8');
    await fs.mkdir(sessionDirectory, { recursive: true });
    await fs.writeFile(updatesPath, fixture, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { force: true, recursive: true });
  });

  function createConversation(): Conversation {
    return {
      createdAt: 1,
      id: 'conversation-1',
      messages: [],
      providerId: 'grok',
      providerState: { sessionDirectory: path.join(tempRoot, 'outside', 'session-fixture') },
      sessionId: 'session-fixture',
      title: 'Fixture',
      updatedAt: 1,
    };
  }

  function createSingleTurnHistory(userContent: string): string {
    return [
      {
        method: 'session/update',
        params: {
          sessionId: 'session-fixture',
          update: {
            content: { text: userContent, type: 'text' },
            sessionUpdate: 'user_message_chunk',
          },
        },
        timestamp: 100,
      },
      {
        method: 'session/update',
        params: {
          sessionId: 'session-fixture',
          update: {
            content: { text: 'Custom answer', type: 'text' },
            sessionUpdate: 'agent_message_chunk',
          },
        },
        timestamp: 101,
      },
      {
        method: 'session/update',
        params: {
          sessionId: 'session-fixture',
          update: { sessionUpdate: 'turn_completed' },
        },
        timestamp: 102,
      },
    ].map(record => JSON.stringify(record)).join('\n');
  }

  it('hydrates idempotently, repairs path hints, and never mutates native history', async () => {
    const service = new GrokConversationHistoryService();
    const conversation = createConversation();
    const context = { environment: { HOME: tempRoot } };

    await service.hydrateConversationHistory(conversation, vaultPath, context);
    expect(conversation.messages).toHaveLength(4);
    expect(conversation.providerState).toEqual({ sessionDirectory });

    await fs.writeFile(updatesPath, '', 'utf8');
    await service.hydrateConversationHistory(conversation, vaultPath, context);
    expect(conversation.messages).toHaveLength(4);

    await service.deleteConversationSession(conversation, vaultPath, context);
    expect(await fs.readFile(updatesPath, 'utf8')).toBe('');
  });

  it('leaves messages unchanged and discards untrusted hints when history is unavailable', async () => {
    const service = new GrokConversationHistoryService();
    const conversation = createConversation();
    conversation.sessionId = 'missing-session';

    await service.hydrateConversationHistory(conversation, vaultPath, {
      environment: { HOME: tempRoot },
    });

    expect(conversation.messages).toEqual([]);
    expect(conversation.providerState).toBeUndefined();
  });

  it('hydrates only from the configured home when the default home has the same session id', async () => {
    const customHome = path.join(tempRoot, 'custom-grok');
    const customSessionDirectory = path.join(
      customHome,
      'sessions',
      encodeGrokSessionCwd(vaultPath),
      'session-fixture',
    );
    await fs.mkdir(customSessionDirectory, { recursive: true });
    await fs.writeFile(
      path.join(customSessionDirectory, 'updates.jsonl'),
      createSingleTurnHistory('Custom question'),
      'utf8',
    );
    const context = { environment: { GROK_HOME: customHome, HOME: tempRoot } };
    const service = new GrokConversationHistoryService();
    const conversation = createConversation();
    conversation.providerState = { sessionDirectory };

    await service.hydrateConversationHistory(conversation, vaultPath, context);

    expect(conversation.providerState).toEqual({ sessionDirectory: customSessionDirectory });
    expect(conversation.messages.map(message => message.content)).toEqual([
      'Custom question',
      'Custom answer',
    ]);

    await fs.rm(customSessionDirectory, { recursive: true });
    const missingCustomConversation = createConversation();
    missingCustomConversation.providerState = { sessionDirectory };
    await service.hydrateConversationHistory(missingCustomConversation, vaultPath, context);

    expect(missingCustomConversation.messages).toEqual([]);
    expect(missingCustomConversation.providerState).toBeUndefined();
  });

  it('persists a pending fork and rehydrates only its source prefix when messages are absent', async () => {
    const service = new GrokConversationHistoryService();
    const providerState = service.buildForkProviderState(
      'session-fixture',
      'assistant-1',
      { sessionDirectory },
    );
    const conversation: Conversation = {
      createdAt: 1,
      id: 'conversation-fork',
      messages: [],
      providerId: 'grok',
      providerState,
      sessionId: null,
      title: 'Fork',
      updatedAt: 1,
    };

    expect(service.isPendingForkConversation(conversation)).toBe(true);
    expect(service.resolveSessionIdForConversation(conversation)).toBe('session-fixture');
    expect(providerState).toEqual({
      forkSource: { resumeAt: 'assistant-1', sessionId: 'session-fixture' },
      forkSourceSessionDirectory: sessionDirectory,
    });

    await service.hydrateConversationHistory(conversation, vaultPath, {
      environment: { HOME: tempRoot },
    });

    expect(conversation.messages.map(message => message.id)).toEqual([
      'user-1',
      'assistant-1',
    ]);
    expect(service.buildPersistedProviderState(conversation)).toEqual(providerState);
  });

  it('rehydrates native Grok image blocks into persisted message attachments', async () => {
    const imageHistory = [
      {
        content: { text: 'Inspect this', type: 'text' },
        messageId: 'user-image',
        sessionUpdate: 'user_message_chunk',
      },
      {
        content: { data: 'aGVsbG8=', mimeType: 'image/png', type: 'image' },
        messageId: 'user-image',
        sessionUpdate: 'user_message_chunk',
      },
      {
        content: { text: 'Visible', type: 'text' },
        messageId: 'assistant-image',
        sessionUpdate: 'agent_message_chunk',
      },
      { sessionUpdate: 'turn_completed' },
    ].map((update, index) => JSON.stringify({
      method: 'session/update',
      params: { sessionId: 'session-fixture', update },
      timestamp: 700 + index,
    })).join('\n');
    await fs.writeFile(updatesPath, imageHistory, 'utf8');
    const service = new GrokConversationHistoryService();
    const conversation = createConversation();

    await service.hydrateConversationHistory(conversation, vaultPath, {
      environment: { HOME: tempRoot },
    });

    expect(conversation.messages[0]).toMatchObject({
      content: 'Inspect this',
      images: [{
        data: 'aGVsbG8=',
        mediaType: 'image/png',
        size: 5,
      }],
    });
  });
});
