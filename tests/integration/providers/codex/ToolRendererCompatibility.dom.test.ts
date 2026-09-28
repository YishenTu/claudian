/** @jest-environment jsdom */
import '@/providers';

import { testTime } from '@test/helpers/testClock';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import { getToolIcon } from '@/core/tools/toolIcons';
import type { StreamChunk, ToolCallInfo } from '@/core/types';
import { AsyncQuestionPrompts } from '@/features/chat/rendering/AsyncQuestionPrompts';
import type { QuestionAnswerHandler } from '@/features/chat/rendering/InlineAskUserQuestion';
import { InlineInteractionPrompts } from '@/features/chat/rendering/InlineInteractionPrompts';
import { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import { renderStoredToolCall, renderToolCall, updateToolCallResult } from '@/features/chat/rendering/ToolCallRenderer';
import { parseCodexSessionContent } from '@/providers/codex/history/CodexHistoryStore';
import { formatCodexQuestionReply } from '@/providers/codex/normalization/codexQuestionNormalization';
import { CodexNotificationRouter } from '@/providers/codex/runtime/CodexNotificationRouter';

HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.toggleClass = function (names, enabled) {
  for (const name of Array.isArray(names) ? names : [names]) this.classList.toggle(name, enabled);
};
HTMLElement.prototype.scrollIntoView = function () {};
HTMLElement.prototype.setText = function (text) { this.textContent = String(text); };

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
  it.each(['js', 'mcp__cua_repl__js'])('renders %s with its title, JavaScript source, and output', async name => {
    const source = "const app = await cua.getApp('Obsidian');\nnodeRepl.write(await app.getState());";
    const output = 'Wall time: 0.5 seconds\nOutput:\nWindow: Obsidian\n  button Send';
    const tool = restoreTool(mode, name, { code: source, title: 'Inspect Obsidian', timeout_ms: 30000 }, output);
    const block = renderStoredToolCall(document.body.createDiv(), tool);
    expect(getToolIcon(tool.name)).toBe('code');
    const header = within(block).getByRole('button', { name: /^Script: Inspect Obsidian/ });
    expect(header.textContent).toContain('Script');
    fireEvent.keyDown(header, { key: 'Enter' });
    expect(block.querySelector('code')?.textContent).toBe(source);
    expect(block.querySelector('.claudian-tool-script-output')?.textContent).toBe(output);
    expect((await axe(block)).violations).toEqual([]);
  });

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


function showQuestion(tool: ToolCallInfo, onAnswer: QuestionAnswerHandler) {
  const composer = document.body.createDiv();
  const input = composer.createEl('textarea');
  input.value = 'Keep my draft';
  const panelHost = document.body.createDiv();
  const elements = new Map<string, HTMLElement>();
  const block = renderToolCall(document.body.createDiv(), tool, elements, { initiallyExpanded: true });
  const prompts = new AsyncQuestionPrompts({
    prompts: new InlineInteractionPrompts({ getPromptParentEl: () => panelHost, getSuppressedEl: () => composer }),
    answer: (_tool, answers) => onAnswer(answers),
    onChange: current => updateToolCallResult(current.id, current, elements),
    onPendingChange: () => undefined,
  });
  prompts.update(tool);
  return { composer, input, panelHost, elements, block, prompts };
}

it('submits a selected option and a free-text answer once, then restores both answers from native history', async () => {
  const input = { questions: [{ title: 'Which check?', options: ['Rendering', 'History'] }, { title: 'Any details?' }] };
  const tool = restoreTool('history', 'request_user_input_async', input, '{"accepted":true}');
  let reply = '';
  let finish!: () => void;
  const onAnswer = jest.fn(async answers => {
    reply = formatCodexQuestionReply(tool, answers)!.content;
    await new Promise<void>(resolve => { finish = resolve; });
  });
  const { block, panelHost, elements, composer, input: draft, prompts } = showQuestion(tool, onAnswer);
  expect(composer.classList.contains('claudian-hidden')).toBe(true);
  expect(within(block).queryByRole('region', { name: 'Question' })).toBeNull();
  fireEvent.click(within(panelHost).getByRole('button', { name: 'History' }));
  fireEvent.input(within(panelHost).getByRole('textbox', { name: 'Any details?' }), { target: { value: 'Preserve my notes.' } });
  // Acknowledgement must not erase a selection made before it arrives.
  updateToolCallResult(tool.id, tool, elements);
  prompts.update(tool);
  const panel = within(panelHost).getByRole('region', { name: 'Question' });
  fireEvent.click(within(panel).getByRole('button', { name: 'Submit' }));
  expect(within(panel).getByText('History')).toBeDefined();
  expect(within(panel).getByText('Preserve my notes.')).toBeDefined();
  expect((await axe(panel)).violations).toEqual([]);
  fireEvent.click(within(panelHost).getByRole('button', { name: 'Submit answers' }));
  fireEvent.keyDown(panel, { key: 'Enter' });
  fireEvent.click(within(panel).getByRole('button', { name: 'Sending...' }));
  expect(onAnswer).toHaveBeenCalledTimes(1);
  expect((within(panelHost).getByRole('button', { name: 'Sending...' }) as HTMLButtonElement).disabled).toBe(true);
  finish();
  await waitFor(() => expect(within(panelHost).queryByRole('button', { name: 'Sending...' })).toBeNull());
  expect(composer.classList.contains('claudian-hidden')).toBe(false);
  expect(draft.value).toBe('Keep my draft');
  await waitFor(() => expect(within(block).getByText('Preserve my notes.')).toBeDefined());
  expect(within(block).queryByRole('button', { name: 'Submit answers' })).toBeNull();
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
  expect(messages.find(message => message.role === 'user')?.displayContent).toBe('');
  const transcript = document.body.createDiv();
  const renderer = new MessageRenderer(
    { app: {}, settings: {} } as any,
    { registerDomEvent: jest.fn(), register: jest.fn(), addChild: jest.fn() } as any,
    transcript, undefined, undefined,
    () => ({ providerId: 'codex', supportsConversationBranches: true }) as any,
    { navigate: async () => undefined, isBusy: () => false },
  );
  renderer.addMessage(messages.find(message => message.role === 'user')!);
  expect(transcript.querySelector('.claudian-message-user')).toBeNull();
  renderer.renderMessages(messages, () => 'Welcome');
  expect(transcript.querySelector('.claudian-message-user')).toBeNull();
  expect(within(transcript).getByText('Preserve my notes.')).toBeDefined();
  renderer.addMessage({ id: 'ordinary', role: 'user', content: 'Keep this message', timestamp: Date.now() });
  expect(transcript.querySelectorAll('.claudian-message-user')).toHaveLength(1);
  renderer.dispose();
  const restoredBlock = renderStoredToolCall(document.body.createDiv(), restored, { initiallyExpanded: true });
  expect(within(restoredBlock).queryByRole('button', { name: 'Submit answers' })).toBeNull();
  expect((await axe(restoredBlock)).violations).toEqual([]);
});

it('keeps answer controls usable after rejected submission and disables controls on a failed tool', async () => {
  const tool = restoreTool('history', 'request_user_input_async', { questions: [{ title: 'Which check?', options: ['History'] }] }, '{"accepted":true}');
  const onAnswer = jest.fn().mockRejectedValue(new Error('Conversation changed.'));
  const { block, panelHost, composer, prompts } = showQuestion(tool, onAnswer);
  fireEvent.click(within(panelHost).getByRole('button', { name: 'History' }));
  fireEvent.click(within(panelHost).getByRole('button', { name: 'Submit answers' }));
  await waitFor(() => expect(within(panelHost).getByRole('alert').textContent).toBe('Conversation changed.'));
  expect((within(panelHost).getByRole('button', { name: 'Submit answers' }) as HTMLButtonElement).disabled).toBe(false);
  expect(tool.resolvedAnswers).toBeUndefined();
  expect((await axe(block)).violations).toEqual([]);
  tool.status = 'error';
  prompts.update(tool);
  await waitFor(() => expect(within(panelHost).queryByRole('button', { name: 'Submit answers' })).toBeNull());
  expect(composer.classList.contains('claudian-hidden')).toBe(false);
  expect(within(block).getByText('Question expired.')).toBeDefined();
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


it('shows js source before output arrives and preserves it after a live failure', () => {
  const tool: ToolCallInfo = { id: 'js-live', name: 'js', status: 'running', input: { code: 'await app.getState();' } };
  const elements = new Map<string, HTMLElement>();
  const block = renderToolCall(document.body.createDiv(), tool, elements, { initiallyExpanded: true });
  expect(within(block).getByRole('button', { name: /^Script: await app\.getState\(\);/ })).toBeDefined();
  expect(block.querySelector('code')?.textContent).toBe('await app.getState();');
  expect(block.textContent).toContain('Running...');
  updateToolCallResult(tool.id, { ...tool, status: 'error', result: 'ReferenceError: app is not defined' }, elements);
  expect(block.querySelector('code')?.textContent).toBe('await app.getState();');
  expect(block.querySelector('.claudian-tool-script-output')?.textContent).toBe('ReferenceError: app is not defined');
});


it('expires dismissed questions and keeps history replay read-only', async () => {
  const tool = restoreTool('history', 'request_user_input_async', { questions: [{ title: 'Which check?', options: ['History'] }] }, '{"accepted":true}');
  const onAnswer = jest.fn();
  const { panelHost, composer, block, prompts } = showQuestion(tool, onAnswer);
  const panel = within(panelHost).getByRole('region', { name: 'Question' });
  expect((await axe(panel)).violations).toEqual([]);
  fireEvent.keyDown(panel, { key: 'Escape' });
  await waitFor(() => expect(tool.questionStatus).toBe('expired'));
  expect(composer.classList.contains('claudian-hidden')).toBe(false);
  expect(onAnswer).not.toHaveBeenCalled();
  expect(tool.resolvedAnswers).toBeUndefined();
  expect(within(block).getByText('Question expired.')).toBeDefined();
  prompts.update(tool);
  const restored = renderStoredToolCall(document.body.createDiv(), tool, { initiallyExpanded: true });
  expect(within(restored).queryByRole('region', { name: 'Question' })).toBeNull();
  expect(within(restored).getByText('Question expired.')).toBeDefined();
  expect(within(panelHost).queryByRole('region', { name: 'Question' })).toBeNull();
});


it.each(['', 'Also check the web renderer.'])('retains native user boundaries while hiding question replies (ordinary text: %s)', ordinary => {
  const tool = restoreTool('history', 'request_user_input_async', { questions: [{ title: 'Which check?', options: ['History'] }] });
  const reply = formatCodexQuestionReply(tool, { '0': 'History' })!;
  const text = [reply.content, ordinary].filter(Boolean).join('\n\n');
  const chunks: StreamChunk[] = [];
  const router = new CodexNotificationRouter(chunk => chunks.push(chunk), '/workspace');
  router.beginTurn();
  const item = { type: 'userMessage', id: 'answer', content: [{ type: 'text', text }] };
  router.handleNotification('item/started', { item });
  router.handleNotification('item/completed', { item });
  expect(chunks.filter(chunk => chunk.type === 'user_message_start')).toEqual([
    { type: 'user_message_start', itemId: 'answer', content: ordinary },
  ]);
  const history = parseCodexSessionContent(JSON.stringify({ type: 'response_item', timestamp: testTime(), payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text }],
  } }));
  expect(history.find(message => message.role === 'user')?.displayContent).toBe(ordinary);
});
