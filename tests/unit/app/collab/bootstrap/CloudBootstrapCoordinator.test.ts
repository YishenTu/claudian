import {
  type DevelopmentBootstrapAttemptStatus,
} from '@claudian-collab/protocol';

import {
  CloudBootstrapCoordinator,
  type CloudBootstrapCoordinatorOptions,
} from '@/app/collab/bootstrap/CloudBootstrapCoordinator';
import {
  CloudBootstrapReadinessCollector,
  type CloudBootstrapReadinessObservation,
} from '@/app/collab/bootstrap/CloudBootstrapReadiness';
import type {
  CloudBootstrapTransitionRecord,
  CloudBootstrapTransitionStorePort,
} from '@/app/collab/bootstrap/CloudBootstrapTransitionRecord';

import {
  ATTEMPT_ID,
  bootstrapManifest,
  finalizeActivatedBindingForTest,
  HOST_MEMBER_ID,
  HOST_OID,
  HOST_REF,
  MAIN_OID,
  MANIFEST_SHA256,
  OTHER_MEMBER_ID,
  OTHER_OID,
  OTHER_REF,
  PROJECT_ID,
} from './fixtures';

const ACTIVATION_RESULT = {
  activatedAt: '2026-08-21T00:00:04.000Z',
  activationOperationId: 'activation-one',
  placementGeneration: 1,
  projectId: PROJECT_ID,
} as const;

function status(
  state: DevelopmentBootstrapAttemptStatus['state'],
  overrides: Partial<DevelopmentBootstrapAttemptStatus> = {},
): DevelopmentBootstrapAttemptStatus {
  return {
    attemptId: ATTEMPT_ID,
    bundleState: 'missing',
    createdAt: '2026-08-21T00:00:00.000Z',
    expiresAt: '2026-08-22T00:00:00.000Z',
    manifestSha256: MANIFEST_SHA256,
    projectId: PROJECT_ID,
    reporterMemberIds: [],
    state,
    ...overrides,
  };
}

function readyObservation(
  memberId = HOST_MEMBER_ID,
): CloudBootstrapReadinessObservation {
  const isHost = memberId === HOST_MEMBER_ID;
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
      memberId,
      objectFormat: 'sha1',
      personalRef: isHost ? HOST_REF : OTHER_REF,
      personalRefOid: isHost ? HOST_OID : OTHER_OID,
      projectId: PROJECT_ID,
    },
  };
}

class MemoryTransitionStore implements CloudBootstrapTransitionStorePort {
  record: CloudBootstrapTransitionRecord | null = null;

  async create(record: CloudBootstrapTransitionRecord): Promise<CloudBootstrapTransitionRecord> {
    this.record ??= record;
    return this.record;
  }

  async load(_projectId: string): Promise<CloudBootstrapTransitionRecord | null> {
    return this.record;
  }

  async save(record: CloudBootstrapTransitionRecord): Promise<void> {
    this.record = record;
  }
}

