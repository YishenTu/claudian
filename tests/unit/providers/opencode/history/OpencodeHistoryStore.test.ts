import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { testDate } from '@test/helpers/testClock';

import type * as environmentModule from '@/core/process/env';
import { encodeRecoveryPrompt } from '@/core/prompt/recoveryPrompt';
import { encodeSessionMessage } from '@/core/session-tools/sessionMessageEnvelope';
import {
  loadOpencodeSessionMessages,
  loadOpencodeSessionModel,
  mapOpencodeV2Messages,
  mapOpencodeV2NativeMessages,
} from '@/providers/opencode/history/OpencodeHistoryStore';

// Exercise real SQLite subprocesses without discovering the runner's other Node installations.
jest.mock('@/core/process/env', () => ({
  ...jest.requireActual<typeof environmentModule>('@/core/process/env'),
  findNodeExecutables: () => [process.execPath],
}));

describe('mapOpencodeV2NativeMessages', () => {
  it('preserves Windows paths as literal code in hydration diagnostics', () => {
    const [message] = mapOpencodeV2Messages([
      { id: 'msg-bad', type: 'user', time_created: 1_000, data: 'not json' },
    ], { databasePath: String.raw`C:\Users\cylix\.local\share\opencode\opencode.db` });
    expect(message.content).toBe([
      '```text',
      'Failed to hydrate OpenCode session.',
      'provider: OpenCode',
      String.raw`databasePath: C:\Users\cylix\.local\share\opencode\opencode.db`,
      'messageId: msg-bad',
      'reason: OpenCode message metadata is not valid JSON.',
      '```',
    ].join('\n'));
  });

  it('maps stored OpenCode messages into Claudian chat messages', () => {
    const toolState = {
      input: { filePath: 'notes/today.md' },
      output: 'read ok',
      status: 'completed',
    };
    const messages = mapOpencodeV2NativeMessages([
      {
        id: 'msg-user',
        type: 'user',
        text: 'Summarize this\n\n<current_note>\nnotes/today.md\n</current_note>',
        time: { created: 1_000 },
      },
      {
        id: 'msg-assistant',
        type: 'assistant',
        time: { created: 2_000, completed: 4_000 },
        content: [
          {
            text: 'Thinking...',
            time: { start: 2_000, end: 3_000 },
            type: 'reasoning',
          },
          {
            id: 'tool-1',
            name: 'read',
            state: toolState,
            type: 'tool',
          },
          {
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
        completedAt: 4_000,
        id: 'msg-assistant',
        role: 'assistant',
        timestamp: 2_000,
        toolCalls: [{
          id: 'tool-1',
          input: { file_path: 'notes/today.md' },
          name: 'Read',
          providerPayload: { rawInput: toolState.input, rawName: 'read', rawOutput: toolState },
          result: 'read ok',
          resultFormat: 'plain',
          status: 'completed',
        }],
      },
    ]);
  });

  it('replays a persisted late unknown tool title without remapping it', () => {
    const messages = mapOpencodeV2NativeMessages([
      { id: 'msg-user-future', type: 'user', text: 'Use future tool', time: { created: 1_000 } },
      {
        id: 'msg-assistant-future',
        type: 'assistant',
        time: { created: 2_000, completed: 3_000 },
        content: [{
          id: 'tool-future',
          name: 'future_tool',
          state: {
            input: { command: 'pwd', opaque: ['future'] },
            output: 'Concise result',
            status: 'completed',
          },
          type: 'tool',
        }],
      },
    ]);

    expect(JSON.parse(JSON.stringify(messages))[1].toolCalls[0]).toMatchObject({
      id: 'tool-future',
      input: { command: 'pwd', opaque: ['future'] },
      name: 'future_tool',
      result: 'Concise result',
      status: 'completed',
    });
  });

  it('rehydrates user file image parts', () => {
    const messages = mapOpencodeV2NativeMessages([
      {
        id: 'msg-user',
        type: 'user',
        text: 'What is in this image?',
        time: { created: 1_000 },
        files: [{
          filename: 'screenshot.png',
          mime: 'image/png',
          url: 'data:image/png;base64,aGVsbG8=',
        }],
      },
    ]);

    expect(messages[0]).toMatchObject({
      content: 'What is in this image?',
      images: [{
        data: 'aGVsbG8=',
        id: 'opencode-img-msg-user-0',
        mediaType: 'image/png',
        name: 'screenshot.png',
        size: 5,
        source: 'paste',
      }],
      role: 'user',
    });
  });

  it('hydrates stored question tools with resolved answers', () => {
    const toolState = {
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
    };
    const messages = mapOpencodeV2NativeMessages([
      {
        id: 'msg-assistant',
        type: 'assistant',
        time: { created: 2_000, completed: 4_000 },
        content: [{ id: 'tool-question', name: 'question', state: toolState, type: 'tool' }],
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
        completedAt: 4_000,
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
          providerPayload: { rawInput: toolState.input, rawName: 'question', rawOutput: toolState },
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
    const toolState = {
      input: {
        action: {
          query: 'Apple stock price today',
        },
      },
      output: 'Search complete',
      status: 'completed',
    };
    const messages = mapOpencodeV2NativeMessages([
      { id: 'msg-user', type: 'user', text: 'Search it', time: { created: 1_000 } },
      {
        id: 'msg-assistant-1',
        type: 'assistant',
        time: { created: 2_000, completed: 4_000 },
        content: [
          {
            text: 'Searching...',
            time: { start: 2_000, end: 3_000 },
            type: 'reasoning',
          },
          { id: 'tool-websearch', name: 'websearch', state: toolState, type: 'tool' },
        ],
      },
      {
        id: 'msg-assistant-2',
        type: 'assistant',
        time: { created: 4_500, completed: 7_000 },
        content: [
          {
            text: 'Summarizing...',
            time: { start: 4_500, end: 5_000 },
            type: 'reasoning',
          },
          {
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
        completedAt: 7_000,
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
          providerPayload: { rawInput: toolState.input, rawName: 'websearch', rawOutput: toolState },
          result: 'Search complete',
          status: 'completed',
        }],
      },
    ]);
  });

  it('keeps rendering surrounding messages when one message has invalid metadata', () => {
    const messages = mapOpencodeV2Messages([
      { id: 'msg-bad', type: 'user', time_created: 1_000, data: '{' },
      {
        id: 'msg-assistant',
        type: 'assistant',
        time_created: 2_000,
        data: JSON.stringify({
          time: { created: 2_000, completed: 3_000 },
          content: [{ text: 'Still visible.', type: 'text' }],
        }),
      },
    ]);

    expect(messages).toEqual([
      expect.objectContaining({
        content: [
          '```text',
          'Failed to hydrate OpenCode session.',
          'provider: OpenCode',
          'messageId: msg-bad',
          'reason: OpenCode message metadata is not valid JSON.',
          '```',
        ].join('\n'),
        id: 'opencode-hydration-error-message-msg-bad',
        role: 'assistant',
      }),
      {
        assistantMessageId: 'msg-assistant',
        content: 'Still visible.',
        contentBlocks: [{ content: 'Still visible.', type: 'text' }],
        durationSeconds: 1,
        completedAt: 3_000,
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

  // Both history queries exercise native fallback failures, whose process deadlines are 10 seconds.
  it('shows the underlying SQLite failure as a history diagnostic', async () => {
    const dbPath = path.join(tmpRoot, 'empty.db');
    new DatabaseSync(dbPath).close();
    const messages = await loadOpencodeSessionMessages('ses-empty', { databasePath: dbPath });
    expect(messages).toEqual([expect.objectContaining({
      id: 'opencode-hydration-error-session-ses-empty',
      content: expect.stringContaining('no such table: session_message'),
    })]);
    await expect(loadOpencodeSessionModel('ses-empty', { databasePath: dbPath })).resolves.toBeNull();
  }, 30_000);

  it('loads conversation content from the native session messages', async () => {
    const dbPath = path.join(tmpRoot, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    try {
      db.exec('CREATE TABLE session_message(id TEXT, session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT)');
      const sessionId = 'session-restored';
      const insert = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)');
      insert.run('msg-user', sessionId, 1, 'user', 1_000, JSON.stringify({
        text: 'Restore this session',
        time: { created: 1_000 },
      }));
      insert.run('msg-assistant', sessionId, 2, 'assistant', 2_000, JSON.stringify({
        time: { completed: 4_000, created: 2_000 },
        content: [{ text: 'Session restored.', type: 'text' }],
      }));
      insert.run('msg-other', 'other-session', 3, 'user', 3_000, JSON.stringify({ text: 'Other session' }));

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
          completedAt: 4_000,
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


it('restores OpenCode output plus reasoning across tool steps', () => {
  const messages = mapOpencodeV2NativeMessages([
    { id: 'u', type: 'user', text: 'Work', time: { created: 1000 } },
    { id: 'a', type: 'assistant', time: { created: 1200, completed: 2000 },
      finish: 'tool-calls', tokens: { output: 20, reasoning: 80 }, content: [{ type: 'text', text: 'Text' }] },
    { id: 'final', type: 'assistant', time: { created: 2500, completed: 3500 },
      finish: 'stop', tokens: { output: 10, reasoning: 15 }, content: [{ type: 'text', text: 'Text' }] },
  ]);
  expect(messages.at(-1)?.turnStats).toEqual({ outputTokens: 125, durationMs: 2500 });
});

it('omits OpenCode throughput if any step lacks usage', () => {
  const messages = mapOpencodeV2NativeMessages([
    { id: 'u', type: 'user', text: 'Work', time: { created: 1000 } },
    { id: 'a', type: 'assistant', time: { created: 1200, completed: 2000 }, content: [] },
    { id: 'final', type: 'assistant', time: { created: 2500, completed: 3500 },
      finish: 'stop', tokens: { output: 10, reasoning: 15 }, content: [{ type: 'text', text: 'Done' }] },
  ]);
  expect(messages.at(-1)?.turnStats).toBeUndefined();
});


it('reconstructs throughput from only the requested session in SQLite', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opencode-throughput-'));
  const databasePath = path.join(root, 'opencode.db');
  const db = new DatabaseSync(databasePath);
  db.exec('CREATE TABLE session_message(id TEXT, session_id TEXT, seq INTEGER, type TEXT, time_created INTEGER, data TEXT)');
  const insert = db.prepare('INSERT INTO session_message VALUES(?, ?, ?, ?, ?, ?)');
  insert.run('u', 'session', 1, 'user', 1000, JSON.stringify({ text: 'Work', time: { created: 1000 } }));
  insert.run('child-answer', 'child', 2, 'assistant', 1200, JSON.stringify({ finish: 'stop',
    time: { created: 1200, completed: 3500 }, tokens: { output: 900, reasoning: 0 }, content: [] }));
  insert.run('a', 'session', 3, 'assistant', 1200, JSON.stringify({ finish: 'stop',
    time: { created: 1200, completed: 3500 }, tokens: { output: 100, reasoning: 25 }, content: [{ type: 'text', text: 'Done' }] }));
  db.close();
  try {
    const messages = await loadOpencodeSessionMessages('session', { databasePath });
    expect(messages.at(-1)?.turnStats).toEqual({ outputTokens: 125, durationMs: 2500 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});


it.each(['sqlite', 'http'] as const)('marks a v2 turn whose idle outcome is interrupted as interrupted from %s rows', source => {
  const created = testDate().getTime();
  const entries = [
    { id: 'u1', type: 'user', time: { created }, text: 'Run the shell command' },
    { id: 'a1', type: 'assistant', time: { created: created + 1_000, streamed: created + 2_000, completed: created + 9_000 },
      content: [
        { type: 'text', text: 'Running it.' },
        { type: 'tool', id: 'shell', name: 'shell', state: { status: 'error', input: { command: 'sleep 60' },
          error: { type: 'aborted', message: 'Tool execution interrupted' } } },
      ],
      finish: 'error', rawFinish: 'tool_calls', error: { type: 'aborted', message: 'Step interrupted' },
      tokens: { output: 5 } },
    { id: 'idle1', type: 'idle', time: { created: created + 9_500 }, outcome: 'interrupted' },
    { id: 'u2', type: 'user', time: { created: created + 20_000 }, text: 'Never mind' },
    { id: 'idle2', type: 'idle', time: { created: created + 20_500 }, outcome: 'interrupted' },
    { id: 'u3', type: 'user', time: { created: created + 30_000 }, text: 'Say hi' },
    { id: 'a3', type: 'assistant', time: { created: created + 31_000, completed: created + 33_000 },
      content: [{ type: 'text', text: 'Hi' }], finish: 'stop' },
    { id: 'idle3', type: 'idle', time: { created: created + 33_500 }, outcome: 'succeeded' },
  ];
  const messages = source === 'http'
    ? mapOpencodeV2NativeMessages(entries)
    : mapOpencodeV2Messages(entries.map(({ id, type, ...data }) => ({ id, type, time_created: data.time.created, data: JSON.stringify(data) })));

  expect(messages.map(({ role, content, isInterrupt, durationSeconds, completedAt, turnStats }) => (
    { role, content, isInterrupt, durationSeconds, completedAt, turnStats }))).toEqual([
    { role: 'user', content: 'Run the shell command' },
    { role: 'assistant', content: 'Running it.', isInterrupt: true },
    { role: 'user', content: 'Never mind' },
    // Stopped before any output: a bare marker, as the live Stop renders it.
    { role: 'assistant', content: '', isInterrupt: true },
    { role: 'user', content: 'Say hi' },
    { role: 'assistant', content: 'Hi', durationSeconds: 2, completedAt: created + 33_000 },
  ].map(message => ({ isInterrupt: undefined, durationSeconds: undefined, completedAt: undefined, turnStats: undefined, ...message })));
  expect(messages[1].toolCalls).toEqual([expect.objectContaining({ id: 'shell', status: 'error' })]);
});

it.each([true, false])('applies a v2 interruption to the whole turn across compaction (output after compaction: %s)', after => {
  const created = testDate().getTime();
  const messages = mapOpencodeV2NativeMessages([
    { id: 'u1', type: 'user', time: { created }, text: 'Long task' },
    { id: 'a1', type: 'assistant', time: { created: created + 1_000, completed: created + 5_000 }, content: [{ type: 'text', text: 'Before compaction.' }] },
    { id: 'compact', type: 'compaction', time: { created: created + 6_000 }, status: 'completed', summary: 'Internal summary' },
    ...(after ? [{ id: 'a2', type: 'assistant', time: { created: created + 7_000, completed: created + 9_000 }, content: [{ type: 'text', text: 'After compaction.' }] }] : []),
    { id: 'idle', type: 'idle', time: { created: created + 9_500 }, outcome: 'interrupted' },
  ]);
  expect(messages.map(({ id, isInterrupt, durationSeconds, completedAt }) => ({ id, isInterrupt, durationSeconds, completedAt }))).toEqual([
    { id: 'u1' }, { id: 'a1' }, { id: 'compact', ...(!after ? { isInterrupt: true } : {}) }, ...(after ? [{ id: 'a2', isInterrupt: true }] : []),
  ].map(message => ({ isInterrupt: undefined, durationSeconds: undefined, completedAt: undefined, ...message })));
});

describe('OpenCode compaction boundaries', () => {
  const created = testDate().getTime();
  it.each(['completed', 'running', 'failed'])('restores only completed V2 compaction (%s)', status => {
    const messages = mapOpencodeV2NativeMessages([
      { id: 'a1', type: 'assistant', time: { created }, content: [{ type: 'text', text: 'Before' }] },
      { id: 'compact', type: 'compaction', time: { created: created + 1 }, status, summary: 'Internal summary', recent: 'Internal context' },
      { id: 'a2', type: 'assistant', time: { created: created + 2 }, content: [{ type: 'text', text: 'After' }] },
    ]);
    expect(messages.map(message => message.id)).toEqual(status === 'completed' ? ['a1', 'compact', 'a2'] : ['a1', 'a2']);
    expect(messages.filter(message => message.id === 'compact')).toMatchObject(status === 'completed'
      ? [{ content: '', role: 'assistant', contentBlocks: [{ type: 'context_compacted' }], timestamp: created + 1 }] : []);
    expect(JSON.stringify(messages)).not.toContain('Internal');
  });
});


it('decodes v2 session-message attribution before stripping prompt tags and preserves neutral tool names', () => {
  const text = encodeSessionMessage({ from: 'Research', sessionId: 'source', text: 'The result' });
  const messages = mapOpencodeV2NativeMessages([
    { id: 'user', type: 'user', text: text + '\n\n<current_note>note.md</current_note>' },
    { id: 'assistant', type: 'assistant', content: [{ type: 'tool', id: 'call', name: 'claudian_send_message', state: { status: 'completed', input: {text:'Hello'}, content: [{type:'text',text:'{}'}] } }] },
  ]);
  expect(messages[0]).toMatchObject({content:'The result',sessionMessage:{from:'Research',sessionId:'source'}});
  expect(messages[1].toolCalls?.[0]).toMatchObject({name:'claudian_send_message',providerPayload:{rawName:'claudian_send_message'}});
});

it('hides replayed history in user prompts', () => {
  const replayed = encodeRecoveryPrompt('User: Earlier\n\nAssistant: Reply', 'Follow up\n\n<current_note>note.md</current_note>');
  const replayOnly = encodeRecoveryPrompt('User: Earlier', null);
  const messages = mapOpencodeV2NativeMessages([replayed, replayOnly].map((text, index) => ({
    id: `user-${index}`, type: 'user', text, time: { created: 1_000 + index },
  })));
  expect(messages.map(message => [message.id, message.content])).toEqual([['user-0', 'Follow up']]);
});
