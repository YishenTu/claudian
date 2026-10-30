/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"customExportConditions":["node","node-addons"]}
 */

import { EventEmitter, once } from 'node:events';

import { axe } from '@test/helpers/accessibility';
import { nativeDefaults } from '@test/helpers/deepseek/NativeDefaults';
import { NativePeer, rootFollow } from '@test/helpers/deepseek/NativePeer';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor,within } from '@testing-library/dom';

import type { ProviderExecutionEvent, ProviderExecutionRequest, ProviderExecutionSession, ProviderInteractionPort } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { InlineAskUserQuestion } from '@/features/chat/interactions/InlineAskUserQuestion';
import { createInteractionPromptPort } from '@/features/chat/interactions/interactionPromptPort';
import { SessionInteractions } from '@/features/chat/interactions/SessionInteractions';
import { renderStoredToolCall } from '@/features/chat/rendering/tools/ToolCallRenderer';
import { setLocale } from '@/i18n/i18n';
import { DeepSeekExecutionBackend } from '@/providers/deepseek/execution/DeepSeekExecutionBackend';
import { DeepSeekConversationHistoryService } from '@/providers/deepseek/history/DeepSeekConversationHistoryService';
import { getDeepSeekHome } from '@/providers/deepseek/runtime/DeepSeekHome';
import type { DeepSeekHost } from '@/providers/deepseek/runtime/DeepSeekHost';

let peer: NativePeer;
let deepseek: DeepSeekHost;
let session: ProviderExecutionSession;
let seq: number;
let nativeTurn: number;
let port: ProviderInteractionPort;
const time = testDate().getTime();
let settings: import('@/core/types').ClaudianSettings;
let host: ProviderHost;

function request(text = 'requested'): ProviderExecutionRequest {
  return { input: [{ type: 'text', text }], configuration: { systemInstructions: { kind: 'explicit', instructions: 'literal {prompt}' }, permissionMode: 'normal' }, toolPolicy: { kind: 'provider-default' }, signal: new AbortController().signal };
}
function event(type: string, data: unknown): void {
  peer.send('session/follow', { type: 'event', event: { type, seq: ++seq, time, data } }, rootFollow('root'));
}
function begin(rpcId: string): void {
  nativeTurn++;
  event('turn/start', { turn: nativeTurn });
  event('user/message', { id: `user-${nativeTurn}`, content: [{ type: 'text', text: 'requested' }], source: { kind: 'user', rpcId } });
}
function answer(text: string): void {
  event('assistant/message', { turn: nativeTurn, step: 0, message: { content: [{ type: 'text', text }] } });
  event('turn/end', { turn: nativeTurn, reason: { kind: 'completed' } });
}
const publications = new EventEmitter();
async function collect(events: AsyncIterable<ProviderExecutionEvent>, into: ProviderExecutionEvent[]): Promise<void> {
  for await (const event of events) { into.push(event); publications.emit('event'); }
}

beforeEach(async () => {
  ({ host, settings } = await createProviderHostFixture({ settings: { locale: 'en', providerConfigs: { deepseek: { enabled: true, visibleModels: ['deepseek:native/model'], discoveredModels: [{ encodedId: 'deepseek:native/model', provider: 'native', id: 'model', label: 'Model', reasoning: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] }] } } } }));
  seq = 3; nativeTurn = 0; settings.locale = 'en';
  port = { requestApproval: vi.fn(), askUserQuestion: vi.fn(), dismissInteraction: vi.fn() };
  peer = new NativePeer();
  const native = nativeDefaults({ seq: () => seq, roster: () => ['root'] });
  peer.onCall = (method, args) => method === 'session/create' ? { sessionId: 'root', agentPreset: 'claudian' } : native.call(method, args);
  peer.onOpen = native.open;
  await peer.open();
  ({ deepseek } = peer.host());
});
afterEach(async () => { setLocale('en'); await session?.dispose(); await deepseek.dispose(); await peer.close(); });

