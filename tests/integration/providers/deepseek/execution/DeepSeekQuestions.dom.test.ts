/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions":["node","node-addons"]}
 */

import { nativeDefaults } from '@test/helpers/deepseek/NativeDefaults';
import { NativePeer, rootFollow } from '@test/helpers/deepseek/NativePeer';
import { testDate } from '@test/helpers/testClock';
import { fireEvent, waitFor,within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import type { ProviderExecutionEvent, ProviderExecutionRequest, ProviderExecutionSession, ProviderInteractionPort } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { InlineAskUserQuestion } from '@/features/chat/interactions/InlineAskUserQuestion';
import { InlineInteractionPrompts } from '@/features/chat/interactions/InlineInteractionPrompts';
import { createInteractionPromptPort } from '@/features/chat/interactions/interactionPromptPort';
import { ChatState } from '@/features/chat/state/ChatState';
import { DeepSeekExecutionBackend } from '@/providers/deepseek/execution/DeepSeekExecutionBackend';
import type { DeepSeekHost } from '@/providers/deepseek/runtime/DeepSeekHost';

let peer: NativePeer;
let deepseek: DeepSeekHost;
let session: ProviderExecutionSession;
let seq: number;
let nativeTurn: number;
let port: ProviderInteractionPort;
const time = testDate().getTime();
const settings = { locale: 'en', providerConfigs: { deepseek: { enabled: true, visibleModels: ['deepseek:native/model'], discoveredModels: [{ encodedId: 'deepseek:native/model', provider: 'native', id: 'model', label: 'Model', reasoning: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] }] } } };
const host = { settings } as unknown as ProviderHost;

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
async function collect(events: AsyncIterable<ProviderExecutionEvent>, into: ProviderExecutionEvent[]): Promise<void> { for await (const event of events) into.push(event); }

beforeEach(async () => {
  seq = 3; nativeTurn = 0; settings.locale = 'en';
  port = { requestApproval: jest.fn(), askUserQuestion: jest.fn(), dismissInteraction: jest.fn() };
  peer = new NativePeer();
  const native = nativeDefaults({ seq: () => seq, roster: () => ['root'] });
  peer.onCall = (method, args) => method === 'session/create' ? { sessionId: 'root', agentPreset: 'claudian' } : native.call(method, args);
  peer.onOpen = native.open;
  await peer.open();
  ({ deepseek } = peer.host());
});
afterEach(async () => { await session?.dispose(); await deepseek.dispose(); await peer.close(); });

function create(): void {
  session = new DeepSeekExecutionBackend(host, () => deepseek).createSession({
    lifecycle: 'persistent', nativePersistence: 'enabled', vaultWorkingDirectory: '/vault', interactionPort: port,
  });
}


HTMLElement.prototype.empty = function () { this.replaceChildren(); };
HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
HTMLElement.prototype.removeClass = function (...classes) { this.classList.remove(...classes); };
HTMLElement.prototype.toggleClass = function (names, enabled) {
  for (const name of Array.isArray(names) ? names : [names]) this.classList.toggle(name, enabled);
};
HTMLElement.prototype.scrollIntoView = function () {};
HTMLElement.prototype.setText = function (text) { this.textContent = String(text); };

/** Resolves once the session published an event, which it does only after applying the native frame behind it. */
async function published(events: ProviderExecutionEvent[], expected: Record<string, unknown>): Promise<void> {
  await waitFor(() => expect(events).toContainEqual(expect.objectContaining(expected)));
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
  await waitFor(() => expect(peer.calls.some(c => c.method === 'session/prompt')).toBe(true));
  begin(run.executionId);
  await claimed(events);
  peer.send('$events', { type: 'waterfall', eventId: 'question', event: 'user-questions/request', agentId: 'root', request: { questions: [question] } });
  await within(document.body).findByRole('region', { name: 'Question' });
  expect((await axe(document.body)).violations).toEqual([]);
  await respond();
  fireEvent.click(within(document.body).getByRole('button', { name: 'Submit' }));
  fireEvent.click(within(document.body).getByRole('button', { name: 'Submit answers' }));
  await waitFor(() => expect(peer.calls.find(c => c.method === '$events/result')?.args).toEqual({ clientId: expect.any(String), eventId: 'question', outcome: { kind: 'result', value: { answers: [sent] } } }));
  answer('saved');
  await done;
});