function coordinatorFixture(options: {
  readonly memberId?: string;
  readonly store?: MemoryTransitionStore;
  readonly statusResult?: DevelopmentBootstrapAttemptStatus | null;
} = {}) {
  const memberId = options.memberId ?? HOST_MEMBER_ID;
  const events: string[] = [];
  const store = options.store ?? new MemoryTransitionStore();
  const begin = jest.fn(async () => {
    events.push('cloud.begin');
    return status('collecting');
  });
  const report = jest.fn(async () => {
    events.push('cloud.report');
    return status('validating', {
      reporterMemberIds: [memberId],
    });
  });
  const upload = jest.fn(async (
    _request,
    body: (signal: AbortSignal) => AsyncIterable<Uint8Array>,
  ) => {
    events.push('cloud.upload');
    for await (const chunk of body(new AbortController().signal)) {
      expect(chunk).toBeInstanceOf(Uint8Array);
    }
    return status('ready', {
      bundleState: 'validated',
      reporterMemberIds: [HOST_MEMBER_ID, OTHER_MEMBER_ID],
    });
  });
  const activate = jest.fn(async () => {
    events.push('cloud.activate');
    return status('activated', {
      activationPhase: 'completed',
      activationResult: ACTIVATION_RESULT,
      bundleState: 'validated',
      reporterMemberIds: [HOST_MEMBER_ID, OTHER_MEMBER_ID],
    });
  });
  const get = jest.fn(async () => options.statusResult ?? null);
  const cancel = jest.fn(async () => status('cancelled', {
    bundleState: 'validated',
    cancellationPhase: 'cancelled',
    reporterMemberIds: [HOST_MEMBER_ID],
  }));
  const assertManifestCurrent = jest.fn(async () => {
    events.push('source.assert-current');
  });
  const discardBundle = jest.fn(async () => {
    events.push('source.discard');
  });
  const captureManifest = jest.fn(async () => {
    events.push('source.capture');
    return bootstrapManifest();
  });
  const completeAfterActivation = jest.fn(async () => undefined);
  const coordinatorOptions: CloudBootstrapCoordinatorOptions = {
    binding: {
      finalize: async record => {
        events.push('binding.finalize');
        const completed = finalizeActivatedBindingForTest(record);
        await store.save(completed);
        return completed;
      },
    },
    cloud: { activate, begin, cancel, get, report, upload },
    createFenceId: () => 'bootstrap-fence-one',
    formerHost: {
      stopAndDrain: jest.fn(async () => {
        events.push('host.stop');
        return {
          autoStartDisabled: true as const,
          resourcesDrained: true as const,
          routeUnregistered: true as const,
          stoppedAt: '2026-08-21T00:00:02.000Z',
        };
      }),
    },
    localIdentity: {
      load: jest.fn(async () => ({
        authorityKind: 'lan' as const,
        caFingerprint: 'b'.repeat(64),
        endpoint: 'https://192.168.1.20:54545',
        gitRemoteUrl: `https://192.168.1.20:54545/v1/git/${PROJECT_ID}/repository.git`,
        memberId,
        ownsAuthority: memberId === HOST_MEMBER_ID,
        projectId: PROJECT_ID,
      })),
    },
    now: (() => {
      let second = 1;
      return () => new Date(Date.parse('2026-08-21T00:00:00.000Z') + second++ * 1_000);
    })(),
    readiness: new CloudBootstrapReadinessCollector({
      inspect: async () => {
        events.push('readiness.collect');
        return readyObservation(memberId);
      },
    }),
    source: {
      assertManifestCurrent,
      captureManifest,
      discardBundle,
      openBundle: jest.fn(async function* () {
        yield new Uint8Array([1, 2, 3]);
      }),
    } as CloudBootstrapCoordinatorOptions['source'],
    transitions: {
      create: async record => {
        events.push('transition.create');
        return store.create(record);
      },
      load: projectId => store.load(projectId),
      save: async record => {
        events.push(`transition.save.${record.fence.state}.${record.attemptState}`);
        await store.save(record);
      },
    },
    workSessions: {
      closeAndDrain: jest.fn(async () => {
        events.push('session.close');
      }),
      completeAfterActivation,
      resumeAfterCancellation: jest.fn(async () => {
        events.push('session.resume');
      }),
    },
  };
  return {
    activate,
    assertManifestCurrent,
    begin,
    cancel,
    captureManifest,
    completeAfterActivation,
    coordinator: new CloudBootstrapCoordinator(coordinatorOptions),
    discardBundle,
    events,
    get,
    report,
    store,
    upload,
  };
}