function create(): void {
  session = new DeepSeekExecutionBackend(host.getRuntimeHost('deepseek'), () => deepseek).createSession({
    lifecycle: 'persistent', nativePersistence: 'enabled', workingDirectory: '/vault', interactionPort: port,
  });
}

/** Resolves once the session published an event, which it does only after applying the native frame behind it. */
async function published(events: ProviderExecutionEvent[], expected: Record<string, unknown>): Promise<void> {
  const matcher = expect.objectContaining(expected);
  const signal = AbortSignal.timeout(1_000);
  while (!events.some(event => matcher.asymmetricMatch(event))) await once(publications, 'event', { signal });
  expect(events).toContainEqual(matcher);
}
const claimed = (events: ProviderExecutionEvent[]) => published(events, { type: 'turn_started', nativeTurnId: String(nativeTurn) });

it.each([
  {
    name: 'a free-text answer', question: { id: 'native-name', question: 'Project name?' },
    respond: async () => fireEvent.input(await within(document.body).findByRole('textbox', { name: 'Project name?' }), { target: { value: 'Atlas' } }),
    sent: { id: 'native-name', selected: [], custom: 'Atlas' },
  },
  {
    name: 'a selected option', question: { id: 'native-color', question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }] },
    respond: async () => fireEvent.click(await within(document.body).findByRole('button', { name: 'Blue' })),
    sent: { id: 'native-color', selected: ['Blue'] },
  },
  {
    name: 'a literal own __proto__ ID answer', question: { id: '__proto__', question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] },
    respond: async () => fireEvent.click(await within(document.body).findByRole('button', { name: 'Blue' })),
    sent: { id: '__proto__', selected: ['Blue'] },
  },
])('renders a native question and sends $name under the native ID', async ({ question, respond, sent }) => {
  document.body.replaceChildren();
  port.askUserQuestion = input => new Promise(resolve => {
    const panel = new InlineAskUserQuestion(document.body.createDiv(), input.input,
      answers => resolve({ interactionId: input.interactionId, answers }));
    panel.render();
  });
  create();
  const run = session.execute(request());
  const events: ProviderExecutionEvent[] = [];
  const done = collect(run.events, events);
  await peer.waitForCall('session/prompt');
  begin(run.executionId);
  await claimed(events);
  peer.send('$events', { type: 'waterfall', eventId: 'question', event: 'user-questions/request', agentId: 'root', request: { questions: [question] } });
  await within(document.body).findByRole('region', { name: 'Question' });
  expect((await axe(document.body)).violations).toEqual([]);
  await respond();
  fireEvent.click(within(document.body).getByRole('button', { name: 'Submit' }));
  fireEvent.click(within(document.body).getByRole('button', { name: 'Submit answers' }));
  expect((await peer.waitForCall('$events/result')).args).toEqual({ clientId: expect.any(String), eventId: 'question', outcome: { kind: 'result', value: { answers: [sent] } } });
  answer('saved');
  await done;
});

