/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions":["node","node-addons"]}
 */

import { NativePeer } from '@test/helpers/deepseek/NativePeer';
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
  peer.send('session/follow', { type: 'event', event: { type, seq: ++seq, time, data } });
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
  peer.onCall = method => {
    if (method === 'session/create') return { sessionId: 'root', agentPreset: 'claudian' };
    if (method === 'session/list') return { items: [{ sessionId: 'root', agentAvailable: true, running: false }] };
    if (method === 'permissionPresets/catalog') return { options: [{ value: 'workspace-write' }, { value: 'danger-full-access' }] };
    if (method === 'commands/list') return [{ name: 'permission' }, { name: 'compact', description: 'Compact history' }, { name: 'goal' }];
    if (method === 'skills/list') return { skills: [{ name: 'review', description: 'Review changes', modelInvocable: true }] };
    if (method === 'session/projections') return { asOfSeq: seq, values: { agentPreset: 'claudian', permissions: { currentValue: 'workspace-write' } } };
    if (method === 'session/page') return { hasMore: false, records: [
      { type: 'event', event: { type: 'sandbox/mode', seq: 1, time, data: { mode: 'workspace-write' } } },
      { type: 'event', event: { type: 'approval/policy', seq: 2, time, data: { policy: 'ask' } } },
    ] };
    if (method === 'session/prompt') return { accepted: true };
    if (method === '$events/result') return {};
    throw new Error(`Unexpected native call ${method}`);
  };
  peer.onOpen = (endpoint, _args, send) => {
    if (endpoint === 'session/control') send({ type: 'baseline', value: { projections: {} } });
    if (endpoint === 'session/follow') send({ type: 'snapshot', cursor: seq, records: [], header: { id: 'root', agentPreset: 'claudian' }, projections: { asOfSeq: seq, values: {} } });
    if (endpoint === 'job/list') send({ type: 'rows', jobs: [] });
  };
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

it('renders a native free-text question and sends its answer under the native ID', async () => {
  document.body.replaceChildren();
  port.askUserQuestion = input => new Promise(resolve => {
    const panel = new InlineAskUserQuestion(document.body.createDiv(), input.input,
      answers => resolve({ interactionId: input.interactionId, answers }));
    panel.render();
  });
  create();
  const run = session.execute(request());
  const done = collect(run.events, []);
  await waitFor(() => expect(peer.calls.some(c => c.method === 'session/prompt')).toBe(true));
  begin(run.executionId);
  peer.send('$events', { type: 'waterfall', eventId: 'question', event: 'user-questions/request', agentId: 'root', request: { questions: [{ id: 'native-name', question: 'Project name?' }] } });
  await waitFor(() => expect(within(document.body).getByRole('textbox', { name: 'Project name?' })).toBeTruthy());
  expect((await axe(document.body)).violations).toEqual([]);
  fireEvent.input(within(document.body).getByRole('textbox', { name: 'Project name?' }), { target: { value: 'Atlas' } });
  fireEvent.click(within(document.body).getByRole('button', { name: 'Submit' }));
  fireEvent.click(within(document.body).getByRole('button', { name: 'Submit answers' }));
  await waitFor(() => expect(peer.calls.find(c => c.method === '$events/result')?.args.outcome).toEqual({ kind: 'result', value: { answers: [{ id: 'native-name', selected: [], custom: 'Atlas' }] } }));
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
  await waitFor(() => expect(childFollow).toBeDefined());
  childFollow!({ type: 'snapshot', cursor: 0, records: [{ type: 'event', event: { type: 'turn/start', seq: 0, time, data: { turn: 0 } } }] });
  return childFollow!;
}

it.each([
  { name: 'a direct call', locale: 'en', reason: nativeReason.displayReason.en, callId: 'bash-1', order: 'tool first' },
  { name: 'a direct call whose tool frame arrives later', locale: 'zh-CN', reason: nativeReason.displayReason.zh, callId: 'bash-1', order: 'approval first' },
  { name: 'a code-mode call', locale: 'fr', reason: nativeReason.displayReason.en, callId: 'code-1:ptc:1', order: 'tool first' },
  { name: 'a subagent call', locale: 'en', reason: nativeReason.displayReason.en, callId: 'child-bash', order: 'approval first' },
])('renders the action and localized native reason for $name', async ({ locale, reason, callId, order }) => {
  settings.locale = locale;
  renderApprovals(); create();
  const run = session.execute(request());
  const done = collect(run.events, []);
  try {
    await waitFor(() => expect(peer.calls.some(c => c.method === 'session/prompt')).toBe(true));
    begin(run.executionId);
    const child = callId === 'child-bash' ? await startChild() : undefined;
    const toolFrame = (): void => {
      if (child) child({ type: 'event', event: { type: 'tool/call', seq: 1, time, data: { callId, name: 'bash', arguments: JSON.stringify({ command }) } } });
      else if (callId.includes(':ptc:')) {
        event('tool/call', { callId: 'code-1', name: 'run_code', arguments: JSON.stringify({ code: 'await bash({ command })' }) });
        event('tool/ptc-dispatch-start', { rootCallId: 'code-1', subCallId: callId, name: 'bash', arguments: { command } });
      } else event('tool/call', { callId, name: 'bash', arguments: JSON.stringify({ command }) });
    };
    if (order === 'tool first') { toolFrame(); await new Promise(resolve => setTimeout(resolve, 20)); }
    approve(child ? 'child' : 'root', callId);
    let early: HTMLElement | null = null;
    if (order === 'approval first') {
      await new Promise(resolve => setTimeout(resolve, 50));
      early = within(document.body).queryByRole('region', { name: /approval details/ });
      toolFrame();
    }
    expect(early).toBeNull();
    const details = await waitFor(() => within(document.body).getByRole('region', { name: 'Bash approval details' }));
    expect(details.textContent).toBe(`Run command: ${command}`);
    expect(within(document.body).getByText(reason)).toBeTruthy();
    expect((await axe(document.body)).violations).toEqual([]);
    fireEvent.click(within(document.body).getByRole('button', { name: 'Allow once' }));
    await waitFor(() => expect(peer.calls.find(c => c.method === '$events/result')?.args.outcome).toEqual({ kind: 'result', value: 'allowed-once' }));
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
  const done = collect(run.events, []);
  try {
    await waitFor(() => expect(peer.calls.some(c => c.method === 'session/prompt')).toBe(true));
    begin(run.executionId);
    await new Promise(resolve => setTimeout(resolve, 20));
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
