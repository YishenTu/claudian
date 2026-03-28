import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { Conversation } from '@/core/types';
import { CodexConversationHistoryService } from '@/providers/codex/history/CodexConversationHistoryService';

describe('CodexConversationHistoryService', () => {
  let homeDirSpy: jest.SpyInstance<string, []>;
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-codex-home-'));
    homeDirSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
  });

  afterEach(() => {
    homeDirSpy.mockRestore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('hydrates history by resolving the transcript path from thread id', async () => {
    const threadId = 'thread-123';
    const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-27T00-00-00-${threadId}.jsonl`,
    );

    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Summarize this file.' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Here is the summary.' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const conversation: Conversation = {
      id: 'conv-1',
      providerId: 'codex',
      title: 'Codex Transcript',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: threadId,
      providerState: { threadId },
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]).toMatchObject({
      role: 'user',
      content: 'Summarize this file.',
    });
    expect(conversation.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'Here is the summary.',
    });
    expect((conversation.providerState as Record<string, unknown>).sessionFilePath).toBe(transcriptPath);
  });

  it('rehydrates when the same conversation id is restored with empty messages', async () => {
    const threadId = 'thread-456';
    const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-27T00-00-00-${threadId}.jsonl`,
    );

    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'First prompt' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'First answer' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    const conversation: Conversation = {
      id: 'conv-2',
      providerId: 'codex',
      title: 'Reloaded Codex Transcript',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: threadId,
      providerState: { threadId, sessionFilePath: transcriptPath },
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    await service.hydrateConversationHistory(conversation, null);
    expect(conversation.messages).toHaveLength(2);

    conversation.messages = [];
    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[1]).toMatchObject({
      role: 'assistant',
      content: 'First answer',
    });
  });

  it('retries hydration after an empty transcript parse', async () => {
    const threadId = 'thread-789';
    const sessionsDir = path.join(tempHome, '.codex', 'sessions', '2026', '03', '27');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const transcriptPath = path.join(
      sessionsDir,
      `rollout-2026-03-27T00-00-00-${threadId}.jsonl`,
    );

    fs.writeFileSync(transcriptPath, '', 'utf-8');

    const conversation: Conversation = {
      id: 'conv-3',
      providerId: 'codex',
      title: 'Eventually Written Transcript',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sessionId: threadId,
      providerState: { threadId, sessionFilePath: transcriptPath },
      messages: [],
    };

    const service = new CodexConversationHistoryService();
    await service.hydrateConversationHistory(conversation, null);
    expect(conversation.messages).toEqual([]);

    fs.writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: '2026-03-27T00:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Second prompt' }],
          },
        }),
        JSON.stringify({
          timestamp: '2026-03-27T00:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Second answer' }],
          },
        }),
      ].join('\n'),
      'utf-8',
    );

    await service.hydrateConversationHistory(conversation, null);

    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]).toMatchObject({
      role: 'user',
      content: 'Second prompt',
    });
  });
});
