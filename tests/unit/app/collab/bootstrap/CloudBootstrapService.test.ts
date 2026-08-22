import {
  CloudBootstrapCoordinator,
  type CloudBootstrapCoordinatorOptions,
} from '@/app/collab/bootstrap/CloudBootstrapCoordinator';
import { CloudBootstrapReadinessCollector } from '@/app/collab/bootstrap/CloudBootstrapReadiness';
import { CloudBootstrapService } from '@/app/collab/bootstrap/CloudBootstrapService';
import type { CloudBootstrapTransitionRecord } from '@/app/collab/bootstrap/CloudBootstrapTransitionRecord';
import { CollabError } from '@/core/collab/ClaudianCollabError';

import {
  bootstrapManifest,
  finalizeActivatedBindingForTest,
  HOST_MEMBER_ID,
  OTHER_MEMBER_ID,
  PROJECT_ID,
} from './fixtures';

function pendingTransition(
  projectId = PROJECT_ID,
  memberId = HOST_MEMBER_ID,
): CloudBootstrapTransitionRecord {
  return {
    attemptState: 'pending',
    developmentActorId: memberId,
    memberId,
    newAuthority: { serverUrl: 'https://cloud.example.test/' },
    projectId,
  } as CloudBootstrapTransitionRecord;
}