it.each([
  {
    name: 'a prototype-named ID with no own answer falls back to the own question text',
    question: { id: 'toString', question: 'Color?', options: [{ label: 'Red' }, { label: 'Blue' }] },
    answers: () => JSON.parse('{"Color?":"Blue"}'),
    sent: { id: 'toString', selected: ['Blue'] },
  },
  {
    name: 'an own ID answer outranks the own question text',
    question: { id: 'color', question: 'Color?', options: [{ label: 'Red' }, { label: 'Blue' }] },
    answers: () => JSON.parse('{"color":"Red","Color?":"Blue"}'),
    sent: { id: 'color', selected: ['Red'] },
  },
  {
    name: 'an inherited-only answer fabricates no selection or custom text',
    question: { id: 'constructor', question: 'Color?', options: [{ label: 'Red' }, { label: 'Blue' }] },
    answers: () => Object.create({ 'Color?': 'Blue' }) as Record<string, string | string[]>,
    sent: { id: 'constructor', selected: [] },
  },
  {
    name: 'an own empty-string question-text answer under a non-empty ID',
    question: { id: 'color', question: '', options: [{ label: 'Red' }, { label: 'Blue' }] },
    answers: () => JSON.parse('{"":"Blue"}') as Record<string, string | string[]>,
    sent: { id: 'color', selected: ['Blue'] },
  },
  {
    name: 'a non-string question text that never reads the empty-string answer key',
    question: { id: 'color', options: [{ label: 'Red' }, { label: 'Blue' }] },
    answers: () => JSON.parse('{"":"Blue"}') as Record<string, string | string[]>,
    sent: { id: 'color', selected: [] },
  },
])('sends $name in the native answer request', async ({ question, answers, sent }) => {
  document.body.replaceChildren();
  port.askUserQuestion = input => Promise.resolve({ interactionId: input.interactionId, answers: answers() });
  create();
  const run = session.execute(request());
  const events: ProviderExecutionEvent[] = [];
  const done = collect(run.events, events);
  await peer.waitForCall('session/prompt');
  begin(run.executionId);
  await claimed(events);
  peer.send('$events', { type: 'waterfall', eventId: 'question', event: 'user-questions/request', agentId: 'root', request: { questions: [question] } });
  expect((await peer.waitForCall('$events/result')).args).toEqual({ clientId: expect.any(String), eventId: 'question', outcome: { kind: 'result', value: { answers: [sent] } } });
  answer('saved');
  await done;
});

it('restores an answered native question from history as its answered review, not the raw native result', async () => {
  // Captured from a native transcript: one question, answered with its recommended option.
  const label = 'deepseek provider — deepseek-official/deepseek-flash (Recommended)';
  const nativeResult = JSON.stringify({ answers: [{ id: 'model', selected: [label] }] });
  const questions = [{ id: 'model', header: 'Confirm model', question: 'Which deepseek-flash model should the new session use?', options: [
    { label, description: 'The default provider\'s default model.' },
    { label: 'pi provider — pi:deepseek/deepseek-flash', description: 'Model id contains a slash.' },
  ] }];
  const records = [
    { type: 'turn/start', seq: 1, time, data: { turn: 3 } },
    { type: 'tool/call', seq: 2, time, data: { turn: 3, step: 2, callId: 'ask', name: 'ask_user_question', arguments: JSON.stringify({ questions }) } },
    { type: 'tool/result', seq: 3, time, data: { turn: 3, step: 2, message: { role: 'tool', toolCallId: 'ask', content: [{ type: 'text', text: nativeResult }], isError: false } }, surfaceOp: 'append' },
    { type: 'turn/end', seq: 4, time, data: { turn: 3, reason: { kind: 'completed' } } },
  ].map(event => ({ type: 'event', event }));
  const native = peer.onCall;
  peer.onCall = (method, args) => method === 'session/projections' ? { asOfSeq: 4, values: { agentPreset: 'claudian' } }
    : method === 'session/page' ? { records, hasMore: false } : native(method, args);
  const providerState = { schemaVersion: 1, home: getDeepSeekHome(process.env, process.cwd()), profile: 'web', preset: 'claudian' };
  const { messages } = await new DeepSeekConversationHistoryService(async () => deepseek).hydrateConversationHistory({ sessionId: 'root', providerState, messages: [] }, '/vault');
  const tool = messages!.flatMap(message => message.toolCalls ?? [])[0];
  document.body.replaceChildren();
  const card = renderStoredToolCall(document.body.createDiv(), tool, { initiallyExpanded: true });
  expect(within(card).getByText(questions[0].question)).toBeTruthy();
  expect(within(card).getByText(label)).toBeTruthy();
  expect(within(card).queryByText(nativeResult)).toBeNull();
  // The unanswered option list is replaced by the review.
  expect(within(card).queryByText('pi provider — pi:deepseek/deepseek-flash')).toBeNull();
  expect((await axe(card)).violations).toEqual([]);
});

