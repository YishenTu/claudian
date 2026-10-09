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
import { DeepSeekExecutionBackend } from '@/providers/deepseek/execution/DeepSeekExecutionBackend';
import type { DeepSeekHost } from '@/providers/deepseek/runtime/DeepSeekHost';

let peer: NativePeer;
let deepseek: DeepSeekHost;
let session: ProviderExecutionSession;
let seq: number;
let nativeTurn: number;
let port: ProviderInteractionPort;
const time = testDate().getTime();
const host = { settings: { providerConfigs: { deepseek: { enabled: true, visibleModels: ['deepseek:native/model'], discoveredModels: [{ encodedId: 'deepseek:native/model', provider: 'native', id: 'model', label: 'Model', reasoning: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] }] } } } } as unknown as ProviderHost;

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
  seq = 3; nativeTurn = 0;
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
