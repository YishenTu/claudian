/** @jest-environment jsdom */

import { testTime } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import { getToolIcon } from '@/core/tools/toolIcons';
import type { StreamChunk, ToolCallInfo } from '@/core/types';
import { renderStoredToolCall, renderToolCall, updateToolCallResult } from '@/features/chat/rendering/ToolCallRenderer';
import { parseCodexSessionContent } from '@/providers/codex/history/CodexHistoryStore';
import { formatCodexQuestionReply } from '@/providers/codex/normalization/codexQuestionNormalization';
import { CodexNotificationRouter } from '@/providers/codex/runtime/CodexNotificationRouter';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };

beforeEach(() => document.body.replaceChildren());

function restoreTool(mode: 'live' | 'history', name: string, input: unknown, output = '', wrapped = false): ToolCallInfo {
  const call = wrapped
    ? { type: 'custom_tool_call', call_id: 'tool', name: 'exec', input: `text(await tools.${name}(${JSON.stringify(input)}));` }
    : { type: 'function_call', call_id: 'tool', name, arguments: JSON.stringify(input) };
  const result = { type: wrapped ? 'custom_tool_call_output' : 'function_call_output', call_id: 'tool', output };
  if (mode === 'history') {
    const tools = parseCodexSessionContent([call, result].map((payload, index) => JSON.stringify({
      type: 'response_item', timestamp: testTime({ seconds: index }), payload,
    })).join('\n')).flatMap(message => message.toolCalls ?? []);
    expect(tools).toHaveLength(1);
    return tools[0];
  }
  const chunks: StreamChunk[] = [];
  const router = new CodexNotificationRouter(chunk => chunks.push(chunk), '/workspace');
  router.beginTurn();
  for (const item of [call, result]) router.handleNotification('rawResponseItem/completed', { item });
  router.handleNotification('turn/completed', { turn: { id: 'turn', items: [], status: 'completed', error: null } });
  const uses = chunks.filter(chunk => chunk.type === 'tool_use');
  const results = chunks.filter(chunk => chunk.type === 'tool_result');
  expect(uses).toHaveLength(1);
  expect(results).toHaveLength(1);
  return { ...uses[0], status: results[0].isError ? 'error' : 'completed', result: results[0].content };
}

