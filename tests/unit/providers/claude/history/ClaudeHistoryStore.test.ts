import * as fs from 'node:fs/promises';

import { loadSDKSessionMessages } from '@/providers/claude/history/ClaudeHistoryStore';

jest.mock('node:fs/promises');

const readFile = jest.mocked(fs.readFile);

beforeEach(() => jest.resetAllMocks());

it.each([
  ['<summary>Background command completed (exit code 0).</summary>', 'Background command completed (exit code 0).'],
  ['<summary>Agent finished</summary><result>There are **22** .md files.</result>', 'There are **22** .md files.'],
])('preserves the completion boundary and result in native history (%s)', async (payload, content) => {
  const entries = [
    { type: 'user', uuid: 'u', timestamp: '2026-09-20T11:29:55Z', message: { content: 'Run a task' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u', timestamp: '2026-09-20T11:30:00Z',
      message: { content: [{ type: 'text', text: 'Waiting for completion.' }] } },
    { type: 'queue-operation', operation: 'enqueue', content: `<task-notification><task-id>task-1</task-id>${payload}</task-notification>` },
    { type: 'user', uuid: 'notification', parentUuid: 'a1', timestamp: '2026-09-20T11:30:18Z',
      message: { content: `<task-notification><task-id>task-1</task-id><status>completed</status>${payload}</task-notification>` } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'notification', timestamp: '2026-09-20T11:30:23Z',
      message: { content: [{ type: 'text', text: 'Task complete.' }] } },
  ];
  readFile.mockResolvedValue(entries.map(entry => JSON.stringify(entry)).join('\n'));

  const result = await loadSDKSessionMessages('/vault', 'session', undefined, '/session.jsonl');

  expect(result.error).toBeUndefined();
  expect(result.messages).toHaveLength(3);
  expect(result.messages[1]).toMatchObject({ content: 'Waiting for completion.', durationSeconds: 5 });
  expect(result.messages[2]).toMatchObject({
    role: 'assistant', content: 'Task complete.', assistantMessageId: 'a2',
    contentBlocks: [{ type: 'task_notification', content }, { type: 'text', content: 'Task complete.' }],
  });
  expect(result.messages[2].durationSeconds).toBeUndefined();
});

it('retains separate notifications when the same task completes again after being resumed', async () => {
  const entries = [
    { type: 'user', uuid: 'u', timestamp: '2026-09-20T11:00:00Z', message: { content: 'Start' } },
    { type: 'assistant', uuid: 'a', parentUuid: 'u', timestamp: '2026-09-20T11:00:01Z',
      message: { content: [{ type: 'text', text: 'Started.' }] } },
    { type: 'user', uuid: 'n1', parentUuid: 'a', timestamp: '2026-09-20T11:00:02Z',
      message: { content: '<task-notification><task-id>same-task</task-id><status>completed</status><result>First result</result></task-notification>' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'n1', timestamp: '2026-09-20T11:00:03Z',
      message: { content: [{ type: 'text', text: 'First follow-up.' }] } },
    { type: 'user', uuid: 'n2', parentUuid: 'a1', timestamp: '2026-09-20T11:00:04Z',
      message: { content: '<task-notification><task-id>same-task</task-id><status>completed</status><result>Second result</result></task-notification>' } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'n2', timestamp: '2026-09-20T11:00:05Z',
      message: { content: [{ type: 'text', text: 'Second follow-up.' }] } },
  ];
  readFile.mockResolvedValue(entries.map(entry => JSON.stringify(entry)).join('\n'));

  const result = await loadSDKSessionMessages('/vault', 'session', undefined, '/session.jsonl');

  expect(result.messages.slice(2).map(message => message.contentBlocks)).toEqual([
    [{ type: 'task_notification', content: 'First result' }, { type: 'text', content: 'First follow-up.' }],
    [{ type: 'task_notification', content: 'Second result' }, { type: 'text', content: 'Second follow-up.' }],
  ]);
});

it('retains a new user request duration when an older task completes before its first output', async () => {
  const entries = [
    { type: 'user', uuid: 'u1', timestamp: '2026-09-20T11:00:00Z', message: { content: 'Start a background task' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-09-20T11:00:01Z',
      message: { content: [{ type: 'text', text: 'Started.' }] } },
    { type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-09-20T11:00:10Z', message: { content: 'Answer another question' } },
    { type: 'user', uuid: 'n', parentUuid: 'u2', timestamp: '2026-09-20T11:00:12Z',
      message: { content: '<task-notification><task-id>old-task</task-id><status>completed</status><result>Old task result</result></task-notification>' } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'n', timestamp: '2026-09-20T11:00:15Z',
      message: { content: [{ type: 'text', text: 'The requested answer.' }] } },
  ];
  readFile.mockResolvedValue(entries.map(entry => JSON.stringify(entry)).join('\n'));

  const result = await loadSDKSessionMessages('/vault', 'session', undefined, '/session.jsonl');

  expect(result.messages[3]).toMatchObject({
    content: 'The requested answer.', durationSeconds: 5,
    contentBlocks: [
      { type: 'task_notification', content: 'Old task result' },
      { type: 'text', content: 'The requested answer.' },
    ],
  });
});

it('keeps a user response active across a notification received between its native tool call and answer', async () => {
  const entries = [
    { type: 'user', uuid: 'u', timestamp: '2026-09-20T11:00:10Z', message: { content: 'Answer another question' } },
    { type: 'assistant', uuid: 'tool', parentUuid: 'u', timestamp: '2026-09-20T11:00:11Z',
      message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'note.md' } }] } },
    { type: 'user', uuid: 'n', parentUuid: 'tool', timestamp: '2026-09-20T11:00:12Z',
      message: { content: '<task-notification><task-id>old-task</task-id><status>completed</status><result>Old task result</result></task-notification>' } },
    { type: 'user', uuid: 'read-result', parentUuid: 'n', timestamp: '2026-09-20T11:00:13Z',
      toolUseResult: { type: 'text', file: { content: 'The note.' } },
      message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'The note.' }] } },
    { type: 'assistant', uuid: 'answer', parentUuid: 'read-result', timestamp: '2026-09-20T11:00:15Z',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The requested answer.' }] } },
  ];
  readFile.mockResolvedValue(entries.map(entry => JSON.stringify(entry)).join('\n'));

  const result = await loadSDKSessionMessages('/vault', 'session', undefined, '/session.jsonl');

  expect(result.messages).toHaveLength(2);
  expect(result.messages[1]).toMatchObject({
    content: 'The requested answer.', durationSeconds: 5,
    contentBlocks: [
      { type: 'tool_use', toolId: 'read' },
      { type: 'task_notification', content: 'Old task result' },
      { type: 'text', content: 'The requested answer.' },
    ],
  });
});