describe('CloudBootstrapService', () => {
  it('fences every uncertain transition before local recovery preparation completes', async () => {
    const fenceUncertainProject = jest.fn(async (_projectId: string) => undefined);
    const recoverLocalArtifacts = jest.fn(async () => undefined);
    const createCoordinator = jest.fn();
    const service = new CloudBootstrapService({
      createCoordinator,
      fenceUncertainProject,
      recoverLocalArtifacts,
      transitions: {
        load: async () => null,
        list: async () => ({
          blockedProjectIds: ['project-corrupt'],
          records: [{
            attemptState: 'pending',
            projectId: 'project-pending',
            terminalCleanupCompleted: false,
          }, {
            attemptState: 'activated',
            projectId: 'project-activated',
            terminalCleanupCompleted: true,
          }, {
            attemptState: 'cancelled',
            projectId: 'project-cancelling',
            terminalCleanupCompleted: false,
          }, {
            attemptState: 'cancelled',
            projectId: 'project-cancelled',
            terminalCleanupCompleted: true,
          }] as never,
          retryRequired: false,
        }),
      },
    });

    await service.prepareLocalRecovery();

    expect(fenceUncertainProject.mock.calls.map(([projectId]) => projectId).sort()).toEqual([
      'project-cancelling',
      'project-corrupt',
      'project-pending',
    ]);
    expect(recoverLocalArtifacts).not.toHaveBeenCalled();
    expect(createCoordinator).not.toHaveBeenCalled();
  });

  it('aborts a stalled concrete readiness operation before close completes', async () => {
    let record: CloudBootstrapTransitionRecord | null = null;
    let markReadinessStarted: (() => void) | undefined;
    const readinessStarted = new Promise<void>(resolve => { markReadinessStarted = resolve; });
    const transitions = {
      create: async (next: CloudBootstrapTransitionRecord) => {
        record = next;
        return next;
      },
      list: async () => ({ blockedProjectIds: [], records: [], retryRequired: false }),
      load: async () => record,
      save: async (next: CloudBootstrapTransitionRecord) => { record = next; },
    };
    const createCoordinator = () => new CloudBootstrapCoordinator({
      binding: { finalize: async record => finalizeActivatedBindingForTest(record) },
      cloud: {
        activate: async () => { throw new Error('unexpected activation'); },
        begin: async () => { throw new Error('unexpected begin'); },
        cancel: async () => { throw new Error('unexpected cancellation'); },
        get: async () => null,
        report: async () => { throw new Error('unexpected report'); },
        upload: async () => { throw new Error('unexpected upload'); },
      },
      createFenceId: () => 'bootstrap-fence-one',
      formerHost: {
        stopAndDrain: async () => ({
          autoStartDisabled: true,
          resourcesDrained: true,
          routeUnregistered: true,
          stoppedAt: '2026-08-21T00:00:02.000Z',
        }),
      },
      localIdentity: {
        load: async () => ({
          authorityKind: 'lan',
          caFingerprint: 'b'.repeat(64),
          endpoint: 'https://192.168.1.20:54545',
          gitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
          memberId: HOST_MEMBER_ID,
          ownsAuthority: true,
          projectId: PROJECT_ID,
        }),
      },
      readiness: new CloudBootstrapReadinessCollector({
        inspect: async (_projectId, _memberId, signal) => {
          markReadinessStarted?.();
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              reject(new CollabError({ code: 'cancelled' }));
            }, { once: true });
          });
        },
      }),
      source: {
        assertManifestCurrent: async () => undefined,
        captureManifest: async () => bootstrapManifest(),
        discardBundle: async () => undefined,
        openBundle: async function* () { yield new Uint8Array([1]); },
      },
      transitions,
      workSessions: {
        closeAndDrain: async () => undefined,
        completeAfterActivation: async () => undefined,
        resumeAfterCancellation: async () => undefined,
      },
    } satisfies CloudBootstrapCoordinatorOptions);
    const service = new CloudBootstrapService({
      createCoordinator,
      fenceUncertainProject: async () => undefined,
      recoverLocalArtifacts: async () => undefined,
      transitions,
    });

    const starting = service.startFormerHost({
      memberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    });
    await readinessStarted;
    await service.close();

    await expect(starting).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('reconstructs actor-bound coordinators and reconciles pending and terminal transitions', async () => {
    const events: string[] = [];
    const recoverProject = jest.fn(async (projectId: string) => {
      events.push(`recover:${projectId}`);
      return null;
    });
    const createCoordinator = jest.fn(() => ({ recoverProject }) as unknown as CloudBootstrapCoordinator);
    const fenceUncertainProject = jest.fn(async (projectId: string) => {
      events.push(`fence:${projectId}`);
    });
    const service = new CloudBootstrapService({
      createCoordinator,
      fenceUncertainProject,
      recoverLocalArtifacts: async () => { events.push('artifacts'); },
      transitions: {
        load: async () => null,
        list: async () => ({
          blockedProjectIds: ['project-corrupt'],
          records: [
            {
              attemptState: 'pending',
              developmentActorId: HOST_MEMBER_ID,
              memberId: HOST_MEMBER_ID,
              newAuthority: { serverUrl: 'https://cloud.example.test/' },
              projectId: PROJECT_ID,
            },
            {
              attemptState: 'activated',
              developmentActorId: OTHER_MEMBER_ID,
              memberId: OTHER_MEMBER_ID,
              newAuthority: { serverUrl: 'https://cloud.example.test/' },
              projectId: 'project-complete',
            },
          ] as never,
          retryRequired: false,
        }),
      },
    });

    await service.recoverPending();

    expect(fenceUncertainProject).toHaveBeenCalledWith('project-corrupt');
    expect(events.slice(0, 5)).toEqual([
      'fence:project-corrupt',
      `fence:${PROJECT_ID}`,
      'fence:project-complete',
      'artifacts',
      `recover:${PROJECT_ID}`,
    ]);
    expect(createCoordinator).toHaveBeenCalledTimes(2);
    expect(createCoordinator).toHaveBeenCalledWith({
      developmentActorId: HOST_MEMBER_ID,
      serverUrl: 'https://cloud.example.test/',
    });
    expect(createCoordinator).toHaveBeenCalledWith({
      developmentActorId: OTHER_MEMBER_ID,
      serverUrl: 'https://cloud.example.test/',
    });
    expect(recoverProject).toHaveBeenCalledWith(PROJECT_ID, expect.any(AbortSignal));
    expect(recoverProject).toHaveBeenCalledWith(
      'project-complete',
      expect.any(AbortSignal),
    );
  });

  it('fails closed before recovery or cancellation with a mismatched durable actor', async () => {
    const createCoordinator = jest.fn();
    const service = new CloudBootstrapService({
      createCoordinator,
      fenceUncertainProject: async () => undefined,
      recoverLocalArtifacts: async () => undefined,
      transitions: {
        load: async () => ({
          attemptState: 'pending',
          developmentActorId: OTHER_MEMBER_ID,
          memberId: HOST_MEMBER_ID,
          newAuthority: { serverUrl: 'https://cloud.example.test/' },
          projectId: PROJECT_ID,
        }) as never,
        list: async () => ({
          blockedProjectIds: [],
          records: [{
            attemptState: 'pending',
            developmentActorId: OTHER_MEMBER_ID,
            memberId: HOST_MEMBER_ID,
            newAuthority: { serverUrl: 'https://cloud.example.test/' },
            projectId: PROJECT_ID,
          }] as never,
          retryRequired: false,
        }),
      },
    });

    await expect(service.recoverPending()).resolves.toBeUndefined();
    await expect(service.cancel(PROJECT_ID)).rejects.toMatchObject({
      safeContext: { reason: 'cloud-bootstrap-transition-actor-mismatch' },
    });
    expect(createCoordinator).not.toHaveBeenCalled();
  });

  it('exposes both start roles through the shipped service', async () => {
    const startFormerHost = jest.fn(async () => ({ projectId: PROJECT_ID }));
    const submitParticipant = jest.fn(async () => ({ projectId: PROJECT_ID }));
    const service = new CloudBootstrapService({
      createCoordinator: () => ({
        startFormerHost,
        submitParticipant,
      }) as unknown as CloudBootstrapCoordinator,
      fenceUncertainProject: async () => undefined,
      recoverLocalArtifacts: async () => undefined,
      transitions: {
        list: async () => ({ blockedProjectIds: [], records: [], retryRequired: false }),
        load: async () => null,
      },
    });

    await service.startFormerHost({
      memberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    });
    await service.submitParticipant({
      manifest: bootstrapManifest(),
      memberId: OTHER_MEMBER_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    });

    expect(startFormerHost).toHaveBeenCalledWith(expect.objectContaining({
      developmentActorId: HOST_MEMBER_ID,
    }), expect.any(AbortSignal));
    expect(submitParticipant).toHaveBeenCalledWith(expect.objectContaining({
      developmentActorId: OTHER_MEMBER_ID,
    }), expect.any(AbortSignal));
  });

  it('polls a directly started Project while Cloud activation remains pending', async () => {
    const record = pendingTransition();
    const startFormerHost = jest.fn(async () => record);
    let retry: (() => Promise<void>) | undefined;
    const scheduleRetry = jest.fn((_retryKey, operation, delayMs) => {
      retry = operation;
      expect(delayMs).toBe(1_000);
    });
    const recoverProject = jest.fn(async () => ({
      ...record,
      attemptState: 'activated' as const,
    }));
    const service = new CloudBootstrapService({
      createCoordinator: () => ({
        recoverProject,
        startFormerHost,
      }) as unknown as CloudBootstrapCoordinator,
      fenceUncertainProject: async () => undefined,
      recoverLocalArtifacts: async () => undefined,
      scheduleRetry,
      transitions: {
        list: async () => ({ blockedProjectIds: [], records: [], retryRequired: false }),
        load: async () => record,
      },
    });

    await service.startFormerHost({
      memberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    });

    expect(scheduleRetry).toHaveBeenCalledWith(PROJECT_ID, expect.any(Function), 1_000);
    await retry?.();
    expect(recoverProject).toHaveBeenCalledWith(PROJECT_ID, expect.any(AbortSignal));
    await service.close();
  });

  it('schedules recovery when direct activation reaches durable state before binding fails', async () => {
    const activated = {
      ...pendingTransition(),
      attemptState: 'activated' as const,
      terminalCleanupCompleted: false,
    } as CloudBootstrapTransitionRecord;
    const failure = new CollabError({
      code: 'durable-progress-recovery-required',
      recoveryActions: ['retry', 'open-diagnostics'],
      safeContext: { reason: 'cloud-bootstrap-binding-index-repair-failed' },
    });
    const startFormerHost = jest.fn().mockRejectedValue(failure);
    const recoverProject = jest.fn(async () => ({
      ...activated,
      terminalCleanupCompleted: true,
    }));
    let retry: (() => Promise<void>) | undefined;
    const scheduleRetry = jest.fn((_retryKey, operation, delayMs) => {
      retry = operation;
      expect(delayMs).toBe(1_000);
    });
    const service = new CloudBootstrapService({
      createCoordinator: () => ({
        recoverProject,
        startFormerHost,
      }) as unknown as CloudBootstrapCoordinator,
      fenceUncertainProject: async () => undefined,
      recoverLocalArtifacts: async () => undefined,
      scheduleRetry,
      transitions: {
        list: async () => ({ blockedProjectIds: [], records: [], retryRequired: false }),
        load: async () => activated,
      },
    });

    await expect(service.startFormerHost({
      memberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    })).rejects.toBe(failure);

    expect(scheduleRetry).toHaveBeenCalledWith(PROJECT_ID, expect.any(Function), 1_000);
    await retry?.();
    expect(recoverProject).toHaveBeenCalledWith(PROJECT_ID, expect.any(AbortSignal));
    await service.close();
  });

  it('schedules recovery when cancellation interrupts an incomplete durable transition', async () => {
    const activated = {
      ...pendingTransition(),
      attemptState: 'activated' as const,
      terminalCleanupCompleted: false,
    } as CloudBootstrapTransitionRecord;
    const failure = new CollabError({ code: 'cancelled' });
    const startFormerHost = jest.fn().mockRejectedValue(failure);
    const scheduleRetry = jest.fn();
    const service = new CloudBootstrapService({
      createCoordinator: () => ({
        startFormerHost,
      }) as unknown as CloudBootstrapCoordinator,
      fenceUncertainProject: async () => undefined,
      recoverLocalArtifacts: async () => undefined,
      scheduleRetry,
      transitions: {
        list: async () => ({ blockedProjectIds: [], records: [], retryRequired: false }),
        load: async () => activated,
      },
    });

    await expect(service.startFormerHost({
      memberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    })).rejects.toBe(failure);

    expect(scheduleRetry).toHaveBeenCalledWith(PROJECT_ID, expect.any(Function), 1_000);
    await service.close();
  });

  it('continues bounded Project polling after a successful pending recovery', async () => {
    const record = pendingTransition();
    const recoverProject = jest.fn()
      .mockResolvedValueOnce(record)
      .mockResolvedValueOnce({ ...record, attemptState: 'activated' as const });
    let retry: (() => Promise<void>) | undefined;
    const scheduleRetry = jest.fn((_retryKey, operation, delayMs) => {
      retry = operation;
      expect(delayMs).toBe(1_000);
    });
    const service = new CloudBootstrapService({
      createCoordinator: () => ({ recoverProject }) as unknown as CloudBootstrapCoordinator,
      fenceUncertainProject: async () => undefined,
      recoverLocalArtifacts: async () => undefined,
      scheduleRetry,
      transitions: {
        load: async () => record,
        list: async () => ({
          blockedProjectIds: [],
          records: [record],
          retryRequired: false,
        }),
      },
    });

    await service.recoverPending();

    expect(scheduleRetry).toHaveBeenCalledWith(PROJECT_ID, expect.any(Function), 1_000);
    await retry?.();
    expect(recoverProject).toHaveBeenCalledTimes(2);
    await service.close();
  });

  it('isolates Project recovery failures and schedules bounded retry', async () => {
    const hostRecord = pendingTransition();
    const otherRecord = pendingTransition('project-other', OTHER_MEMBER_ID);
    const recoverHost = jest.fn()
      .mockRejectedValueOnce(new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['retry', 'open-diagnostics'],
        safeContext: { reason: 'cloud-bootstrap-binding-retired-authority-missing' },
      }))
      .mockResolvedValue(null);
    const recoverOther = jest.fn(async () => null);
    const cancelRetry = jest.fn();
    let retry: (() => Promise<void>) | undefined;
    const scheduleRetry = jest.fn((_projectId, operation, delayMs) => {
      retry = operation;
      expect(delayMs).toBe(1_000);
      return cancelRetry;
    });
    const service = new CloudBootstrapService({
      createCoordinator: ({ developmentActorId }) => ({
        recoverProject: developmentActorId === HOST_MEMBER_ID
          ? recoverHost
          : recoverOther,
      }) as unknown as CloudBootstrapCoordinator,
      fenceUncertainProject: async () => undefined,
      recoverLocalArtifacts: async () => undefined,
      scheduleRetry,
      transitions: {
        load: async projectId => projectId === PROJECT_ID ? hostRecord : otherRecord,
        list: async () => ({
          blockedProjectIds: [],
          records: [hostRecord, otherRecord],
          retryRequired: false,
        }),
      },
    });

    await expect(service.recoverPending()).resolves.toBeUndefined();
    expect(recoverHost).toHaveBeenCalledWith(PROJECT_ID, expect.any(AbortSignal));
    expect(recoverOther).toHaveBeenCalledWith('project-other', expect.any(AbortSignal));
    expect(scheduleRetry).toHaveBeenCalledTimes(1);

    await retry?.();
    expect(recoverHost).toHaveBeenCalledTimes(2);
    await service.close();
    expect(cancelRetry).not.toHaveBeenCalled();
  });

  it('retries cancellation cleanup after the local fence replaces its tokens', async () => {
    const record = {
      ...pendingTransition(),
      attemptState: 'cancelled',
      terminalCleanupCompleted: false,
    } as CloudBootstrapTransitionRecord;
    const completed = {
      ...record,
      terminalCleanupCompleted: true,
    } as CloudBootstrapTransitionRecord;
    const recoverProject = jest.fn()
      .mockRejectedValueOnce(new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['retry', 'open-diagnostics'],
        safeContext: { reason: 'cloud-bootstrap-admission-resume-failed' },
      }))
      .mockResolvedValueOnce(completed);
    let retry: (() => Promise<void>) | undefined;
    const scheduleRetry = jest.fn((_projectId, operation, delayMs) => {
      retry = operation;
      expect(delayMs).toBe(1_000);
    });
    const service = new CloudBootstrapService({
      createCoordinator: () => ({ recoverProject }) as unknown as CloudBootstrapCoordinator,
      fenceUncertainProject: async () => undefined,
      recoverLocalArtifacts: async () => undefined,
      scheduleRetry,
      transitions: {
        load: async () => record,
        list: async () => ({
          blockedProjectIds: [],
          records: [record],
          retryRequired: false,
        }),
      },
    });

    await service.recoverPending();

    expect(scheduleRetry).toHaveBeenCalledWith(PROJECT_ID, expect.any(Function), 1_000);
    await retry?.();
    expect(recoverProject).toHaveBeenCalledTimes(2);
    expect(await recoverProject.mock.results[1]?.value).toEqual(completed);
    await service.close();
  });

  it('schedules bounded catalog retry without suppressing later Project recovery', async () => {
    const recoverProject = jest.fn(async () => null);
    const recoverLocalArtifacts = jest.fn()
      .mockRejectedValueOnce(new CollabError({ code: 'operation-failed' }))
      .mockResolvedValueOnce(undefined);
    const list = jest.fn().mockResolvedValue({
      blockedProjectIds: [],
      records: [{
        attemptState: 'pending',
        developmentActorId: HOST_MEMBER_ID,
        memberId: HOST_MEMBER_ID,
        newAuthority: { serverUrl: 'https://cloud.example.test/' },
        projectId: PROJECT_ID,
      }] as never,
      retryRequired: false,
    });
    let retry: (() => Promise<void>) | undefined;
    const scheduleRetry = jest.fn((_retryKey, operation, delayMs) => {
      retry = operation;
      expect(delayMs).toBe(1_000);
    });
    const service = new CloudBootstrapService({
      createCoordinator: () => ({ recoverProject }) as unknown as CloudBootstrapCoordinator,
      fenceUncertainProject: async () => undefined,
      recoverLocalArtifacts,
      scheduleRetry,
      transitions: { list, load: async () => null },
    });

    await expect(service.recoverPending()).resolves.toBeUndefined();
    expect(scheduleRetry).toHaveBeenCalledWith('catalog', expect.any(Function), 1_000);
    expect(list).toHaveBeenCalledTimes(1);
    expect(recoverProject).toHaveBeenCalledTimes(1);

    await retry?.();
    expect(recoverLocalArtifacts).toHaveBeenCalledTimes(2);
    expect(recoverProject).toHaveBeenCalledTimes(2);
    expect(recoverProject).toHaveBeenCalledWith(PROJECT_ID, expect.any(AbortSignal));
    await service.close();
  });

  it('aborts active Project recovery before close drains it', async () => {
    let observedSignal: AbortSignal | undefined;
    let markRecoveryStarted: (() => void) | undefined;
    const recoveryStarted = new Promise<void>(resolve => {
      markRecoveryStarted = resolve;
    });
    const recoverProject = jest.fn((_projectId: string, signal?: AbortSignal) => (
      new Promise<null>(resolve => {
        observedSignal = signal;
        markRecoveryStarted?.();
        if (signal?.aborted) {
          resolve(null);
          return;
        }
        const timer = setTimeout(() => resolve(null), 250);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve(null);
        }, { once: true });
      })
    ));
    const service = new CloudBootstrapService({
      createCoordinator: () => ({ recoverProject }) as unknown as CloudBootstrapCoordinator,
      fenceUncertainProject: async () => undefined,
      recoverLocalArtifacts: async () => undefined,
      transitions: {
        load: async () => null,
        list: async () => ({
          blockedProjectIds: [],
          records: [{
            attemptState: 'pending',
            developmentActorId: HOST_MEMBER_ID,
            memberId: HOST_MEMBER_ID,
            newAuthority: { serverUrl: 'https://cloud.example.test/' },
            projectId: PROJECT_ID,
          }] as never,
          retryRequired: false,
        }),
      },
    });

    const recovery = service.recoverPending();
    await recoveryStarted;
    const startedAt = Date.now();
    await service.close();

    expect(Date.now() - startedAt).toBeLessThan(150);
    expect(observedSignal?.aborted).toBe(true);
    await expect(recovery).resolves.toBeUndefined();
  });
});