it('keeps own __proto__ answers through history hydration as a visible answered review', async () => {
  const questions = [{ id: '__proto__', header: 'Colour', question: 'Which colour should the report use?', options: [{ label: 'Red' }, { label: 'Blue' }] }];
  const nativeResult = JSON.stringify({ answers: [{ id: '__proto__', selected: ['Blue'] }] });
  const records = [
    { type: 'turn/start', seq: 1, time, data: { turn: 3 } },
    { type: 'tool/call', seq: 2, time, data: { turn: 3, step: 2, callId: 'ask', name: 'ask_user_question', arguments: JSON.stringify({ questions }) } },
    { type: 'tool/result', seq: 3, time, data: { turn: 3, step: 2, message: { role: 'tool', toolCallId: 'ask', content: [{ type: 'text', text: nativeResult }], isError: false } }, surfaceOp: 'append' },
    { type: 'turn/end', seq: 4, time, data: { turn: 3, reason: { kind: 'completed' } } },
  ].map(event => ({ type: 'event', event }));
  const native = peer.onCall;
  peer.onCall = (method, args) => method === 'session/projections' ? { asOfSeq: 4, values: { agentPreset: 'claudian' } }
    : method === 'session/page' ? { records, hasMore: false } : native(method, args);
  const providerState = { schemaVersion: 1, home: getDeepSeekHome(process.env, process.cwd()), profile: 'web', preset: 'claudian' };
  const { messages } = await new DeepSeekConversationHistoryService(async () => deepseek).hydrateConversationHistory({ sessionId: 'root', providerState, messages: [] }, '/vault');
  const tool = messages!.flatMap(message => message.toolCalls ?? [])[0];
  document.body.replaceChildren();
  const card = renderStoredToolCall(document.body.createDiv(), tool, { initiallyExpanded: true });
  expect(within(card).getByText(questions[0].question)).toBeTruthy();
  expect(within(card).getByText('Blue')).toBeTruthy();
  expect(within(card).queryByText('Red')).toBeNull();
  expect(within(card).queryByText(nativeResult)).toBeNull();
  expect((await axe(card)).violations).toEqual([]);
});

const command = 'rm -rf /tmp/review-generated';
const nativeReason = {
  reason: 'escalate sandbox to danger-full-access: update generated files',
  displayReason: { en: 'Allow this operation with danger-full-access permissions: update generated files', zh: '允许本次操作使用 danger-full-access 权限：update generated files' },
};

function renderApprovals(): void {
  document.body.replaceChildren();
  const prompts = new SessionInteractions({ getPromptParentEl: () => document.body });
  port = createInteractionPromptPort(() => prompts);
}

function approve(agentId: string, callId?: string): void {
  peer.send('$events', { type: 'waterfall', eventId: 'approval', event: 'approval/request', agentId, request: { toolName: 'bash', ...(callId ? { callId } : {}), ...nativeReason } });
}

async function startChild(): Promise<(value: unknown) => void> {
  let childFollow: ((value: unknown) => void) | undefined;
  const ordinaryOpen = peer.onOpen;
  peer.onOpen = (endpoint, args, send) => {
    if (endpoint === 'session/follow' && args.request.address.childSessionId === 'child') { childFollow = send; return; }
    ordinaryOpen(endpoint, args, send);
  };
  peer.send('session/control', { type: 'projection', sessionId: 'root', key: 'subagentCatalog', value: [{ id: 'child', mode: 'continuable', label: 'child task' }] });
  peer.send('session/control', { type: 'projection', sessionId: 'child', key: 'subagent', value: { mode: 'continuable', label: 'child task', seq: 0 } });
  peer.send('$events', { type: 'emit', event: 'api-session/added', args: [{ sessionId: 'child', parentSessionId: 'root', origin: 'subagent', agentAvailable: true, running: true }] });
  await waitFor(() => expect([...peer.streams.values()].map(stream => stream.args.request?.address?.childSessionId)).toContain('child'));
  childFollow!({ type: 'snapshot', cursor: 0, records: [{ type: 'event', event: { type: 'turn/start', seq: 0, time, data: { turn: 0 } } }] });
  return childFollow!;
}

