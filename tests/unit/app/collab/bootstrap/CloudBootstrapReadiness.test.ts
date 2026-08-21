import {
  CloudBootstrapReadinessCollector,
  type CloudBootstrapReadinessObservation,
} from '@/app/collab/bootstrap/CloudBootstrapReadiness';

import {
  bootstrapManifest,
  HOST_MEMBER_ID,
  HOST_OID,
  HOST_REF,
  MAIN_OID,
  PROJECT_ID,
} from './fixtures';

function readyObservation(): CloudBootstrapReadinessObservation {
  return {
    collabGitChildCount: 0,
    operations: {
      cleanup: 'settled',
      conflictRecovery: 'settled',
      hostTransfer: 'settled',
      join: 'settled',
      leave: 'settled',
      managerResponsibility: 'settled',
      projectSetup: 'settled',
      publish: 'settled',
      reconciliation: 'settled',
      reconnect: 'settled',
      retirement: 'settled',
    },
    preservedWork: {
      hasLocalOnlyCommits: true,
      hasPrivateDraft: true,
      hasUnpublishedFiles: true,
    },
    projectOperationQueue: { activeCount: 0, queuedCount: 0 },
    projectWorkSession: 'closed',
    repository: {
      mainOid: MAIN_OID,
      memberId: HOST_MEMBER_ID,
      objectFormat: 'sha1',
      personalRef: HOST_REF,
      personalRefOid: HOST_OID,
      projectId: PROJECT_ID,
    },
  };
}

describe('CloudBootstrapReadinessCollector', () => {
  it('propagates cancellation to the concrete readiness inspection seam', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const collector = new CloudBootstrapReadinessCollector({
      inspect: async (_projectId, _memberId, signal) => {
        observedSignal = signal;
        return new Promise<CloudBootstrapReadinessObservation>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('inspection cancelled')), {
            once: true,
          });
        });
      },
    });

    const collecting = collector.collect({
      manifest: bootstrapManifest(),
      memberId: HOST_MEMBER_ID,
    }, controller.signal);
    controller.abort();

    await expect(collecting).rejects.toThrow('inspection cancelled');
    expect(observedSignal).toBe(controller.signal);
  });

  it('permits unpublished files, local-only commits, and private drafts', async () => {
    const collector = new CloudBootstrapReadinessCollector({
      inspect: async () => readyObservation(),
    });

    await expect(collector.collect({
      manifest: bootstrapManifest(),
      memberId: HOST_MEMBER_ID,
    })).resolves.toEqual({
      clientReadiness: {
        cleanupSettled: true,
        collabGitChildrenDrained: true,
        conflictRecoverySettled: true,
        hostTransferSettled: true,
        joinSettled: true,
        leaveSettled: true,
        managerResponsibilitySettled: true,
        projectOperationQueueDrained: true,
        projectSetupSettled: true,
        projectWorkSessionClosed: true,
        publishSettled: true,
        reconciliationSettled: true,
        reconnectSettled: true,
        repositoryIdentityExact: true,
        retirementSettled: true,
      },
      observedPersonalRefOid: HOST_OID,
    });
  });

  it.each([
    'cleanup',
    'conflictRecovery',
    'hostTransfer',
    'join',
    'leave',
    'managerResponsibility',
    'projectSetup',
    'publish',
    'reconciliation',
    'reconnect',
    'retirement',
  ] as const)('rejects an unsettled %s operation', async operation => {
    const observation = readyObservation();
    const collector = new CloudBootstrapReadinessCollector({
      inspect: async () => ({
        ...observation,
        operations: { ...observation.operations, [operation]: 'active' },
      }),
    });

    await expect(collector.collect({
      manifest: bootstrapManifest(),
      memberId: HOST_MEMBER_ID,
    })).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: `cloud-bootstrap-${operation}-not-settled` },
    });
  });

  it.each([
    ['project operation queue', { projectOperationQueue: { activeCount: 1, queuedCount: 0 } }],
    ['Project work session', { projectWorkSession: 'open' }],
    ['Collab Git child', { collabGitChildCount: 1 }],
    ['Project identity', { repository: { ...readyObservation().repository, projectId: 'project-other' } }],
    ['Member identity', { repository: { ...readyObservation().repository, memberId: 'member-other' } }],
    ['personal ref identity', { repository: { ...readyObservation().repository, personalRefOid: '4'.repeat(40) } }],
  ])('rejects a non-ready %s observation', async (_name, override) => {
    const collector = new CloudBootstrapReadinessCollector({
      inspect: async () => ({ ...readyObservation(), ...override } as CloudBootstrapReadinessObservation),
    });

    await expect(collector.collect({
      manifest: bootstrapManifest(),
      memberId: HOST_MEMBER_ID,
    })).rejects.toMatchObject({ code: 'durable-progress-recovery-required' });
  });
});