describe('CloudBootstrapCoordinator', () => {
  it('rejects a development actor that is not the local Member', async () => {
    const fixture = coordinatorFixture();

    await expect(fixture.coordinator.startFormerHost({
      developmentActorId: OTHER_MEMBER_ID,
      memberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    })).rejects.toMatchObject({
      safeContext: { reason: 'cloud-bootstrap-development-actor-member-mismatch' },
    });

    expect(fixture.events).toEqual([]);
  });

  it('durably fences, drains, and stops the former Host before Cloud bootstrap', async () => {
    const fixture = coordinatorFixture();
    const controller = new AbortController();

    const result = await fixture.coordinator.startFormerHost({
      developmentActorId: HOST_MEMBER_ID,
      memberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    }, controller.signal);

    expect(fixture.events).toEqual([
      'source.capture',
      'transition.create',
      'session.close',
      'host.stop',
      'transition.save.host-stopped.pending',
      'source.assert-current',
      'readiness.collect',
      'cloud.begin',
      'cloud.report',
      'cloud.upload',
      'cloud.activate',
      'transition.save.host-stopped.activated',
      'source.discard',
      'binding.finalize',
      'transition.save.terminal.activated',
    ]);
    expect(fixture.captureManifest).toHaveBeenCalledWith(
      PROJECT_ID,
      controller.signal,
    );
    expect(fixture.assertManifestCurrent).toHaveBeenCalledWith(
      bootstrapManifest(),
      controller.signal,
    );
    expect(fixture.report).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      report: expect.objectContaining({
        hostStopAttestation: {
          attemptId: ATTEMPT_ID,
          autoStartDisabled: true,
          fenceDurable: true,
          fenceId: 'bootstrap-fence-one',
          hostStopped: true,
          manifestSha256: MANIFEST_SHA256,
          projectId: PROJECT_ID,
          resourcesDrained: true,
          routeUnregistered: true,
          stoppedAt: '2026-08-21T00:00:02.000Z',
        },
      }),
    }, controller.signal);
    expect(result).toMatchObject({
      activationResult: ACTIVATION_RESULT,
      attemptState: 'activated',
      phase: 'fence-terminal',
      terminalCleanupCompleted: true,
    });
    expect(result.newAuthority.gitRemoteUrl).toBe(
      `https://cloud.example.test/v2/projects/${PROJECT_ID}/repository.git`,
    );
  });

  it('lets the other client submit only its actor-bound report', async () => {
    const fixture = coordinatorFixture({ memberId: OTHER_MEMBER_ID });

    const result = await fixture.coordinator.submitParticipant({
      developmentActorId: OTHER_MEMBER_ID,
      manifest: bootstrapManifest(),
      memberId: OTHER_MEMBER_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    });

    expect(fixture.events).toEqual([
      'transition.create',
      'session.close',
      'readiness.collect',
      'cloud.report',
    ]);
    expect(fixture.report).toHaveBeenCalledWith({
      attemptId: ATTEMPT_ID,
      report: expect.not.objectContaining({ hostStopAttestation: expect.anything() }),
    }, undefined);
    expect(result.fence).toEqual({
      fenceId: null,
      state: 'not-applicable',
      stoppedAt: null,
    });
    expect(fixture.begin).not.toHaveBeenCalled();
    expect(fixture.upload).not.toHaveBeenCalled();
    expect(fixture.activate).not.toHaveBeenCalled();
  });

  it('recovers a lost activation response by completing binding without restarting LAN', async () => {
    const fixture = coordinatorFixture();
    await fixture.coordinator.startFormerHost({
      developmentActorId: HOST_MEMBER_ID,
      memberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    });
    fixture.store.record = {
      ...fixture.store.record!,
      activationResult: null,
      attemptState: 'pending',
      fence: {
        fenceId: 'bootstrap-fence-one',
        state: 'host-stopped',
        stoppedAt: '2026-08-21T00:00:02.000Z',
      },
      phase: 'intent',
      terminalCleanupCompleted: false,
    };
    fixture.get.mockResolvedValue(status('activated', {
      activationPhase: 'completed',
      activationResult: ACTIVATION_RESULT,
      bundleState: 'validated',
      reporterMemberIds: [HOST_MEMBER_ID, OTHER_MEMBER_ID],
    }));
    fixture.events.length = 0;

    const recovered = await fixture.coordinator.recoverProject(PROJECT_ID);

    expect(fixture.events).toEqual([
      'session.close',
      'source.assert-current',
      'readiness.collect',
      'transition.save.host-stopped.activated',
      'source.discard',
      'binding.finalize',
      'transition.save.terminal.activated',
    ]);
    expect(recovered).toMatchObject({
      activationResult: ACTIVATION_RESULT,
      attemptState: 'activated',
      phase: 'fence-terminal',
    });
  });

  it('marks a pre-activation cancellation as fence-released without auto-restart', async () => {
    const fixture = coordinatorFixture();
    await fixture.coordinator.startFormerHost({
      developmentActorId: HOST_MEMBER_ID,
      memberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    });
    fixture.store.record = {
      ...fixture.store.record!,
      activationResult: null,
      attemptState: 'pending',
      fence: {
        fenceId: 'bootstrap-fence-one',
        state: 'host-stopped',
        stoppedAt: '2026-08-21T00:00:02.000Z',
      },
      phase: 'intent',
      terminalCleanupCompleted: false,
    };
    fixture.events.length = 0;

    const cancelled = await fixture.coordinator.cancel(PROJECT_ID);

    expect(cancelled).toMatchObject({
      attemptState: 'cancelled',
      fence: { state: 'released-before-activation' },
      phase: 'intent',
      terminalCleanupCompleted: true,
    });
    expect(fixture.events).toEqual([
      'transition.save.released-before-activation.cancelled',
      'source.discard',
      'session.resume',
      'transition.save.released-before-activation.cancelled',
    ]);
    expect(fixture.cancel).toHaveBeenCalledWith({ attemptId: ATTEMPT_ID }, undefined);
  });

  it('discards a captured Host bundle when transition creation fails', async () => {
    const fixture = coordinatorFixture();
    fixture.store.create = async () => {
      throw new Error('transition-create-failed');
    };

    await expect(fixture.coordinator.startFormerHost({
      developmentActorId: HOST_MEMBER_ID,
      memberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    })).rejects.toThrow('transition-create-failed');
    expect(fixture.events).toEqual([
      'source.capture',
      'transition.create',
      'source.discard',
    ]);
  });

  it('does not disturb an already completed Cloud binding during recovery', async () => {
    const fixture = coordinatorFixture();
    await fixture.coordinator.startFormerHost({
      developmentActorId: HOST_MEMBER_ID,
      memberId: HOST_MEMBER_ID,
      projectId: PROJECT_ID,
      serverUrl: 'https://cloud.example.test',
    });
    fixture.completeAfterActivation.mockClear();
    fixture.discardBundle.mockClear();

    await expect(fixture.coordinator.recoverProject(PROJECT_ID)).resolves.toMatchObject({
      attemptState: 'activated',
      terminalCleanupCompleted: true,
    });
    expect(fixture.discardBundle).not.toHaveBeenCalled();
    expect(fixture.completeAfterActivation).not.toHaveBeenCalled();
  });
});