const allow = { decide: () => fireEvent.click(within(document.body).getByRole('button', { name: 'Allow once' })), sent: 'allowed-once' };
it.each([
  { name: 'a direct call', locale: 'en', reason: nativeReason.displayReason.en, callId: 'bash-1', order: 'tool first', ...allow },
  { name: 'a direct call whose tool frame arrives later', locale: 'zh-CN', reason: nativeReason.displayReason.zh, callId: 'bash-1', order: 'approval first', ...allow },
  { name: 'a code-mode call', locale: 'fr', reason: nativeReason.displayReason.en, callId: 'code-1:ptc:1', order: 'tool first', ...allow },
  // Native `zh` is Simplified Chinese; Traditional Chinese falls back to English instead.
  { name: 'a Traditional Chinese locale', locale: 'zh-TW', reason: nativeReason.displayReason.en, callId: 'bash-1', order: 'tool first', ...allow },
  { name: 'a denied call', locale: 'en', reason: nativeReason.displayReason.en, callId: 'bash-1', order: 'tool first',
    decide: () => fireEvent.click(within(document.body).getByRole('button', { name: 'Deny' })), sent: 'rejected' },
  { name: 'a dismissed call', locale: 'en', reason: nativeReason.displayReason.en, callId: 'bash-1', order: 'tool first',
    decide: () => fireEvent.keyDown(within(document.body).getByRole('button', { name: 'Allow once' }), { key: 'Escape' }), sent: 'cancelled' },
])('renders the action and localized native reason for $name and sends the native decision', async ({ locale, reason, callId, order, decide, sent }) => {
  settings.locale = locale;
  const chinese = locale === 'zh-CN' || locale === 'zh-TW';
  if (chinese) setLocale(locale);
  const detailsName = locale === 'zh-CN' ? 'Bash 授权详情' : locale === 'zh-TW' ? 'Bash 授權詳情' : 'Bash approval details';
  const description = locale === 'zh-CN' ? '运行命令：' : locale === 'zh-TW' ? '執行命令：' : 'Run command: ';
  const allowName = locale === 'zh-CN' ? '允许一次' : '允許一次';
  renderApprovals(); create();
  const run = session.execute(request());
  const events: ProviderExecutionEvent[] = [];
  const done = collect(run.events, events);
  try {
    await peer.waitForCall('session/prompt');
    begin(run.executionId);
    await claimed(events);
    const ptc = callId.includes(':ptc:');
    const toolFrame = (): void => {
      if (ptc) {
        event('tool/call', { callId: 'code-1', name: 'run_code', arguments: JSON.stringify({ code: 'await bash({ command })' }) });
        event('tool/ptc-dispatch-start', { rootCallId: 'code-1', subCallId: callId, name: 'bash', arguments: { command } });
      } else event('tool/call', { callId, name: 'bash', arguments: JSON.stringify({ command }) });
    };
    if (order === 'tool first') {
      toolFrame();
      // The session publishes the call (or its code-mode dispatch) once it applied the frame.
      await published(events, { type: ptc ? 'tool_output' : 'tool_started' });
    }
    approve('root', callId);
    // Native interactions are handled on receipt, ahead of follow frames sent after them.
    if (order === 'approval first') toolFrame();
    const details = await within(document.body).findByRole('region', { name: detailsName });
    expect(details.textContent).toBe(`${description}${command}`);
    expect(within(document.body).getByText(reason)).toBeTruthy();
    expect((await axe(document.body)).violations).toEqual([]);
    if (chinese) fireEvent.click(within(document.body).getByRole('button', { name: allowName }));
    else decide();
    expect((await peer.waitForCall('$events/result')).args).toEqual({ clientId: expect.any(String), eventId: 'approval', outcome: { kind: 'result', value: sent } });
    expect(session.getStatus()).not.toBe('invalidated');
  } finally {
    answer('Done');
    await done;
  }
});