describe.each(['live', 'history'] as const)('%s Codex tool presentation', mode => {
  it.each([
    ['send_message', 'Message agent', { target: '/root/reviewer', message: 'Check the race condition.' }, ''],
    ['followup_task', 'Continue agent', { target: '/root/reviewer', message: 'Review the repair.' }, ''],
    ['list_agents', 'List agents', { path_prefix: '/root' }, '{"agents":[{"agent_name":"/root/reviewer","agent_status":"running"}]}'],
    ['interrupt_agent', 'Interrupt agent', { target: '/root/reviewer' }, '{"previous_status":"running"}'],
  ] as const)('renders %s using the agent family, including empty results', async (name, label, input, result) => {
    const tool = restoreTool(mode, name, input, result);
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    const header = within(block).getByRole('button', { name: new RegExp(label) });
    expect(getToolIcon(tool.name)).toBe('bot');
    expect(header.textContent).toContain('target' in input ? input.target : input.path_prefix);
    fireEvent.keyDown(header, { key: 'Enter' });
    expect(block.textContent).toContain('message' in input ? input.message : 'running');
    expect((await axe(block)).violations).toEqual([]);
  });

  it.each([false, true])('preserves every web operation (exec wrapper: %s)', wrapped => {
    const tool = restoreTool(mode, 'web__run', {
      search_query: [{ q: 'first query' }, { q: 'second query' }],
      open: [{ ref_id: 'https://example.com/one' }, { ref_id: 'turn1view0' }],
      find: [{ ref_id: 'https://example.com/two', pattern: 'target phrase' }],
      click: [{ ref_id: 'turn2view0', id: 7 }],
    }, 'Search complete', wrapped);
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    fireEvent.click(within(block).getByRole('button', { name: /WebSearch: 5 web operations/ }));
    expect(getToolIcon(tool.name)).toBe('globe');
    for (const text of ['Query: first query', 'Alt query: second query', 'turn1view0', 'Pattern: target phrase', 'Click link 7']) {
      expect(within(block).getByText(text)).toBeDefined();
    }
    expect(within(block).getByRole('link', { name: 'https://example.com/one' }).getAttribute('href')).toBe('https://example.com/one');
    expect(within(block).queryByRole('link', { name: 'turn1view0' })).toBeNull();
  });

  it('keeps less common operations visible in a mixed web call', () => {
    const tool = restoreTool(mode, 'web__run', {
      search_query: [{ q: 'Example company' }], finance: [{ ticker: 'TEST', type: 'equity', market: 'USA' }],
      weather: [{ location: 'London' }], screenshot: [{ ref_id: 'turn1view0', pageno: 2 }], response_length: 'short',
    }, 'Result', true);
    const block = renderStoredToolCall(document.body.createDiv(), tool, { initiallyExpanded: true });
    expect(block.textContent).toContain('4 web operations');
    expect(block.textContent).toContain('Finance');
    expect(block.textContent).toContain('TEST');
    expect(block.textContent).toContain('Weather');
    expect(block.textContent).toContain('London');
    expect(block.textContent).toContain('Screenshot');
    expect(block.textContent).toContain('turn1view0');
  });

  it('renders async question acknowledgement with the original question and options', async () => {
    const tool = restoreTool(mode, 'request_user_input_async', {
      questions: [{ title: 'Which check should run?', options: ['Rendering', 'History'] }],
    }, '{"accepted":true}');
    const block = renderStoredToolCall(document.body.createDiv(), tool, { initiallyExpanded: true });
    expect(getToolIcon(tool.name)).toBe('help-circle');
    expect(within(block).getByText('Which check should run?')).toBeDefined();
    expect(within(block).getByText('Rendering')).toBeDefined();
    expect(within(block).getByText('History')).toBeDefined();
    expect(block.textContent).not.toContain('Not answered');
    expect(block.textContent).not.toContain('"accepted"');
    expect((await axe(block)).violations).toEqual([]);
  });
});

it('shows async question options while live and the actual answer when resolved', () => {
  const tool = restoreTool('live', 'request_user_input_async', {
    questions: [{ title: 'Which check?', options: ['Rendering', 'History'] }],
  }, '{"accepted":true}');
  const elements = new Map<string, HTMLElement>();
  const block = renderToolCall(document.body.createDiv(), { ...tool, status: 'running', result: undefined }, elements, { initiallyExpanded: true });
  expect(within(block).getByText('Rendering')).toBeDefined();
  updateToolCallResult(tool.id, { ...tool, result: '{"answers":{"Which check?":"History"}}' }, elements);
  expect(within(block).getByText('History')).toBeDefined();
  expect(within(block).queryByText('Rendering')).toBeNull();
});


