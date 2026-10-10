import { testDate } from '@test/helpers/testClock';

import { DeepSeekOutput, type DeepSeekOutputEvent } from '@/providers/deepseek/normalization/DeepSeekOutput';

const now = testDate().getTime();
let events: DeepSeekOutputEvent[];
let output: DeepSeekOutput;
const start = { type: 'start', attemptId: 'attempt', revision: 1, startedAfterSeq: 10, turn: 1, step: 0 };
const textChunk = (text: string, index = 0, revision = index + 2) => ({ type: 'chunk', attemptId: 'attempt', revision, index, time: now, chunk: { type: 'text-delta', index: 0, text } });
const baseline = (text: string) => ({ revision: 4, activeAttempt: { attemptId: 'attempt', startedAfterSeq: 10, turn: 1, step: 0, nextIndex: 2, stream: [{ type: 'text-chunks', time0: now, index: 0, dt: [0, 1], texts: [text.slice(0, 2), text.slice(2)] }] } });
beforeEach(() => { events = []; output = new DeepSeekOutput(event => events.push(event)); });

it('reconciles matching reconnect and durable prefixes without duplicated output', () => {
  output.frame(start); output.frame(textChunk('He'));
  output.baseline(baseline('Hello'));
  output.frame(textChunk('lo', 1, 3));
  output.record({ type: 'assistant/message', seq: 11, time: now, data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'Hello world' }] } } });
  output.record({ type: 'assistant/message', seq: 11, time: now, data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'Hello world' }] } } });
  expect(events.filter(e => e.type === 'text_delta')).toEqual([
    { type: 'text_delta', text: 'He' }, { type: 'text_delta', text: 'llo' }, { type: 'text_delta', text: ' world' },
  ]);
  expect(events.filter(e => e.type === 'assistant_message_started')).toHaveLength(1);
});

it.each(['divergent', 'abandoned', 'replacement', 'missing-chunk'])('rejects %s partial output instead of appending a contradictory answer', reason => {
  output.frame(start); output.frame(textChunk('Hello'));
  const act = () => {
    if (reason === 'divergent') output.baseline(baseline('Goodbye'));
    if (reason === 'abandoned') output.frame({ type: 'end', attemptId: 'attempt', revision: 3, index: 1, outcome: { kind: 'abandoned' } });
    if (reason === 'replacement') output.frame({ ...start, attemptId: 'new', revision: 3 });
    if (reason === 'missing-chunk') output.frame(textChunk('unseen middle', 3, 5));
  };
  expect(act).toThrow(/reload.*reopen/i);
  expect(events.filter(e => e.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'Hello' }]);
});

it('keeps native PTC dispatches nested under one execution and normalizes usage', () => {
  const tool = { type: 'tool/call', seq: 12, time: now, data: { callId: 'outer', name: 'run_code', arguments: '{"code":"await read()"}' } };
  output.record(tool); output.record(tool);
  output.record({ type: 'tool/ptc-dispatch-start', seq: 13, time: now, data: { rootCallId: 'outer', parentCallId: 'outer', subCallId: 'inner', name: 'read', arguments: { path: 'note.md' } } });
  output.record({ type: 'tool/ptc-dispatch', seq: 14, time: now, data: { rootCallId: 'outer', parentCallId: 'outer', subCallId: 'inner', name: 'read', arguments: { path: 'note.md' }, content: [{ type: 'text', text: 'note' }], isError: false } });
  output.record({ type: 'tool/result', seq: 15, time: now, data: { message: { toolCallId: 'outer', content: [{ type: 'text', text: 'done' }], isError: false } } });
  output.record({ type: 'assistant/message', seq: 16, time: now, data: { turn: 1, step: 0, message: { content: [] }, usage: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 2 } } });
  expect(events.filter(e => e.type === 'tool_started')).toMatchObject([
    { toolCallId: 'outer', name: 'exec', input: { code: 'await read()' } },
  ]);
  expect(events.filter(e => e.type === 'tool_completed')).toMatchObject([
    { toolCallId: 'outer', content: 'done', resultDetails: { scriptToolCalls: [{ name: 'Read', input: { file_path: 'note.md' }, status: 'completed' }] } },
  ]);
  expect(events.filter(e => e.type === 'tool_output')).toMatchObject([
    { toolCallId: 'outer', resultDetails: { scriptToolCalls: [{ name: 'Read', status: 'running' }] } },
    { toolCallId: 'outer', resultDetails: { scriptToolCalls: [{ name: 'Read', status: 'completed' }] } },
  ]);
  expect(events.find(e => e.type === 'usage_updated')).toMatchObject({ usage: { inputTokens: 10, contextTokens: 35, contextWindow: 0, cacheReadInputTokens: 20, cacheCreationInputTokens: 5 } });
});

