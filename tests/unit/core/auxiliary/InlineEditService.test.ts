import {
  FakeAuxiliaryBackend,
  waitFor,
} from '@test/helpers/core/auxiliary/AuxiliaryExecutionTestHarness';

import { InlineEditService } from '@/core/auxiliary/InlineEditService';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';

const selection = { mode: 'selection', notePath: 'note.md', selectedText: 'draft' } as const;

function createService() {
  const backend = new FakeAuxiliaryBackend();
  const lifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  const service = new InlineEditService({
    backend,
    interactionPort: {
      askUserQuestion: jest.fn(),
      dismissInteraction: jest.fn(),
      requestApproval: jest.fn(),
    },
    lifecycleRegistry,
    nativePersistence: 'provider-default',
    vaultWorkingDirectory: '/vault',
  });
  return { backend, lifecycleRegistry, service };
}

describe('InlineEditService', () => {
  it('keeps clarification continuity in an independent read-only session', async () => {
    const { backend, service } = createService();
    const first = service.send({ ...selection, instruction: 'Improve' }, { model: 'edit-model', reasoning: 'high' });
    await waitFor(() => backend.sessions[0]?.requests.length === 1);
    backend.sessions[0].emitText('Which tone?');
    backend.sessions[0].complete();
    await expect(first).resolves.toMatchObject({
      clarification: 'Which tone?',
      success: true,
    });

    expect(service.isConversing).toBe(true);
    // Each request runs with the selection its caller holds now, including a continuation.
    const second = service.send(
      { ...selection, instruction: 'Formal', contextFiles: ['context.md'] },
      { model: 'other-model' },
    );
    await waitFor(() => backend.sessions[0]?.requests.length === 2);
    backend.sessions[0].emitText('<replacement>Final</replacement>');
    backend.sessions[0].complete();
    await expect(second).resolves.toMatchObject({
      editedText: 'Final',
      success: true,
    });

    expect(backend.sessions).toHaveLength(1);
    expect(backend.configs[0]).toMatchObject({
      lifecycle: 'ephemeral',
      nativePersistence: 'provider-default',
    });
    expect(backend.sessions[0].requests[0]).toMatchObject({
      configuration: {
        model: 'edit-model',
        reasoning: 'high',
        systemInstructions: {
          instructions: expect.stringContaining('Vault absolute path: /vault'),
          kind: 'explicit',
        },
      },
      toolPolicy: { kind: 'read-only' },
    });
    expect(backend.sessions[0].requests[1].configuration).toMatchObject({ model: 'other-model' });
    expect(backend.sessions[0].requests[1].configuration).not.toHaveProperty('reasoning');
    // A continuation carries the reply and its context files, not the editor context again.
    expect(backend.sessions[0].requests[1].input[0]).toMatchObject({
      text: expect.stringContaining('<context_files>'),
      type: 'text',
    });
    expect(backend.sessions[0].requests[1].input[0]).not.toMatchObject({
      text: expect.stringContaining('<editor_selection'),
    });
    expect(service.isConversing).toBe(false);
  });

  it('reports a transition that invalidated continuity and then starts from the editor context', async () => {
    const { backend, lifecycleRegistry, service } = createService();
    const first = service.send({ ...selection, instruction: 'Improve' });
    await waitFor(() => backend.sessions[0]?.requests.length === 1);
    backend.sessions[0].emitText('Which tone?');
    backend.sessions[0].complete();
    await first;

    await lifecycleRegistry.runTransition(['claude'], async () => undefined);
    await expect(service.send({ ...selection, instruction: 'Formal' })).resolves.toEqual({
      error: 'The provider environment changed. Start a new inline edit.',
      success: false,
    });
    expect(service.isConversing).toBe(false);

    const restarted = service.send({ ...selection, instruction: 'Shorten' });
    await waitFor(() => backend.sessions.length === 2);
    expect(backend.sessions).toHaveLength(2);
    expect(backend.configs).toEqual([
      expect.objectContaining({ nativePersistence: 'provider-default' }),
      expect.objectContaining({ nativePersistence: 'provider-default' }),
    ]);
    backend.sessions[1].emitText('<replacement>Short</replacement>');
    backend.sessions[1].complete();
    await expect(restarted).resolves.toMatchObject({ success: true });
  });
});
