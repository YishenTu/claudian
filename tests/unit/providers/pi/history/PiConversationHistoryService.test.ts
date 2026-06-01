import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Conversation } from '@/core/types';
import { PiConversationHistoryService } from '@/providers/pi/history/PiConversationHistoryService';

function createConversation(sessionFile: string): Conversation {
  return {
    createdAt: 1,
    id: 'conv-1',
    messages: [],
    providerId: 'pi',
    providerState: { sessionFile, sessionId: 's1' },
    sessionId: 's1',
    title: 'Pi',
    updatedAt: 1,
  };
}

describe('PiConversationHistoryService', () => {
  it('hydrates from providerState sessionFile', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-'));
    const sessionFile = path.join(dir, 'session.jsonl');
    await fs.writeFile(sessionFile, JSON.stringify({
      id: 'u1',
      message: { content: 'Hello', role: 'user' },
      type: 'entry',
    }));
    const conversation = createConversation(sessionFile);
    const service = new PiConversationHistoryService();

    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]).toMatchObject({
      content: 'Hello',
      role: 'user',
    });
  });

  it('builds pending fork state from source session metadata', () => {
    const service = new PiConversationHistoryService();
    const conversation = createConversation('/tmp/session.jsonl');
    conversation.providerState = {
      forkSource: { sessionId: 'source-session', resumeAt: 'assistant-1' },
      forkSourceSessionFile: '/tmp/source.jsonl',
    };
    conversation.sessionId = null;

    expect(service.isPendingForkConversation(conversation)).toBe(true);
    expect(service.resolveSessionIdForConversation(conversation)).toBe('source-session');
    expect(service.buildForkProviderState('s1', 'checkpoint', {
      sessionFile: '/tmp/session.jsonl',
    })).toEqual({
      forkSource: { sessionId: 's1', resumeAt: 'checkpoint' },
      forkSourceSessionFile: '/tmp/session.jsonl',
    });
    expect(service.buildForkProviderState('source-session', 'checkpoint', {
      forkSource: { sessionId: 'source-session', resumeAt: 'assistant-1' },
      forkSourceSessionFile: '/tmp/source.jsonl',
    })).toEqual({
      forkSource: { sessionId: 'source-session', resumeAt: 'checkpoint' },
      forkSourceSessionFile: '/tmp/source.jsonl',
    });
  });

  it('resolves file-only Pi sessions as fork sources', () => {
    const service = new PiConversationHistoryService();
    const conversation = createConversation('/tmp/session.jsonl');
    conversation.providerState = { sessionFile: '/tmp/session.jsonl' };
    conversation.sessionId = null;

    expect(service.resolveSessionIdForConversation(conversation)).toBe('/tmp/session.jsonl');
    expect(service.buildForkProviderState('/tmp/session.jsonl', 'checkpoint', {
      sessionFile: '/tmp/session.jsonl',
    })).toEqual({
      forkSource: { sessionId: '/tmp/session.jsonl', resumeAt: 'checkpoint' },
      forkSourceSessionFile: '/tmp/session.jsonl',
    });
  });

  it('hydrates pending forks from the source session truncated at the checkpoint', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-fork-'));
    const sessionFile = path.join(dir, 'source.jsonl');
    await fs.writeFile(sessionFile, [
      JSON.stringify({ type: 'session', id: 'source-session' }),
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'First' } }),
      JSON.stringify({ id: 'a1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
      JSON.stringify({ id: 'u2', type: 'message', message: { role: 'user', content: 'Later' } }),
    ].join('\n'));
    const conversation = createConversation(sessionFile);
    conversation.messages = [];
    conversation.providerState = {
      forkSource: { sessionId: 'source-session', resumeAt: 'a1' },
      forkSourceSessionFile: sessionFile,
    };
    conversation.sessionId = null;
    const service = new PiConversationHistoryService();

    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages.map(message => message.content)).toEqual(['First', 'Done']);
  });

  it('does not hydrate pending forks when the checkpoint is missing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-fork-missing-'));
    const sessionFile = path.join(dir, 'source.jsonl');
    await fs.writeFile(sessionFile, [
      JSON.stringify({ type: 'session', id: 'source-session' }),
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'First' } }),
      JSON.stringify({ id: 'a1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
      JSON.stringify({ id: 'u2', type: 'message', message: { role: 'user', content: 'Later' } }),
    ].join('\n'));
    const conversation = createConversation(sessionFile);
    conversation.messages = [];
    conversation.providerState = {
      forkSource: { sessionId: 'source-session', resumeAt: 'missing-checkpoint' },
      forkSourceSessionFile: sessionFile,
    };
    conversation.sessionId = null;
    const service = new PiConversationHistoryService();

    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages).toEqual([]);
  });

  it('sanitizes persisted provider state', () => {
    const service = new PiConversationHistoryService();
    const conversation = createConversation('/tmp/session.jsonl');
    conversation.providerState = {
      empty: '',
      leafEntryId: 'leaf-1',
      parentSession: '/tmp/source.jsonl',
      sessionFile: '/tmp/session.jsonl',
      sessionId: 's1',
    };

    expect(service.buildPersistedProviderState?.(conversation)).toEqual({
      leafEntryId: 'leaf-1',
      parentSession: '/tmp/source.jsonl',
      sessionFile: '/tmp/session.jsonl',
      sessionId: 's1',
    });
  });
});