const command = 'rm -rf /tmp/review-generated';
const nativeReason = {
  reason: 'escalate sandbox to danger-full-access: update generated files',
  displayReason: { en: 'Allow this operation with danger-full-access permissions: update generated files', zh: '允许本次操作使用 danger-full-access 权限：update generated files' },
};

function renderApprovals(): void {
  document.body.replaceChildren();
  const prompts = new InlineInteractionPrompts({ getPromptParentEl: () => document.body });
  port = createInteractionPromptPort(new ChatState(), () => prompts);
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
  renderApprovals(); create();
  const run = session.execute(request());
  const events: ProviderExecutionEvent[] = [];
  const done = collect(run.events, events);
  try {
    await waitFor(() => expect(peer.calls.some(c => c.method === 'session/prompt')).toBe(true));
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
    const details = await within(document.body).findByRole('region', { name: 'Bash approval details' });
    expect(details.textContent).toBe(`Run command: ${command}`);
    expect(within(document.body).getByText(reason)).toBeTruthy();
    expect((await axe(document.body)).violations).toEqual([]);
    decide();
    await waitFor(() => expect(peer.calls.find(c => c.method === '$events/result')?.args).toEqual({ clientId: expect.any(String), eventId: 'approval', outcome: { kind: 'result', value: sent } }));
    expect(session.getStatus()).not.toBe('invalidated');
  } finally {
    answer('Done');
    await done;
  }
});

it('declines a subagent approval natively without presenting it', async () => {
  renderApprovals(); create();
  const requestApproval = jest.spyOn(port, 'requestApproval');
  const run = session.execute(request());
  const done = collect(run.events, []);
  try {
    await waitFor(() => expect(peer.calls.some(c => c.method === 'session/prompt')).toBe(true));
    begin(run.executionId);
    const child = await startChild();
    child({ type: 'event', event: { type: 'tool/call', seq: 1, time, data: { callId: 'child-bash', name: 'bash', arguments: JSON.stringify({ command }) } } });
    approve('child', 'child-bash');
    await waitFor(() => expect(peer.calls.find(c => c.method === '$events/result')?.args).toEqual({ clientId: expect.any(String), eventId: 'approval', outcome: { kind: 'result', value: 'rejected' } }));
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
    await waitFor(() => expect(peer.calls.some(c => c.method === 'session/prompt')).toBe(true));
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
    await waitFor(() => expect(peer.calls.some(c => c.method === 'session/prompt')).toBe(true));
    begin(run.executionId);
    await claimed(events);
    const realTimeout = setTimeout;
    // Only the interaction deadline, armed after this point, runs on the fake clock.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
    try {
      approve('root', 'missing-call');
      await new Promise(resolve => realTimeout(resolve, 50));
      expect(within(document.body).queryByRole('region', { name: /approval details/ })).toBeNull();
      jest.advanceTimersByTime(10_000);
    } finally { jest.useRealTimers(); }
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
  port.requestApproval = jest.fn((input, signal) => {
    requests.push(input);
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Approval dismissed.')), { once: true }));
  });
  create();
  const run = session.execute(request());
  const done = collect(run.events, []);
  await waitFor(() => expect(peer.calls.some(c => c.method === 'session/prompt')).toBe(true));
  begin(run.executionId);
  const realTimeout = setTimeout;
  const settle = () => new Promise(resolve => realTimeout(resolve, 50));
  await settle();
  // Each deadline is armed on the fake clock, which also drives Date.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
  try {
    peer.send('$events', { type: 'waterfall', eventId: 'first', event: 'approval/request', agentId: 'root', request: { toolName: 'bash', callId: 'missing-first', ...nativeReason } });
    await settle();
    jest.advanceTimersByTime(9_000);
    peer.send('$events', { type: 'waterfall', eventId: 'second', event: 'approval/request', agentId: 'root', request: { toolName: 'bash', callId: 'bash-2', ...nativeReason } });
    await settle();
    jest.advanceTimersByTime(1_000);
    await settle();
    expect(requests.map(r => [r.interactionId, r.description])).toEqual([['first', nativeReason.displayReason.en]]);
    event('tool/call', { callId: 'bash-2', name: 'bash', arguments: JSON.stringify({ command: 'ls' }) });
    await settle();
  } finally { jest.useRealTimers(); }
  expect(requests.map(r => [r.interactionId, r.description])).toEqual([['first', nativeReason.displayReason.en], ['second', 'Run command: ls']]);
  expect(session.getStatus()).not.toBe('invalidated');
  answer('Done');
  await done;
});