it('submits a selected option and a free-text answer once, then restores both answers from native history', async () => {
  const input = { questions: [{ title: 'Which check?', options: ['Rendering', 'History'] }, { title: 'Any details?' }] };
  const tool = restoreTool('history', 'request_user_input_async', input, '{"accepted":true}');
  let reply = '';
  let finish!: () => void;
  const onAnswer = jest.fn(async answers => {
    reply = formatCodexQuestionReply(tool, answers)!.content;
    await new Promise<void>(resolve => { finish = resolve; });
  });
  const elements = new Map<string, HTMLElement>();
  const block = renderToolCall(document.body.createDiv(), tool, elements, { onAnswer });
  expect(within(block).getByRole('button', { name: /AskUserQuestion/ }).getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(within(block).getByRole('radio', { name: 'History' }));
  fireEvent.input(within(block).getByRole('textbox', { name: 'Your answer to Any details?' }), { target: { value: 'Preserve my notes.' } });
  // Acknowledgement must not erase a selection made before it arrives.
  updateToolCallResult(tool.id, tool, elements);
  expect((within(block).getByRole('radio', { name: 'History' }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(within(block).getByRole('button', { name: 'Send answer' }));
  fireEvent.submit(block.querySelector('form')!);
  expect(onAnswer).toHaveBeenCalledTimes(1);
  expect((within(block).getByRole('button', { name: 'Sending...' }) as HTMLButtonElement).disabled).toBe(true);
  finish();
  await waitFor(() => expect(within(block).getByText('Preserve my notes.')).toBeDefined());
  expect(within(block).queryByRole('button', { name: 'Send answer' })).toBeNull();
  const payloads = [
    { type: 'function_call', name: 'request_user_input_async', call_id: 'tool', arguments: JSON.stringify(input) },
    { type: 'function_call_output', call_id: 'tool', output: '{"accepted":true}' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: reply }] },
  ];
  const messages = parseCodexSessionContent(payloads.map((payload, index) => JSON.stringify({
    type: 'response_item', timestamp: testTime({ seconds: index }), payload,
  })).join('\n'));
  const restored = messages.flatMap(message => message.toolCalls ?? [])[0];
  expect(restored.resolvedAnswers).toEqual({ '0': 'History', '1': 'Preserve my notes.' });
  expect(messages.find(message => message.role === 'user')?.content).toBe('Which check?\nHistory\n\nAny details?\nPreserve my notes.');
  const restoredBlock = renderStoredToolCall(document.body.createDiv(), restored, { onAnswer, initiallyExpanded: true });
  expect(within(restoredBlock).queryByRole('button', { name: 'Send answer' })).toBeNull();
  expect((await axe(restoredBlock)).violations).toEqual([]);
});

it('keeps answer controls usable after rejected submission and disables controls on a failed tool', async () => {
  const tool = restoreTool('history', 'request_user_input_async', { questions: [{ title: 'Which check?', options: ['History'] }] }, '{"accepted":true}');
  const onAnswer = jest.fn().mockRejectedValue(new Error('Conversation changed.'));
  const elements = new Map<string, HTMLElement>();
  const block = renderToolCall(document.body.createDiv(), tool, elements, { onAnswer, initiallyExpanded: true });
  fireEvent.click(within(block).getByRole('radio', { name: 'History' }));
  fireEvent.click(within(block).getByRole('button', { name: 'Send answer' }));
  await waitFor(() => expect(within(block).getByRole('alert').textContent).toBe('Conversation changed.'));
  expect((within(block).getByRole('button', { name: 'Send answer' }) as HTMLButtonElement).disabled).toBe(false);
  expect(tool.resolvedAnswers).toBeUndefined();
  expect((await axe(block)).violations).toEqual([]);
  updateToolCallResult(tool.id, { ...tool, status: 'error', result: 'Request failed' }, elements);
  expect(within(block).queryByRole('button', { name: 'Send answer' })).toBeNull();
});


it('restores native async question items without a raw function call and deduplicates paired records', () => {
  const question = { title: 'Which check?', options: ['History'] };
  const native = { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'ask-native', delivery: 'async', questions: [question], content: [{ type: 'Text', text: question.title }] } } };
  for (const raw of [[], [{ type: 'response_item', payload: { type: 'function_call', call_id: 'ask-native', name: 'request_user_input_async', arguments: JSON.stringify({ questions: [question] }) } }]]) {
    const messages = parseCodexSessionContent([...raw, native].map(record => JSON.stringify({ timestamp: testTime(), ...record })).join('\n'));
    const tools = messages.flatMap(message => message.toolCalls ?? []);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ id: 'ask-native', name: 'AskUserQuestion', status: 'completed', input: { replyMode: 'user-message', questions: [{ question: 'Which check?' }] } });
  }
});
