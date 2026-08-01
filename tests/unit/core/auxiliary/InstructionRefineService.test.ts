import { InstructionRefineService } from '@/core/auxiliary/InstructionRefineService';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';

import {
  FakeAuxiliaryBackend,
  waitFor,
} from './AuxiliaryExecutionTestHarness';

function createService() {
  const backend = new FakeAuxiliaryBackend();
  const lifecycleRegistry = new ProviderExecutionLifecycleRegistry();
  const service = new InstructionRefineService({
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

describe('InstructionRefineService', () => {
  it('uses one passive ephemeral session for refinement and clarification', async () => {
    const { backend, service } = createService();
    service.setModelOverride('model-1');
    const progress = jest.fn();
    const first = service.refineInstruction('use ts', 'Existing', progress);
    await waitFor(() => backend.sessions[0]?.requests.length === 1);
    backend.sessions[0].emitText('Which language?');
    backend.sessions[0].complete();
    await expect(first).resolves.toMatchObject({
      clarification: 'Which language?',
      success: true,
    });

    const second = service.continueConversation('TypeScript');
    await waitFor(() => backend.sessions[0]?.requests.length === 2);
    backend.sessions[0].emitText('<instruction>Use TypeScript</instruction>');
    backend.sessions[0].complete();
    await expect(second).resolves.toMatchObject({
      refinedInstruction: 'Use TypeScript',
      success: true,
    });

    expect(backend.sessions).toHaveLength(1);
    expect(backend.configs[0]).toMatchObject({
      lifecycle: 'ephemeral',
      nativePersistence: 'provider-default',
    });
    expect(backend.sessions[0].requests[0]).toMatchObject({
      configuration: {
        model: 'model-1',
        systemInstructions: {
          instructions: expect.stringContaining('Existing'),
          kind: 'explicit',
        },
      },
      toolPolicy: { kind: 'passive' },
    });
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({
      clarification: 'Which language?',
    }));
  });

  it('returns a typed continuity reset after a forced transition', async () => {
    const { backend, lifecycleRegistry, service } = createService();
    const first = service.refineInstruction('use ts', '');
    await waitFor(() => backend.sessions[0]?.requests.length === 1);
    backend.sessions[0].emitText('Which language?');
    backend.sessions[0].complete();
    await first;

    await lifecycleRegistry.runTransition(['claude'], async () => undefined);

    await expect(service.continueConversation('TypeScript')).resolves.toMatchObject({
      error: expect.any(String),
      resetRequired: true,
      success: false,
    });

    const restarted = service.refineInstruction('use rust', '');
    await waitFor(() => backend.sessions.length === 2);
    expect(backend.sessions).toHaveLength(2);
    expect(backend.configs).toEqual([
      expect.objectContaining({ nativePersistence: 'provider-default' }),
      expect.objectContaining({ nativePersistence: 'provider-default' }),
    ]);
    backend.sessions[1].emitText('<instruction>Use Rust</instruction>');
    backend.sessions[1].complete();
    await expect(restarted).resolves.toMatchObject({ success: true });
  });

  it('cancels and releases only its own parked session', async () => {
    const { backend, service } = createService();
    const pending = service.refineInstruction('use ts', '');
    await waitFor(() => backend.sessions[0]?.requests.length === 1);
    service.cancel();

    await expect(pending).resolves.toEqual({
      error: 'Cancelled',
      success: false,
    });
    expect(backend.sessions[0].cancelCalls).toBeGreaterThan(0);
    expect(backend.sessions[0].disposeCalls).toBe(1);
  });
});