it('uses the native request capacity and disjoint cache counts for context usage', () => {
  output.record({ type: 'request/context', seq: 1, data: { provider: 'native', model: 'model', contextWindow: 1000 } });
  output.record({ type: 'assistant/message', seq: 2, data: { turn: 0, step: 0, message: { content: [] }, usage: { inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 25 } } });
  expect(events.find(event => event.type === 'usage_updated')).toMatchObject({ usage: { model: 'deepseek:native/model', contextWindow: 1000, contextTokens: 175, percentage: 17.5 } });
});

it('presents native tool inputs, read windows and applied hunks in the neutral tool contract', () => {
  const call = (seq: number, callId: string, name: string, args: unknown) => output.record({ type: 'tool/call', seq, time: now, data: { callId, name, arguments: JSON.stringify(args) } });
  const result = (seq: number, toolCallId: string, text: string, meta?: unknown) => output.record({ type: 'tool/result', seq, time: now, data: { message: { toolCallId, content: [{ type: 'text', text }], isError: false }, ...(meta ? { meta } : {}) } });
  call(1, 'skill', 'skill', { name: 'obsidian-cli' });
  result(1.5, 'skill', '<skill_content name="obsidian-cli">\n<skill_resources>\nBase directory for this skill: /vault/.agents/skills/obsidian-cli\n</skill_resources>\n\n<skill_instructions>\n# Obsidian CLI\n\nUse `<path>` tags verbatim.\n</skill_instructions>\n</skill_content>');
  call(2, 'message', 'send_message', { agent_id: 'session-root', message: 'Findings' });
  call(3, 'read', 'read', { file_path: '/vault/note.md', offset: 2, limit: 2 });
  result(4, 'read', '<path>/vault/note.md</path>\n<type>file</type>\n<content>\n2: ---\n3: title: x\n\n(Showing lines 2-3 of 9. Use offset=4 to continue.)\n</content>',
    { path: '/vault/note.md', offset: 2, lines: [{ number: 2, text: '---' }, { number: 3, text: 'title: x' }], totalLines: 9, lang: 'md' });
  call(5, 'edit', 'edit', { file_path: '/vault/note.md', old_string: 'b', new_string: 'B' });
  result(6, 'edit', 'The file /vault/note.md has been updated successfully.', { diffs: [{ path: '/vault/note.md', oldText: 'a\nb\nc', newText: 'a\nB\nc' }] });
  call(7, 'write', 'write', { file_path: '/vault/new.md', content: 'x\n' });
  result(8, 'write', '<path>/vault/new.md</path>\n<type>file</type>\n<content>\nCreated file\n</content>', { operation: 'create', diffs: [] });
  expect(events.filter(e => e.type === 'tool_started')).toMatchObject([
    { name: 'Skill', input: { skill: 'obsidian-cli' } },
    { name: 'send_message', input: { target: 'session-root', message: 'Findings' } },
    { name: 'Read' }, { name: 'Edit' }, { name: 'Write' },
  ]);
  const completed = events.filter(e => e.type === 'tool_completed');
  expect(completed[0]).toMatchObject({ toolCallId: 'skill', content: '# Obsidian CLI\n\nUse `<path>` tags verbatim.' });
  expect(completed[1]).toMatchObject({ toolCallId: 'read', content: '---\ntitle: x', resultDetails: { resultFormat: 'plain' } });
  expect(completed[2]).toMatchObject({ toolCallId: 'edit', resultDetails: { diff: { filePath: '/vault/note.md', stats: { added: 1, removed: 1 }, diffLines: [
    { type: 'equal', text: 'a' }, { type: 'delete', text: 'b' }, { type: 'insert', text: 'B' }, { type: 'equal', text: 'c' },
  ] } } });
  // A created file has no applied hunk; its diff comes from the written content.
  expect(completed[3]).toMatchObject({ toolCallId: 'write' });
  expect(completed[3]).not.toHaveProperty('resultDetails.diff');
});
