import {
  CloudBootstrapBindingFinalizer,
} from '@/app/collab/bootstrap/CloudBootstrapBindingFinalizer';
import {
  CLOUD_BOOTSTRAP_TRANSITION_PHASES,
  type CloudBootstrapTransitionRecord,
  createCloudBootstrapTransitionRecord,
  markCloudBootstrapHostStopped,
  observeCloudBootstrapAttemptStatus,
} from '@/app/collab/bootstrap/CloudBootstrapTransitionRecord';

import {
  ATTEMPT_ID,
  bootstrapManifest,
  HOST_MEMBER_ID,
  MANIFEST_SHA256,
  PROJECT_ID,
} from './fixtures';

function activatedRecord(): CloudBootstrapTransitionRecord {
  const pending = createCloudBootstrapTransitionRecord({
    developmentActorId: HOST_MEMBER_ID,
    fenceId: 'bootstrap-fence-one',
    manifest: bootstrapManifest(),
    manifestSha256: MANIFEST_SHA256,
    memberId: HOST_MEMBER_ID,
    oldEndpoint: 'https://192.168.1.20:54545',
    oldGitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
    serverUrl: 'https://cloud.example.test',
    timestamp: '2026-08-21T00:00:01.000Z',
  });
  return observeCloudBootstrapAttemptStatus(
    markCloudBootstrapHostStopped(
      pending,
      '2026-08-21T00:00:02.000Z',
      '2026-08-21T00:00:02.000Z',
    ),
    {
      activationPhase: 'completed',
      activationResult: {
        activatedAt: '2026-08-21T00:00:03.000Z',
        activationOperationId: 'activation-one',
        placementGeneration: 1,
        projectId: PROJECT_ID,
      },
      attemptId: ATTEMPT_ID,
      bundleState: 'validated',
      createdAt: '2026-08-21T00:00:00.000Z',
      expiresAt: '2026-08-22T00:00:00.000Z',
      manifestSha256: MANIFEST_SHA256,
      projectId: PROJECT_ID,
      reporterMemberIds: [HOST_MEMBER_ID],
      state: 'activated',
    },
    '2026-08-21T00:00:03.000Z',
  );
}

describe('CloudBootstrapBindingFinalizer', () => {
  it('revalidates a persisted terminal fence before allowing admission to resume', async () => {
    let stored = activatedRecord();
    const effects = {
      confirmReadiness: jest.fn(async () => undefined),
      repairIndex: jest.fn(async () => undefined),
      replaceMembership: jest.fn(async () => undefined),
      retireLanAuthority: jest.fn(async () => undefined),
      rotateOrigin: jest.fn(async () => undefined),
      verifyActivation: jest.fn(async () => undefined),
      verifyCloud: jest.fn(async () => undefined),
    };
    const finalizer = new CloudBootstrapBindingFinalizer({
      effects,
      now: () => new Date('2026-08-21T00:01:00.000Z'),
      transitions: {
        create: async record => record,
        load: async () => stored,
        save: async record => { stored = record; },
      },
    });
    stored = await finalizer.finalize(stored);
    for (const effect of Object.values(effects)) effect.mockClear();

    await finalizer.finalize(stored);

    expect(effects.verifyCloud).toHaveBeenCalledTimes(1);
    expect(effects.replaceMembership).toHaveBeenCalledTimes(1);
    expect(effects.repairIndex).toHaveBeenCalledTimes(1);
    expect(effects.retireLanAuthority).toHaveBeenCalledTimes(1);
    expect(effects.verifyActivation).toHaveBeenCalledTimes(1);
    expect(effects.confirmReadiness).not.toHaveBeenCalled();
    expect(effects.rotateOrigin).not.toHaveBeenCalled();
  });

  it.each(CLOUD_BOOTSTRAP_TRANSITION_PHASES.slice(1).map((phase, index) => [phase, index]))(
    'recovers after a crash persisting %s and revalidates before irreversible phases',
    async (_phase, failureIndex) => {
      let stored = activatedRecord();
      let saveIndex = 0;
      const effects = {
        confirmReadiness: jest.fn(async () => undefined),
        repairIndex: jest.fn(async () => undefined),
        replaceMembership: jest.fn(async () => undefined),
        retireLanAuthority: jest.fn(async () => undefined),
      rotateOrigin: jest.fn(async () => undefined),
      verifyActivation: jest.fn(async () => undefined),
      verifyCloud: jest.fn(async () => undefined),
      };
      const finalizer = () => new CloudBootstrapBindingFinalizer({
        effects,
        now: () => new Date('2026-08-21T00:01:00.000Z'),
        transitions: {
          create: async record => record,
          load: async () => stored,
          save: async record => {
            stored = record;
            if (saveIndex === failureIndex) {
              saveIndex += 1;
              throw new Error('simulated restart');
            }
            saveIndex += 1;
          },
        },
      });

      await expect(finalizer().finalize(stored)).rejects.toThrow('simulated restart');
      const recovered = await finalizer().finalize(stored);

      expect(recovered).toMatchObject({
        fence: { state: 'terminal' },
        phase: 'fence-terminal',
      });
      expect(effects.confirmReadiness).toHaveBeenCalledTimes(1);
      expect(effects.rotateOrigin).toHaveBeenCalledTimes(1);
      const terminalReplay = _phase === 'fence-terminal' ? 1 : 0;
      expect(effects.verifyActivation).toHaveBeenCalledTimes(7 + terminalReplay);
      expect(effects.verifyCloud).toHaveBeenCalledTimes(3 + terminalReplay);
      expect(effects.replaceMembership).toHaveBeenCalledTimes(3 + terminalReplay);
      expect(effects.repairIndex).toHaveBeenCalledTimes(3 + terminalReplay);
      expect(effects.retireLanAuthority).toHaveBeenCalledTimes(2 + terminalReplay);
    },
  );
});