it('replays a user prompt absorbed into an automatic response from its queued-command attachment', async () => {
  const entries = [
    { type: 'user', uuid: 'u', message: { content: 'testing follow up' } },
    { type: 'assistant', uuid: 'a', parentUuid: 'u', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Still waiting.' }] } },
    { type: 'user', uuid: 'n', parentUuid: 'a', message: { content: '<task-notification><task-id>task</task-id><status>completed</status><summary>Task finished</summary></task-notification>' } },
    { type: 'assistant', uuid: 'read', parentUuid: 'n', message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'read-tool', name: 'Read', input: { file_path: '/task.output' } }] } },
    { type: 'user', uuid: 'result', parentUuid: 'read', toolUseResult: { content: '186' }, message: { content: [{ type: 'tool_result', tool_use_id: 'read-tool', content: '186' }] } },
    { type: 'attachment', uuid: 'attachment', parentUuid: 'result', timestamp: '2026-09-21T03:16:06.961Z',
      attachment: { type: 'queued_command', prompt: 'testing follow up', source_uuid: 'followup', commandMode: 'prompt' } },
    { type: 'assistant', uuid: 'final', parentUuid: 'attachment', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Bash complete: 186 files.' }] } },
  ];
  readFile.mockResolvedValue(entries.map((entry, index) => JSON.stringify({ timestamp: new Date(Date.parse('2026-09-21T03:16:01.961Z') + index * 1000).toISOString(), ...entry })).join('\n'));

  const result = await loadSDKSessionMessages('/vault', 'session', undefined, '/session.jsonl');

  expect(result.messages.map(message => [message.role, message.content])).toEqual([
    ['user', 'testing follow up'],
    ['assistant', 'Still waiting.'],
    ['assistant', ''],
    ['user', 'testing follow up'],
    ['assistant', 'Bash complete: 186 files.'],
  ]);
  expect(result.messages[3]).toMatchObject({
    id: 'followup', userMessageId: 'followup', timestamp: Date.parse('2026-09-21T03:16:06.961Z'),
  });
  expect(result.messages[2].contentBlocks).toEqual([
    { type: 'task_notification', content: 'Task finished' }, { type: 'tool_use', toolId: 'read-tool' },
  ]);
});

