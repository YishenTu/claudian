/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"customExportConditions":["node","node-addons"]}
 */
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { AntigravityNativeProcess } from '@test/helpers/providers/antigravity/AntigravityNativeProcess';
import { fireEvent, within } from '@testing-library/dom';
import spawn from 'cross-spawn';

import type { ProviderExecutionEvent, ProviderExecutionRequest, ProviderExecutionSession, ProviderInteractionPort } from '@/core/execution';
import { InlineAskUserQuestion } from '@/features/chat/interactions/InlineAskUserQuestion';
import type { ACPCreateElicitationRequest, ACPElicitationProperty } from '@/providers/acp';
import { AntigravityExecutionBackend } from '@/providers/antigravity/execution/AntigravityExecutionBackend';
import { updateAntigravityProviderSettings } from '@/providers/antigravity/settings';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

let session: ProviderExecutionSession | undefined;
afterEach(async () => {
  await session?.dispose();
  session = undefined;
  vi.mocked(spawn).mockReset();
  document.body.replaceChildren();
});

/** Answers questions through the real question panel, as the chat view does. */
const port: ProviderInteractionPort = {
  askUserQuestion: input => new Promise(resolve => {
    new InlineAskUserQuestion(document.body.createDiv(), input.input,
      answers => resolve({ interactionId: input.interactionId, answers })).render();
  }),
  dismissInteraction: vi.fn(),
  requestApproval: vi.fn(),
};

async function startTurn(): Promise<{ peer: AntigravityNativeProcess; done: Promise<ProviderExecutionEvent[]> }> {
  const { host } = await createProviderHostFixture({
    overrides: { getResolvedProviderCliPath: async () => 'agy' },
    settings: { providerConfigs: { antigravity: { enabled: true } } },
  });
  const vault = host.workingDirectory!;
  // agy's native store follows HOME; keep it inside the test vault.
  updateAntigravityProviderSettings(host.settings, { environmentVariables: `HOME=${vault}\nUSERPROFILE=${vault}` });
  let peer!: AntigravityNativeProcess;
  vi.mocked(spawn).mockImplementation(() => (peer = new AntigravityNativeProcess()).child);
  session = new AntigravityExecutionBackend(host.getRuntimeHost('antigravity')).createSession({
    interactionPort: port, lifecycle: 'persistent', nativePersistence: 'enabled', workingDirectory: vault,
  });
  const request: ProviderExecutionRequest = {
    configuration: { model: 'antigravity/gemini-4-argon', permissionMode: 'normal', reasoning: 'high', systemInstructions: { instructions: 'Be exact.', kind: 'main-agent' } },
    input: [{ text: 'ask me', type: 'text' }],
    signal: new AbortController().signal,
    toolPolicy: { kind: 'provider-default' },
  };
  const run = session.execute(request);
  const done = (async () => { const events: ProviderExecutionEvent[] = []; for await (const event of run.events) events.push(event); return events; })();
  await vi.waitFor(() => expect(peer).toBeDefined());
  await peer.waitForPrompts(1);
  return { peer, done };
}

function form(properties: ACPCreateElicitationRequest['requestedSchema']['properties']): ACPCreateElicitationRequest {
  return { message: 'Answer these', mode: 'form', requestedSchema: { properties, type: 'object' }, sessionId: 'session-new', toolCallId: 'tool-ask' };
}

const color: ACPElicitationProperty = { oneOf: [{ const: '1', title: 'Red' }, { const: '2', title: 'Blue' }], title: 'Color?', type: 'string' };

it('sends a typed single-select answer only in the field\'s `_other` companion', async () => {
  const { peer, done } = await startTurn();
  const reply = peer.createElicitation(form({ q1: color, q1_other: { title: 'Other', type: 'string' } }));

  fireEvent.input(await within(document.body).findByRole('textbox', { name: 'Color?' }), { target: { value: 'Green' } });
  fireEvent.click(within(document.body).getByRole('button', { name: 'Submit' }));
  fireEvent.click(within(document.body).getByRole('button', { name: 'Submit answers' }));

  await expect(reply).resolves.toEqual({ action: 'accept', content: { q1_other: 'Green' } });
  peer.finishPrompt();
  await done;
});

it('offers no typed answer for a field without an `_other` companion', async () => {
  const { peer, done } = await startTurn();
  const reply = peer.createElicitation(form({ q1: color }));

  const option = await within(document.body).findByRole('button', { name: 'Blue' });
  // The panel rendered this question; only its free-text row is missing.
  expect(within(document.body).getByText('Color?')).toBeTruthy();
  expect(within(document.body).queryByRole('textbox')).toBeNull();
  fireEvent.click(option);
  fireEvent.click(within(document.body).getByRole('button', { name: 'Submit' }));
  fireEvent.click(within(document.body).getByRole('button', { name: 'Submit answers' }));

  await expect(reply).resolves.toEqual({ action: 'accept', content: { q1: '2' } });
  peer.finishPrompt();
  await done;
});
