import { AuxiliarySessionController } from '@/core/auxiliary/AuxiliarySessionController';
import type {
  ProviderExecutionBackend,
  ProviderSessionConfig,
} from '@/core/execution';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';

import { FakeAuxiliarySession } from './AuxiliaryExecutionTestHarness';

class RejectingCleanupSession extends FakeAuxiliarySession {
  private rejectCleanup!: (reason: unknown) => void;
  private readonly cleanup = new Promise<void>((_resolve, reject) => {
    this.rejectCleanup = reject;
  });

  override dispose(): Promise<void> {
    return this.cleanup;
  }

  failCleanup(error: Error): void {
    this.rejectCleanup(error);
  }
}

class RejectingCleanupBackend implements ProviderExecutionBackend {
  readonly providerId = 'claude' as const;
  readonly session = new RejectingCleanupSession();

  createSession(_config: ProviderSessionConfig): RejectingCleanupSession {
    return this.session;
  }
}

function createController() {
  const backend = new RejectingCleanupBackend();
  const controller = new AuxiliarySessionController(
    {
      backend,
      interactionPort: {
        askUserQuestion: jest.fn(),
        dismissInteraction: jest.fn(),
        requestApproval: jest.fn(),
        requestPlanDecision: jest.fn(),
      },
      lifecycleRegistry: new ProviderExecutionLifecycleRegistry(),
      vaultWorkingDirectory: '/vault',
    },
    'instruction',
    { kind: 'passive' },
  );
  return { backend, controller };
}

async function flushUnhandledRejections(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

describe('AuxiliarySessionController', () => {
  it.each(['cancel', 'reset'] as const)(
    'handles a cleanup rejection after fire-and-forget %s',
    async (method) => {
      const { backend, controller } = createController();
      const cleanupError = new Error('cleanup failed');
      const unhandledReasons: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => {
        unhandledReasons.push(reason);
      };
      process.on('unhandledRejection', onUnhandledRejection);

      try {
        await controller.startRoot();
        controller[method]();
        backend.session.failCleanup(cleanupError);
        await flushUnhandledRejections();

        expect(unhandledReasons).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }
    },
  );

  it('keeps a fire-and-forget cleanup failure observable to an awaited caller', async () => {
    const { backend, controller } = createController();
    const cleanupError = new Error('cleanup failed');

    await controller.startRoot();
    controller.cancel();
    const restart = controller.startRoot();
    backend.session.failCleanup(cleanupError);

    await expect(restart).rejects.toBe(cleanupError);
  });
});
