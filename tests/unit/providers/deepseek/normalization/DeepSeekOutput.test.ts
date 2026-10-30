import { testDate } from '@test/helpers/testClock';

import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';
import { DeepSeekOutput, type DeepSeekOutputEvent, DeepSeekReplayError } from '@/providers/deepseek/normalization/DeepSeekOutput';

const now = testDate().getTime();
let events: DeepSeekOutputEvent[];
let output: DeepSeekOutput;
const start = { type: 'start', attemptId: 'attempt', revision: 1, startedAfterSeq: 10, turn: 1, step: 0 };
const textChunk = (text: string, index = 0, revision = index + 2) => ({ type: 'chunk', attemptId: 'attempt', revision, index, time: now, chunk: { type: 'text-delta', index: 0, text } });
const baseline = (text: string) => ({ revision: 4, activeAttempt: { attemptId: 'attempt', startedAfterSeq: 10, turn: 1, step: 0, nextIndex: 2, stream: [{ type: 'text-chunks', time0: now, index: 0, dt: [0, 1], texts: [text.slice(0, 2), text.slice(2)] }] } });
beforeEach(() => { events = []; output = new DeepSeekOutput(event => events.push(event)); });

describe('reasoning whitespace normalization', () => {
  const chunk = (index: number, value: unknown) => output.frame({ type: 'chunk', attemptId: 'attempt', revision: index + 2, index, chunk: value });
  const delta = (index: number, text: string) => chunk(index, { type: 'reasoning-delta', index: 0, text });
  const settle = (path: string, text: string, kind = 'reasoning') => {
    const block = { type: kind, text };
    if (path === 'live') chunk(1, { type: 'block-end', index: 0, block });
    else if (path === 'reconnect') output.baseline({ revision: 3, activeAttempt: { ...start, nextIndex: 2, stream: [
      { type: 'reasoning-chunks', index: 0, texts: ['Example reasoning\n\n'] },
      { type: 'chunk', chunk: { type: 'block-end', index: 0, block } },
    ] } });
    else output.record({ type: 'assistant/message', seq: 11, data: { turn: 1, step: 0, message: { content: [block] } } });
  };
  const thinking = () => events.filter(e => e.type === 'thinking_delta').map(e => e.text).join('');

  it.each(['live', 'reconnect', 'durable'])('accepts trailing whitespace normalization through %s and durable reconciliation', path => {
    output.frame(start); delta(0, 'Example reasoning\n\n');
    settle(path, 'Example reasoning');
    settle('durable', 'Example reasoning');
    expect(thinking()).toBe('Example reasoning');
    expect(events.filter(e => e.type === 'assistant_message_started')).toHaveLength(1);
  });

  it.each([
    ['live', ''], ['live', '\n'], ['reconnect', ''], ['reconnect', '\n'],
  ])('continues after %s normalization with suffix %j without duplicated whitespace', (path, whitespace) => {
    output.frame(start); delta(0, 'Example reasoning\n\n');
    settle(path, `Example reasoning${whitespace}`);
    delta(2, '\n'); delta(3, 'continued\t ');
    const expected = `Example reasoning${whitespace}\ncontinued`;
    settle('durable', expected);
    expect(thinking()).toBe(expected);
  });

  it('preserves internal whitespace across append-only reasoning deltas and settlement', () => {
    output.frame(start); delta(0, 'Example '); delta(1, '\n\t'); delta(2, 'reasoning');
    chunk(3, { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Example \n\treasoning completed\n\n' } });
    settle('durable', 'Example \n\treasoning completed');
    expect(thinking()).toBe('Example \n\treasoning completed');
  });

  describe.each(['live', 'reconnect', 'durable'])('%s divergence', path => {
    it.each([
      ['replacement', 'Different reasoning', 'reasoning'],
      ['truncation', 'Example reason', 'reasoning'],
      ['internal whitespace replacement', 'Example\nreasoning', 'reasoning'],
      ['kind change', 'Example reasoning', 'text'],
    ])('rejects %s', (_name, text, kind) => {
      output.frame(start); delta(0, 'Example reasoning\n\n');
      const before = [...events];
      expect(() => settle(path, text, kind)).toThrow(DeepSeekReplayError);
      expect(events).toEqual(before);
    });
  });

  it.each(['live', 'reconnect', 'durable'])('keeps text whitespace strict through %s', path => {
    output.frame(start); output.frame(textChunk('Example reasoning\n\n'));
    expect(() => settle(path, 'Example reasoning', 'text')).toThrow(DeepSeekReplayError);
  });
});

it('reconciles matching reconnect and durable prefixes without duplicated output', () => {
  output.frame(start); output.frame(textChunk('He'));
  output.baseline(baseline('Hello'));
  output.frame(textChunk('lo', 1, 3));
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

it('renders a native retry of a settled step from the durable log after the interrupted attempt', () => {
  const reasoning = { type: 'reasoning-chunks', time0: now, index: 0, dt: [0], texts: ['Thinking'] };
  output.record({ type: 'assistant/attempt', seq: 86, time: now, data: { turn: 1, step: 11, stream: [reasoning] } });
  output.record({ type: 'assistant/attempt', seq: 89, time: now, data: { turn: 1, step: 11, stream: [] } });
  output.record({ type: 'assistant/message', seq: 92, time: now, data: { turn: 1, step: 11, message: { content: [{ type: 'text', text: 'Answer' }] } } });
  expect(events.filter(e => e.type === 'thinking_delta' || e.type === 'text_delta')).toEqual([
    { type: 'thinking_delta', text: 'Thinking' }, { type: 'text_delta', text: 'Answer' },
  ]);
});

it('appends a live native retry and matches late durable records to their own attempt', () => {
  output.frame(start); output.frame(textChunk('Hel'));
  output.frame({ type: 'end', attemptId: 'attempt', revision: 3, index: 1, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 20 } });
  output.frame({ ...start, attemptId: 'retry', revision: 4 });
  output.frame({ ...textChunk('Hello'), attemptId: 'retry', revision: 5 });
  output.record({ type: 'assistant/attempt', seq: 20, time: now, data: { turn: 1, step: 0, stream: [{ type: 'text-chunks', time0: now, index: 0, dt: [0], texts: ['Hel'] }] } });
  output.record({ type: 'assistant/message', seq: 21, time: now, data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'Hello world' }] } } });
  expect(events.filter(e => e.type === 'text_delta')).toEqual([
    { type: 'text_delta', text: 'Hel' }, { type: 'text_delta', text: 'Hello' }, { type: 'text_delta', text: ' world' },
  ]);
});

