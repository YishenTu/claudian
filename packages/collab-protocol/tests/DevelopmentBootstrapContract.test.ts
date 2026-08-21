import {
  COLLAB_MAIN_REF,
  COLLAB_PROTOCOL_VERSION,
  DEVELOPMENT_BOOTSTRAP_ACTIVATION_PHASES,
  DEVELOPMENT_BOOTSTRAP_ATTEMPT_STATES,
  DEVELOPMENT_BOOTSTRAP_CANCELLATION_PHASES,
  DEVELOPMENT_BOOTSTRAP_MANIFEST_SCHEMA_VERSION,
  DEVELOPMENT_BOOTSTRAP_OPERATION_CODECS,
  collabMemberRef,
  decodeDevelopmentBootstrapManifest,
  decodeDevelopmentBootstrapReport,
  developmentBootstrapOperationCodec,
  encodeDevelopmentBootstrapManifestCanonicalJson,
} from '../src/index';

const NOW = '2026-08-21T00:00:00.000Z';
const LATER = '2026-08-22T00:00:00.000Z';
const MAIN = '1'.repeat(40);
const MEMBER_ONE = '2'.repeat(40);
const MEMBER_TWO = '3'.repeat(40);
const SHA256 = 'a'.repeat(64);

function comparisonMember(
  memberId: string,
  role: 'manager' | 'member',
) {
  return {
    activatedAt: NOW,
    createdAt: NOW,
    displayName: memberId === 'member_1' ? 'Alice' : 'Bob',
    memberId,
    personalRef: collabMemberRef(memberId),
    role,
    status: 'active',
  };
}

function comparison(overrides: Record<string, unknown> = {}) {
  return {
    mainOid: MAIN,
    mainRef: COLLAB_MAIN_REF,
    managerSetGeneration: 4,
    members: [
      comparisonMember('member_1', 'manager'),
      comparisonMember('member_2', 'member'),
    ],
    projectCreatedAt: NOW,
    projectId: 'project_1',
    projectName: 'Private project',
    sourceCaFingerprint: 'b'.repeat(64),
    sourceEventSequence: 9,
    sourceHostMemberId: 'member_1',
    ...overrides,
  };
}

function sourceEligibility(overrides: Record<string, unknown> = {}) {
  return {
    liveInvitations: 0,
    nonActiveMemberships: 0,
    nonterminalAcceptOperations: 0,
    nonterminalHostTransfers: 0,
    nonterminalManagerOffers: 0,
    requestComments: 0,
    requests: 0,
    terminalProjectTransitions: 0,
    ticketComments: 0,
    ticketMentions: 0,
    ticketRelations: 0,
    tickets: 0,
    ...overrides,
  };
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: 'attempt_1',
    comparison: comparison(),
    createdAt: NOW,
    git: {
      bundle: { byteCount: 4096, sha256: SHA256 },
      objectFormat: 'sha1',
      refs: [
        { name: COLLAB_MAIN_REF, oid: MAIN },
        { name: collabMemberRef('member_1'), oid: MEMBER_ONE },
        { name: collabMemberRef('member_2'), oid: MEMBER_TWO },
      ],
    },
    manifestSchemaVersion: 1,
    protocolVersion: 4,
    sourceEligibility: sourceEligibility(),
    ...overrides,
  };
}

