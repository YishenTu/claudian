/**
 * @vitest-environment jsdom
 * @vitest-environment-options {"customExportConditions":["node","node-addons"]}
 */
import typedQuestion from '@test/fixtures/providers/grok/extensions/ask-user-question-typed.json';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { GrokNativeProcess } from '@test/helpers/providers/grok/GrokNativeProcess';
import { writeGrokCatalog } from '@test/helpers/providers/grokSettings';
import { fireEvent, within } from '@testing-library/dom';
import spawn from 'cross-spawn';

import type { ProviderExecutionRequest, ProviderExecutionSession, ProviderInteractionPort } from '@/core/execution';
import { InlineAskUserQuestion } from '@/features/chat/interactions/InlineAskUserQuestion';
import { GrokExecutionBackend } from '@/providers/grok/execution/GrokExecutionBackend';

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

async function startTurn(native: GrokNativeProcess): Promise<() => Promise<unknown>> {
  const { host } = await createProviderHostFixture({
    overrides: { getResolvedProviderCliPath: async () => 'grok' },
    settings: { model: 'grok/grok-4', providerConfigs: { grok: { enabled: true, visibleModels: ['grok-4'] } } },
  });
  writeGrokCatalog(host.settings, { defaultModelId: 'grok-4', fingerprint: 'fixture', refreshedAt: 1,
    models: [{ rawId: 'grok-4', displayName: 'grok-4', supportsReasoning: true, reasoningEfforts: [] }] });
  vi.mocked(spawn).mockImplementation(() => native.child);
  let finish!: () => void;
  let prompted!: () => void;
  const started = new Promise<void>(resolve => { prompted = resolve; });
  native.promptImplementation = () => new Promise(resolve => {
    finish = () => resolve({ stopReason: 'end_turn' });
    prompted();
  });
  session = new GrokExecutionBackend(host.getRuntimeHost('grok')).createSession({
    interactionPort: port, lifecycle: 'persistent', nativePersistence: 'enabled', workingDirectory: host.workingDirectory!,
    resumeSeed: { providerSessionId: 'session-existing', providerState: { sessionDirectory: '/tmp/grok-session' } },
  });
  const request: ProviderExecutionRequest = {
    configuration: { model: 'grok/grok-4', permissionMode: 'normal', reasoning: 'high', systemInstructions: { kind: 'explicit', purpose: 'title', instructions: 'Be exact.' } },
    input: [{ text: 'ask me', type: 'text' }],
    signal: new AbortController().signal,
    toolPolicy: { kind: 'provider-default' },
  };
  const run = session.execute(request);
  const done = (async () => { const events: unknown[] = []; for await (const event of run.events) events.push(event); return events; })();
  await started;
  return () => { finish(); return done; };
}

it('sends typed answers as Grok "Other" notes beside the selected labels', async () => {
  const native = new GrokNativeProcess();
  const finish = await startTurn(native);
  const { method, params } = typedQuestion.request;
  const reply = native.request(method, { ...params, sessionId: 'session-existing' });
  const panel = within(document.body);

  // A typed-only single-select answer.
  fireEvent.input(await panel.findByRole('textbox', { name: 'Favorite color?' }), { target: { value: 'Purple dragon (typed)' } });
  fireEvent.click(panel.getByRole('button', { name: 'Q2' }));
  // A multi-select answer that mixes an option with typed text.
  fireEvent.click(await panel.findByRole('button', { name: 'Cats' }));
  fireEvent.input(panel.getByRole('textbox', { name: 'Pets?' }), { target: { value: 'Hamsters (typed)' } });
  fireEvent.click(panel.getByRole('button', { name: 'Submit' }));
  fireEvent.click(panel.getByRole('button', { name: 'Submit answers' }));

  // Grok 1.0.77 keeps exactly this shape's typed text in its structured result (see the fixture's rawOutput).
  await expect(reply).resolves.toEqual(typedQuestion.acceptedResponse);
  await finish();
});