it.each([
  ['read', 'Read', { file_path: 'note.md' }],
  ['Custom.Tool', 'Custom.Tool', { path: 'note.md' }],
  ['constructor', 'constructor', { path: 'note.md' }],
  ['toString', 'toString', { path: 'note.md' }],
  ['hasOwnProperty', 'hasOwnProperty', { path: 'note.md' }],
  ['__proto__', '__proto__', { path: 'note.md' }],
])('keeps native PTC %s dispatches nested under one execution and normalizes usage', (name, expectedName, input) => {
  const tool = { type: 'tool/call', seq: 12, time: now, data: { callId: 'outer', name: 'run_code', arguments: '{"code":"await read()"}' } };
  output.record(tool); output.record(tool);
  output.record({ type: 'tool/ptc-dispatch-start', seq: 13, time: now, data: { rootCallId: 'outer', parentCallId: 'outer', subCallId: 'inner', name, arguments: { path: 'note.md' } } });
  expect(output.call('inner')).toEqual({ name: expectedName, input });
  output.record({ type: 'tool/ptc-dispatch', seq: 14, time: now, data: { rootCallId: 'outer', parentCallId: 'outer', subCallId: 'inner', name, arguments: { path: 'note.md' }, content: [{ type: 'text', text: 'note' }], isError: false } });
  expect(output.call('inner')).toEqual({ name: expectedName, input });
  output.record({ type: 'tool/result', seq: 15, time: now, data: { message: { toolCallId: 'outer', content: [{ type: 'text', text: 'done' }], isError: false } } });
  output.record({ type: 'assistant/message', seq: 16, time: now, data: { turn: 1, step: 0, message: { content: [] }, usage: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 2 } } });
  expect(events.filter(e => e.type === 'tool_started')).toMatchObject([
    { toolCallId: 'outer', name: 'exec', input: { code: 'await read()' } },
  ]);
  expect(events.filter(e => e.type === 'tool_completed')).toMatchObject([
    { toolCallId: 'outer', content: 'done', resultDetails: { scriptToolCalls: [{ name: expectedName, input, status: 'completed' }] } },
  ]);
  expect(events.filter(e => e.type === 'tool_output')).toMatchObject([
    { toolCallId: 'outer', resultDetails: { scriptToolCalls: [{ name: expectedName, input, status: 'running' }] } },
    { toolCallId: 'outer', resultDetails: { scriptToolCalls: [{ name: expectedName, input, status: 'completed' }] } },
  ]);
  expect(events.find(e => e.type === 'usage_updated')).toMatchObject({ usage: { inputTokens: 10, contextTokens: 35, contextWindow: 0, cacheReadInputTokens: 20, cacheCreationInputTokens: 5 } });
});

