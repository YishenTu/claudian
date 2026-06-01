import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  loadOpencodeSessionMessages,
  mapOpencodeMessages,
  OPENCODE_MESSAGE_ROW_SQL,
} from '../../../../src/providers/opencode/history/OpencodeHistoryStore';

describe('mapOpencodeMessages', () => {
  it('maps stored OpenCode messages into Claudian chat messages', () => {
    const messages = mapOpencodeMessages([
      {
        info: {
          id: 'msg-user',
          role: 'user',
          time: { created: 1_000 },
        },
        parts: [
          {
            id: 'part-user',
            text: 'Summarize this\n\n<current_note>\nnotes/today.md\n</current_note>',
            type: 'text',
          },
        ],
      },
      {
        info: {
          id: 'msg-assistant',
          role: 'assistant',
          time: { created: 2_000, completed: 4_000 },
        },
        parts: [
          {
            id: 'part-thinking',
            text: 'Thinking...',
            time: { start: 2_000, end: 3_000 },
            type: 'reasoning',
          },
          {
            callID: 'tool-1',
            id: 'part-tool',
            state: {
              input: { filePath: 'notes/today.md' },
              output: 'read ok',
              status: 'completed',
            },
            tool: 'read',
            type: 'tool',
          },
          {
            id: 'part-text',
            text: 'Done.',
            type: 'text',
          },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        assistantMessageId: undefined,
        content: 'Summarize this',
        id: 'msg-user',
        role: 'user',
        timestamp: 1_000,
        userMessageId: 'msg-user',
      },
      {
        assistantMessageId: 'msg-assistant',
        content: 'Done.',
        contentBlocks: [
          { content: 'Thinking...', durationSeconds: 1, type: 'thinking' },
          { toolId: 'tool-1', type: 'tool_use' },
          { content: 'Done.', type: 'text' },
        ],
        durationSeconds: 2,
        id: 'msg-assistant',
        role: 'assistant',
        timestamp: 2_000,
        toolCalls: [{
          id: 'tool-1',
          input: { file_path: 'notes/today.md' },
          name: 'Read',
          result: 'read ok',
          status: 'completed',
        }],
      },
    ]);
  });

  it('hydrates stored question tools with resolved answers', () => {
    const messages = mapOpencodeMessages([
      {
        info: {
          id: 'msg-assistant',
          role: 'assistant',
          time: { created: 2_000, completed: 4_000 },
        },
        parts: [
          {
            callID: 'tool-question',
            id: 'part-tool',
            state: {
              input: {
                questions: [{
                  header: 'Deploy',
                  id: 'deploy',
                  options: [
                    { description: 'Ship the change', label: 'Yes' },
                    { description: 'Hold the deploy', label: 'No' },
                  ],
                  question: 'Deploy now?',
                }],
              },
              metadata: {
                answers: [['Yes']],
              },
              output: 'User has answered your questions.',
              status: 'completed',
            },
            tool: 'question',
            type: 'tool',
          },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        assistantMessageId: 'msg-assistant',
        content: '',
        contentBlocks: [
          { toolId: 'tool-question', type: 'tool_use' },
        ],
        durationSeconds: 2,
        id: 'msg-assistant',
        role: 'assistant',
        timestamp: 2_000,
        toolCalls: [{
          id: 'tool-question',
          input: {
            questions: [{
              header: 'Deploy',
              id: 'deploy',
              multiSelect: false,
              options: [
                { description: 'Ship the change', label: 'Yes' },
                { description: 'Hold the deploy', label: 'No' },
              ],
              question: 'Deploy now?',
            }],
          },
          name: 'AskUserQuestion',
          resolvedAnswers: {
            deploy: 'Yes',
            'Deploy now?': 'Yes',
          },
          result: 'User has answered your questions.',
          status: 'completed',
        }],
      },
    ]);
  });

  it('merges adjacent assistant fragments from one OpenCode turn', () => {
    const messages = mapOpencodeMessages([
      {
        info: {
          id: 'msg-user',
          role: 'user',
          time: { created: 1_000 },
        },
        parts: [
          {
            id: 'part-user',
            text: 'Search it',
            type: 'text',
          },
        ],
      },
      {
        info: {
          id: 'msg-assistant-1',
          role: 'assistant',
          time: { created: 2_000, completed: 4_000 },
        },
        parts: [
          {
            id: 'part-thinking-1',
            text: 'Searching...',
            time: { start: 2_000, end: 3_000 },
            type: 'reasoning',
          },
          {
            callID: 'tool-websearch',
            id: 'part-tool',
            state: {
              input: {
                action: {
                  query: 'Apple stock price today',
                },
              },
              output: 'Search complete',
              status: 'completed',
            },
            tool: 'websearch',
            type: 'tool',
          },
        ],
      },
      {
        info: {
          id: 'msg-assistant-2',
          role: 'assistant',
          time: { created: 4_500, completed: 7_000 },
        },
        parts: [
          {
            id: 'part-thinking-2',
            text: 'Summarizing...',
            time: { start: 4_500, end: 5_000 },
            type: 'reasoning',
          },
          {
            id: 'part-text',
            text: 'Apple is trading at $272.41.',
            type: 'text',
          },
        ],
      },
    ]);

    expect(messages).toEqual([
      {
        assistantMessageId: undefined,
        content: 'Search it',
        id: 'msg-user',
        role: 'user',
        timestamp: 1_000,
        userMessageId: 'msg-user',
      },
      {
        assistantMessageId: 'msg-assistant-2',
        content: 'Apple is trading at $272.41.',
        contentBlocks: [
          { content: 'Searching...', durationSeconds: 1, type: 'thinking' },
          { toolId: 'tool-websearch', type: 'tool_use' },
          { content: 'Summarizing...', durationSeconds: 0.5, type: 'thinking' },
          { content: 'Apple is trading at $272.41.', type: 'text' },
        ],
        durationSeconds: 5,
        id: 'msg-assistant-1',
        role: 'assistant',
        timestamp: 2_000,
        toolCalls: [{
          id: 'tool-websearch',
          input: {
            actionType: 'search',
            query: 'Apple stock price today',
          },
          name: 'WebSearch',
          result: 'Search complete',
          status: 'completed',
        }],
      },
    ]);
  });

  it('keeps rendering surrounding messages when one message has invalid metadata', () => {
    const messages = mapOpencodeMessages([
      {
        info: {
          data_valid: 0,
          id: 'msg-bad',
        },
        parts: [],
      },
      {
        info: {
          id: 'msg-assistant',
          role: 'assistant',
          time: { created: 2_000, completed: 3_000 },
        },
        parts: [
          {
            id: 'part-text',
            text: 'Still visible.',
            type: 'text',
          },
        ],
      },
    ]);

    expect(messages).toEqual([
      expect.objectContaining({
        content: [
          'Failed to hydrate OpenCode session.',
          'provider: OpenCode',
          'messageId: msg-bad',
          'reason: OpenCode message metadata is not valid JSON.',
        ].join('\n'),
        id: 'opencode-hydration-error-message-msg-bad',
        role: 'assistant',
      }),
      {
        assistantMessageId: 'msg-assistant',
        content: 'Still visible.',
        contentBlocks: [{ content: 'Still visible.', type: 'text' }],
        durationSeconds: 1,
        id: 'msg-assistant',
        role: 'assistant',
        timestamp: 2_000,
      },
    ]);
  });
});

describe('loadOpencodeSessionMessages', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'claudian-opencode-history-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, { force: true, recursive: true });
  });

  it('loads conversation content without selecting raw message metadata', async () => {
    expect(OPENCODE_MESSAGE_ROW_SQL).toContain("json_extract(data, '$.role')");
    expect(OPENCODE_MESSAGE_ROW_SQL).not.toMatch(/\btime_created,\s*data\s+from\s+message\b/i);

    const dbPath = path.join(tmpRoot, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table message (
          id text primary key,
          session_id text not null,
          time_created integer not null,
          data text not null
        );
        create table part (
          id text primary key,
          session_id text not null,
          message_id text not null,
          data text not null
        );
      `);

      const sessionId = 'session-with-summary-diffs';
      const largeMetadata = {
        diffs: Array.from({ length: 64 }, (_, index) => ({
          path: `src/file-${index}.ts`,
          patch: `@@ -1 +1 @@\n-${'old'.repeat(1000)}\n+${'new'.repeat(1000)}`,
        })),
      };

      db.prepare('insert into message (id, session_id, time_created, data) values (?, ?, ?, ?)').run(
        'msg-user',
        sessionId,
        1_000,
        JSON.stringify({
          role: 'user',
          summary: largeMetadata,
          time: { created: 1_000 },
        }),
      );
      db.prepare('insert into message (id, session_id, time_created, data) values (?, ?, ?, ?)').run(
        'msg-assistant',
        sessionId,
        2_000,
        JSON.stringify({
          role: 'assistant',
          summary: largeMetadata,
          time: { completed: 4_000, created: 2_000 },
        }),
      );
      db.prepare('insert into part (id, session_id, message_id, data) values (?, ?, ?, ?)').run(
        'part-user',
        sessionId,
        'msg-user',
        JSON.stringify({ text: 'Restore this session', type: 'text' }),
      );
      db.prepare('insert into part (id, session_id, message_id, data) values (?, ?, ?, ?)').run(
        'part-assistant',
        sessionId,
        'msg-assistant',
        JSON.stringify({ text: 'Session restored.', type: 'text' }),
      );

      await expect(loadOpencodeSessionMessages(sessionId, { databasePath: dbPath })).resolves.toEqual([
        {
          assistantMessageId: undefined,
          content: 'Restore this session',
          id: 'msg-user',
          role: 'user',
          timestamp: 1_000,
          userMessageId: 'msg-user',
        },
        {
          assistantMessageId: 'msg-assistant',
          content: 'Session restored.',
          contentBlocks: [{ content: 'Session restored.', type: 'text' }],
          durationSeconds: 2,
          id: 'msg-assistant',
          role: 'assistant',
          timestamp: 2_000,
        },
      ]);
    } finally {
      db.close();
    }
  });
});