it('declines a subagent approval natively without presenting it', async () => {
  renderApprovals(); create();
  const requestApproval = vi.spyOn(port, 'requestApproval');
  const run = session.execute(request());
  const done = collect(run.events, []);
  try {
    await peer.waitForCall('session/prompt');
    begin(run.executionId);
    const child = await startChild();
    child({ type: 'event', event: { type: 'tool/call', seq: 1, time, data: { callId: 'child-bash', name: 'bash', arguments: JSON.stringify({ command }) } } });
    approve('child', 'child-bash');
    expect((await peer.waitForCall('$events/result')).args).toEqual({ clientId: expect.any(String), eventId: 'approval', outcome: { kind: 'result', value: 'rejected' } });
    expect(requestApproval).not.toHaveBeenCalled();
    expect(within(document.body).queryByRole('region', { name: /approval details/ })).toBeNull();
    expect(session.getStatus()).not.toBe('invalidated');
  } finally {
    answer('Done');
    await done;
  }
});

it('renders the native reason immediately for an approval without a call ID', async () => {
  renderApprovals(); create();
  const run = session.execute(request());
  const done = collect(run.events, []);
  try {
    await peer.waitForCall('session/prompt');
    begin(run.executionId);
    approve('root');
    const details = await waitFor(() => within(document.body).getByRole('region', { name: 'Bash approval details' }), { timeout: 500 });
    expect(details.textContent).toBe(nativeReason.displayReason.en);
    expect((await axe(document.body)).violations).toEqual([]);
  } finally {
    answer('Done');
    await done;
  }
});

it('falls back to the native reason at the deadline when owned call details never arrive', async () => {
  renderApprovals(); create();
  const run = session.execute(request());
  const events: ProviderExecutionEvent[] = [];
  const done = collect(run.events, events);
  try {
    await peer.waitForCall('session/prompt');
    begin(run.executionId);
    await claimed(events);
    const realTimeout = setTimeout;
    // Only the interaction deadline, armed after this point, runs on the fake clock.
    vi.useFakeTimers({ toNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      approve('root', 'missing-call');
      await new Promise(resolve => realTimeout(resolve, 50));
      expect(within(document.body).queryByRole('region', { name: /approval details/ })).toBeNull();
      vi.advanceTimersByTime(10_000);
    } finally { vi.useRealTimers(); }
    const details = await waitFor(() => within(document.body).getByRole('region', { name: 'Bash approval details' }));
    expect(details.textContent).toBe(nativeReason.displayReason.en);
    expect(session.getStatus()).not.toBe('invalidated');
  } finally {
    answer('Done');
    await done;
  }
});

it('gives each approval its own wait for call details', async () => {
  const requests: Array<{ interactionId: string; description: string }> = [];
  port.requestApproval = vi.fn<typeof port.requestApproval>((input, signal) => {
    requests.push(input);
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Approval dismissed.')), { once: true }));
  });
  create();
  const run = session.execute(request());
  const done = collect(run.events, []);
  await peer.waitForCall('session/prompt');
  begin(run.executionId);
  const realTimeout = setTimeout;
  const settle = () => new Promise(resolve => realTimeout(resolve, 50));
  await settle();
  // Each deadline is armed on the fake clock, which also drives Date.
  vi.useFakeTimers({ toNotFake: ['nextTick', 'queueMicrotask'] });
  try {
    peer.send('$events', { type: 'waterfall', eventId: 'first', event: 'approval/request', agentId: 'root', request: { toolName: 'bash', callId: 'missing-first', ...nativeReason } });
    await settle();
    vi.advanceTimersByTime(9_000);
    peer.send('$events', { type: 'waterfall', eventId: 'second', event: 'approval/request', agentId: 'root', request: { toolName: 'bash', callId: 'bash-2', ...nativeReason } });
    await settle();
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(requests.map(r => [r.interactionId, r.description])).toEqual([['first', nativeReason.displayReason.en]]);
    event('tool/call', { callId: 'bash-2', name: 'bash', arguments: JSON.stringify({ command: 'ls' }) });
    await settle();
  } finally { vi.useRealTimers(); }
  expect(requests.map(r => [r.interactionId, r.description])).toEqual([['first', nativeReason.displayReason.en], ['second', 'Run command: ls']]);
  expect(session.getStatus()).not.toBe('invalidated');
  answer('Done');
  await done;
});