it.each([
  ['read', 'Read', { file_path: 'note.md' }],
  ['Custom.Tool', 'Custom.Tool', { path: 'note.md' }],
  ['constructor', 'constructor', { path: 'note.md' }],
  ['toString', 'toString', { path: 'note.md' }],
  ['hasOwnProperty', 'hasOwnProperty', { path: 'note.md' }],
  ['__proto__', '__proto__', { path: 'note.md' }],
])('preserves the tool contract for %s through completion', (name, expectedName, input) => {
  output.record({ type: 'tool/call', seq: 1, time: now, data: { callId: 'custom', name, arguments: '{"path":"note.md"}' } });
  output.record({ type: 'tool/result', seq: 2, time: now, data: { message: { toolCallId: 'custom', content: [{ type: 'text', text: 'result text' }], isError: false } } });
  expect(output.call('custom')).toEqual({ name: expectedName, input });
  expect(events.filter(event => event.type === 'tool_started')).toEqual([
    { type: 'tool_started', toolCallId: 'custom', name: expectedName, input, toolScope: { kind: 'main' }, providerPayload: { rawName: name } },
  ]);
  expect(events.filter(event => event.type === 'tool_completed')).toEqual([
    { type: 'tool_completed', toolCallId: 'custom', content: 'result text', isError: false, toolScope: { kind: 'main' }, resultDetails: { resultFormat: 'plain' } },
  ]);
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
  // Windows composes native pwsh in place of bash; both are shell commands.
  call(7.5, 'pwsh', 'pwsh', { command: 'Get-ChildItem', description: 'List files' });
  result(8, 'write', '<path>/vault/new.md</path>\n<type>file</type>\n<content>\nCreated file\n</content>', { operation: 'create', diffs: [] });
  expect(events.filter(e => e.type === 'tool_started')).toMatchObject([
    { name: 'Skill', input: { skill: 'obsidian-cli' } },
    { name: 'send_message', input: { target: 'session-root', message: 'Findings' } },
    { name: 'Read' }, { name: 'Edit' }, { name: 'Write' },
    { name: 'Bash', input: { command: 'Get-ChildItem', description: 'List files' } },
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

describe('native ask_user_question results', () => {
  // Captured from a native transcript: two questions, each answered with its recommended option.
  const questions = [
    { id: 'round9', header: 'Round 9', question: 'Record it in DEMO.md as a Round 9 section?', options: [{ label: 'Append a short Round 9 (Recommended)' }, { label: 'Skip it' }] },
    { id: 'tag', header: 'Stray tag', question: 'Find the stray tag?', options: [{ label: 'Yes, find it (Recommended)' }, { label: 'No' }], multi_select: true },
  ];
  const ask = (text: string, isError = false) => {
    output.record({ type: 'tool/call', seq: 1, time: now, data: { callId: 'ask', name: 'ask_user_question', arguments: JSON.stringify({ questions }) } });
    output.record({ type: 'tool/result', seq: 2, time: now, data: { message: { toolCallId: 'ask', content: [{ type: 'text', text }], isError } } });
    return events.find(e => e.type === 'tool_completed');
  };

  it('presents native questions with the neutral multi-select flag', () => {
    ask('{"pending":true,"callId":"ask","message":"No answer batch arrived before the timeout."}');
    expect(events.find(e => e.type === 'tool_started')).toMatchObject({ name: 'AskUserQuestion', input: { questions: [
      { id: 'round9', question: questions[0].question }, { id: 'tag', question: questions[1].question, multiSelect: true },
    ] } });
  });

  it.each([
    { name: 'selected options of every question', text: '{"answers":[{"id":"round9","selected":["Append a short Round 9 (Recommended)"]},{"id":"tag","selected":["Yes, find it (Recommended)"]}]}',
      answers: { round9: 'Append a short Round 9 (Recommended)', tag: 'Yes, find it (Recommended)' } },
    { name: 'a custom answer replacing a single choice and supplementing a multi-select', text: '{"answers":[{"id":"round9","selected":[],"custom":"Only in chat"},{"id":"tag","selected":["Yes, find it (Recommended)"],"custom":"Also the footer"}]}',
      answers: { round9: 'Only in chat', tag: ['Yes, find it (Recommended)', 'Also the footer'] } },
    { name: 'a skipped question beside an answered one', text: '{"answers":[{"id":"round9","selected":[]},{"id":"tag","selected":["No"]}]}',
      answers: { tag: 'No' } },
  ])('resolves $name keyed by native question ID', ({ text, answers }) => {
    const completed = ask(text);
    expect(completed).toMatchObject({ isError: false });
    expect(completed).toHaveProperty('resultDetails.resolvedAnswers', answers);
  });

  it('keeps a literal own __proto__ native question ID through answer normalization', () => {
    const completed = ask('{"answers":[{"id":"__proto__","selected":["Blue"]}]}');
    expect(completed).toMatchObject({ isError: false });
    const details = (completed as { resultDetails?: { resolvedAnswers?: object } } | undefined)?.resultDetails?.resolvedAnswers;
    expect(Object.hasOwn(details as object, '__proto__')).toBe(true);
    expect(JSON.stringify(details)).toBe('{"__proto__":"Blue"}');
  });

  it('preserves custom supplements and multi selections under a __proto__ question ID', () => {
    const completed = ask('{"answers":[{"id":"__proto__","selected":["Blue","Red"],"custom":"Green"}]}');
    const details = (completed as { resultDetails?: { resolvedAnswers?: object } } | undefined)?.resultDetails?.resolvedAnswers;
    expect(JSON.stringify(details)).toBe('{"__proto__":["Blue","Red","Green"]}');
  });

  it('leaves a skipped __proto__ question unanswered', () => {
    expect(ask('{"answers":[{"id":"__proto__","selected":[]}]}')).not.toHaveProperty('resultDetails.resolvedAnswers');
  });

  it.each([
    { name: 'a fully skipped batch', text: '{"answers":[{"id":"round9","selected":[]},{"id":"tag","selected":[]}]}' },
    { name: 'a timed call still pending', text: '{"pending":true,"callId":"ask","message":"No answer batch arrived before the timeout."}' },
    { name: 'a cancelled call', text: 'User question was cancelled', isError: true },
    { name: 'a failed call echoing answer-shaped text', text: '{"answers":[{"id":"round9","selected":["Skip it"]}]}', isError: true },
  ])('leaves $name unanswered', ({ text, isError }) => {
    expect(ask(text, isError)).not.toHaveProperty('resultDetails.resolvedAnswers');
  });
});


it('projects Linux tool inputs, applied diffs and code-mode calls before host file consumers see them', () => {
  const mapper = createExecutionPathMapper({ method: 'wsl', distroName: 'Ubuntu', platformFamily: 'unix', platformOs: 'linux' });
  const output = new DeepSeekOutput(event => events.push(event), path => mapper.toHostPath(path) ?? path);
  output.record({ type: 'tool/call', seq: 1, data: { callId: 'edit', name: 'edit', arguments: { path: '/home/me/Vault/note.md' } } });
  output.record({ type: 'tool/result', seq: 2, data: { message: { toolCallId: 'edit', content: [] }, meta: { diffs: [{ path: '/home/me/Vault/note.md', oldText: 'a', newText: 'b' }] } } });
  output.record({ type: 'tool/ptc-dispatch-start', seq: 3, data: { rootCallId: 'code', subCallId: 'read', name: 'read', arguments: { path: '/mnt/c/Vault/note.md' } } });
  expect(events.find(e => e.type === 'tool_started')).toMatchObject({ input: { file_path: '\\\\wsl$\\Ubuntu\\home\\me\\Vault\\note.md' } });
  expect(events.find(e => e.type === 'tool_completed')).toMatchObject({ resultDetails: { diff: { filePath: '\\\\wsl$\\Ubuntu\\home\\me\\Vault\\note.md' } } });
  expect(events.find(e => e.type === 'tool_output')).toMatchObject({ resultDetails: { scriptToolCalls: [{ input: { file_path: 'C:\\Vault\\note.md' } }] } });
});