it.each([
  ['<summary>Background command completed (exit code 0)</summary>', 'Background command completed (exit code 0)'],
  ['<summary>Agent finished</summary><result>PROBE_CHILD_DONE</result>', 'PROBE_CHILD_DONE'],
])('replays a notification absorbed during a tool call from its queued-command attachment (%s)', async (payload, content) => {
  // Shape captured with SDK 0.3.267 / CLI 2.1.278 while a foreground tool was active.
  const notification = `<task-notification><task-id>background-task</task-id><tool-use-id>background-tool</tool-use-id><status>completed</status>${payload}</task-notification>`;
  const entries = [
    { type: 'user', uuid: 'u', timestamp: '2026-09-21T07:29:10Z', message: { content: 'Run the foreground task' } },
    { type: 'assistant', uuid: 'tool', parentUuid: 'u', timestamp: '2026-09-21T07:29:11Z',
      message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'foreground-tool', name: 'Bash', input: { command: 'node gate.cjs fg' } }] } },
    { type: 'queue-operation', operation: 'enqueue', content: notification },
    { type: 'user', uuid: 'tool-result', parentUuid: 'tool', timestamp: '2026-09-21T07:29:12Z',
      toolUseResult: { stdout: 'PROBE_FG_DONE', stderr: '', interrupted: false, isImage: false },
      message: { content: [{ type: 'tool_result', tool_use_id: 'foreground-tool', content: 'PROBE_FG_DONE' }] } },
    { type: 'attachment', uuid: 'notification-attachment', parentUuid: 'tool-result', timestamp: '2026-09-21T07:29:13Z',
      attachment: { type: 'queued_command', prompt: notification, source_uuid: 'notification-source', commandMode: 'task-notification' } },
    { type: 'assistant', uuid: 'answer', parentUuid: 'notification-attachment', timestamp: '2026-09-21T07:29:15Z',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'PROBE_FOLLOWUP_ACK' }] } },
  ];
  readFile.mockResolvedValue(entries.map(entry => JSON.stringify(entry)).join('\n'));

  const result = await loadSDKSessionMessages('/vault', 'session', undefined, '/session.jsonl');

  expect(result.error).toBeUndefined();
  expect(result.messages).toHaveLength(2);
  expect(result.messages[1]).toMatchObject({
    role: 'assistant', content: 'PROBE_FOLLOWUP_ACK', durationSeconds: 5,
    toolCalls: [{ id: 'foreground-tool', status: 'completed', result: 'PROBE_FG_DONE' }],
    contentBlocks: [
      { type: 'tool_use', toolId: 'foreground-tool' },
      { type: 'task_notification', content },
      { type: 'text', content: 'PROBE_FOLLOWUP_ACK' },
    ],
  });
});

it.each([false, true])('counts each main response once across blocks and tools (missing usage: %s)', async (missing) => {
  const entries = [
    { type: 'user', uuid: 'u', timestamp: '2026-09-20T11:00:00Z', message: { content: 'Work' } },
    { type: 'assistant', uuid: 'a1', parentUuid: 'u', timestamp: '2026-09-20T11:00:01Z',
      message: { id: 'response1', usage: missing ? undefined : { output_tokens: 100 }, stop_reason: 'tool_use',
        content: [{ type: 'thinking', thinking: 'Plan' }] } },
    { type: 'assistant', uuid: 'a2', parentUuid: 'a1', timestamp: '2026-09-20T11:00:01Z',
      message: { id: 'response1', usage: missing ? undefined : { output_tokens: 100 }, stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tool', name: 'Read', input: {} }] } },
    { type: 'user', uuid: 'tool-result', parentUuid: 'a2', timestamp: '2026-09-20T11:00:02Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'Result' }] } },
    { type: 'assistant', uuid: 'final', parentUuid: 'tool-result', timestamp: '2026-09-20T11:00:02.500Z',
      message: { id: 'response2', usage: { output_tokens: 25 }, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] } },
  ];
  readFile.mockResolvedValue(entries.map(entry => JSON.stringify(entry)).join('\n'));
  const result = await loadSDKSessionMessages('/vault', 'session', undefined, '/session.jsonl');
  expect(result.messages.at(-1)?.turnStats).toEqual(missing ? undefined : { outputTokens: 125, durationMs: 2500 });
});
