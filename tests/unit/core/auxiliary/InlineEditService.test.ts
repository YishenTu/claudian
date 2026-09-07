import { InlineEditService } from '@/core/auxiliary/InlineEditService';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';

import {
  FakeAuxiliaryBackend,
  waitFor,
} from './AuxiliaryExecutionTestHarness';

function createService() {
  const backend = new FakeAuxiliaryBackend();
  const lifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  const service = new InlineEditService({
    backend,
    interactionPort: {
      askUserQuestion: jest.fn(),
      dismissInteraction: jest.fn(),
      requestApproval: jest.fn(),
      requestPlanDecision: jest.fn(),
    },
    lifecycleRegistry,
    vaultWorkingDirectory: '/vault',
  });
  return { backend, lifecycleRegistry, service };
}

describe('InlineEditService', () => {
  it('keeps clarification continuity in an independent read-only session', async () => {
    const { backend, service } = createService();
    service.setModelOverride('edit-model');
    const first = service.editText({
      instruction: 'Improve',
      mode: 'selection',
      notePath: 'note.md',
      selectedText: 'draft',
    });
    await waitFor(() => backend.sessions[0]?.requests.length === 1);
    backend.sessions[0].emitText('Which tone?');
    backend.sessions[0].complete();
    await expect(first).resolves.toMatchObject({
      clarification: 'Which tone?',
      success: true,
    });

    const second = service.continueConversation('Formal', ['context.md']);
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
        systemInstructions: {
          instructions: expect.stringContaining('Vault absolute path: /vault'),
          kind: 'explicit',
        },
      },
      toolPolicy: { kind: 'read-only' },
    });
    expect(backend.sessions[0].requests[1].input[0]).toMatchObject({
      text: expect.stringContaining('<context_files>'),
      type: 'text',
    });
  });

  it('requires an explicit root edit after transition invalidates continuity', async () => {
    const { backend, lifecycleRegistry, service } = createService();
    const first = service.editText({
      instruction: 'Improve',
      mode: 'selection',
      notePath: 'note.md',
      selectedText: 'draft',
    });
    await waitFor(() => backend.sessions[0]?.requests.length === 1);
    backend.sessions[0].emitText('Which tone?');
    backend.sessions[0].complete();
    await first;

    await lifecycleRegistry.runTransition(['claude'], async () => undefined);
    await expect(service.continueConversation('Formal')).resolves.toMatchObject({
      resetRequired: true,
      success: false,
    });

    const restarted = service.editText({
      instruction: 'Shorten',
      mode: 'selection',
      notePath: 'note.md',
      selectedText: 'draft',
    });
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