function readiness(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

function report(
  reporterMemberId: 'member_1' | 'member_2',
  overrides: Record<string, unknown> = {},
) {
  return {
    attemptId: 'attempt_1',
    capturedAt: NOW,
    clientReadiness: readiness(),
    comparison: comparison(),
    observedPersonalRefOid: reporterMemberId === 'member_1' ? MEMBER_ONE : MEMBER_TWO,
    reporterMemberId,
    ...(reporterMemberId === 'member_1'
      ? {
        hostStopAttestation: {
          attemptId: 'attempt_1',
          autoStartDisabled: true,
          fenceDurable: true,
          fenceId: 'fence_1',
          hostStopped: true,
          manifestSha256: SHA256,
          projectId: 'project_1',
          resourcesDrained: true,
          routeUnregistered: true,
          stoppedAt: NOW,
        },
      }
      : {}),
    ...overrides,
  };
}

function attemptStatus(overrides: Record<string, unknown> = {}) {
  return {
    attemptId: 'attempt_1',
    bundleState: 'missing',
    createdAt: NOW,
    expiresAt: LATER,
    manifestSha256: SHA256,
    projectId: 'project_1',
    reporterMemberIds: [],
    state: 'collecting',
    ...overrides,
  };
}

describe('private-development bootstrap contract', () => {
  it('freezes the exact states and durable phases', () => {
    expect(DEVELOPMENT_BOOTSTRAP_MANIFEST_SCHEMA_VERSION).toBe(1);
    expect(DEVELOPMENT_BOOTSTRAP_ATTEMPT_STATES).toEqual([
      'collecting',
      'validating',
      'ready',
      'activating',
      'rejected',
      'cancelled',
      'recovery-required',
      'activated',
    ]);
    expect(DEVELOPMENT_BOOTSTRAP_ACTIVATION_PHASES).toEqual([
      'publish-intent',
      'repository-published',
      'activated',
      'completed',
    ]);
    expect(DEVELOPMENT_BOOTSTRAP_CANCELLATION_PHASES).toEqual([
      'cancel-intent',
      'cancelled',
      'recovery-required',
    ]);
  });

  it('decodes and canonically re-encodes an exact logical manifest', () => {
    const decoded = decodeDevelopmentBootstrapManifest(manifest());
    expect(decoded.protocolVersion).toBe(COLLAB_PROTOCOL_VERSION);
    expect(decoded.git.refs.map(ref => ref.name)).toEqual([
      COLLAB_MAIN_REF,
      collabMemberRef('member_1'),
      collabMemberRef('member_2'),
    ]);
    expect(encodeDevelopmentBootstrapManifestCanonicalJson(decoded))
      .toBe(JSON.stringify(manifest()));
  });

  it.each([
    manifest({ futureField: true }),
    manifest({ manifestSchemaVersion: 2 }),
    manifest({ protocolVersion: 3 }),
    manifest({ comparison: comparison({ members: [
      comparisonMember('member_2', 'member'),
      comparisonMember('member_1', 'manager'),
    ] }) }),
    manifest({ comparison: comparison({ members: [
      comparisonMember('member_1', 'member'),
      comparisonMember('member_2', 'member'),
    ] }) }),
    manifest({ sourceEligibility: sourceEligibility({ requests: 1 }) }),
    manifest({ git: {
      bundle: { byteCount: 4096, sha256: SHA256 },
      objectFormat: 'sha1',
      refs: [{ name: COLLAB_MAIN_REF, oid: MAIN }],
    } }),
  ])('rejects an ineligible or non-canonical manifest %#', (input) => {
    expect(() => decodeDevelopmentBootstrapManifest(input))
      .toThrow('collab.error.protocol-payload-invalid');
  });

  it('decodes the two actor-bound reports and exact Host stop proof', () => {
    expect(decodeDevelopmentBootstrapReport(report('member_1')))
      .toEqual(report('member_1'));
    expect(decodeDevelopmentBootstrapReport(report('member_2')))
      .toEqual(report('member_2'));
  });

  it.each([
    report('member_1', { hostStopAttestation: undefined }),
    report('member_2', { hostStopAttestation: {
      attemptId: 'attempt_1',
      autoStartDisabled: true,
      fenceDurable: true,
      fenceId: 'fence_1',
      hostStopped: true,
      manifestSha256: SHA256,
      projectId: 'project_1',
      resourcesDrained: true,
      routeUnregistered: true,
      stoppedAt: NOW,
    } }),
    report('member_1', { clientReadiness: readiness({ publishSettled: false }) }),
    report('member_1', { futureField: true }),
  ])('rejects a report that weakens readiness or stop evidence %#', (input) => {
    expect(() => decodeDevelopmentBootstrapReport(input))
      .toThrow('collab.error.protocol-payload-invalid');
  });

  it('provides one strict codec map for all six bootstrap bindings', () => {
    expect(Object.keys(DEVELOPMENT_BOOTSTRAP_OPERATION_CODECS)).toEqual([
      'beginDevelopmentBootstrap',
      'submitDevelopmentBootstrapReport',
      'getDevelopmentBootstrap',
      'activateDevelopmentBootstrap',
      'cancelDevelopmentBootstrap',
      'putDevelopmentBootstrapGitBundle',
    ]);

    const requests = {
      activateDevelopmentBootstrap: { attemptId: 'attempt_1', manifestSha256: SHA256 },
      beginDevelopmentBootstrap: { manifest: manifest() },
      cancelDevelopmentBootstrap: { attemptId: 'attempt_1' },
      getDevelopmentBootstrap: { attemptId: 'attempt_1' },
      putDevelopmentBootstrapGitBundle: {
        attemptId: 'attempt_1',
        byteCount: 4096,
        contentEncoding: 'identity',
        contentType: 'application/x-git-bundle',
        sha256: SHA256,
      },
      submitDevelopmentBootstrapReport: {
        attemptId: 'attempt_1',
        report: report('member_1'),
      },
    } as const;

    for (const [operation, request] of Object.entries(requests)) {
      const codec = developmentBootstrapOperationCodec(
        operation as keyof typeof requests,
      );
      expect(codec.decodeRequest(request)).toEqual({ status: 'ok', value: request });
      expect(codec.decodeResponse(attemptStatus())).toEqual(attemptStatus());
      expect(codec.decodeRequest({ ...request, futureField: true }).status).toBe('invalid');
    }
  });

  it.each(['activated', 'completed'] as const)(
    'decodes a stable result at the %s phase without exposing placement paths or keys',
    (activationPhase) => {
      const activated = attemptStatus({
        activationPhase,
        activationResult: {
          activatedAt: NOW,
          activationOperationId: 'operation_1',
          placementGeneration: 1,
          projectId: 'project_1',
        },
        bundleState: 'validated',
        reporterMemberIds: ['member_1', 'member_2'],
        state: 'activated',
      });
      const decoded = developmentBootstrapOperationCodec('getDevelopmentBootstrap')
        .decodeResponse(activated);
      expect(decoded).toEqual(activated);
      expect(JSON.stringify(decoded)).not.toMatch(/storageKey|filesystem|path/i);
    },
  );

  it('rejects an activation result for a different Project', () => {
    expect(() => developmentBootstrapOperationCodec('getDevelopmentBootstrap')
      .decodeResponse(attemptStatus({
        activationPhase: 'completed',
        activationResult: {
          activatedAt: NOW,
          activationOperationId: 'operation_1',
          placementGeneration: 1,
          projectId: 'project_2',
        },
        bundleState: 'validated',
        reporterMemberIds: ['member_1', 'member_2'],
        state: 'activated',
      }))).toThrow('collab.error.protocol-payload-invalid');
  });
});
