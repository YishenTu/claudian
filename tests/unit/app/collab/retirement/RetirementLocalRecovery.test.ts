import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import type { LocalCleanupRecord } from '@/app/collab/exit/LocalCleanupRecord';
import { RetirementLocalRecovery } from '@/app/collab/retirement/RetirementLocalRecovery';
import type { RetirementRecord } from '@/app/collab/retirement/RetirementRecord';

const RETIREMENT = {
  acknowledgedAt: null,
  acknowledgementStatus: 'pending',
  cleanupOperationId: 'cleanup-one',
  cleanupStatus: 'pending',
  cloudDevelopmentActorId: null,
  cloudRetirementId: null,
  cloudServerUrl: null,
  createdAt: '2026-08-13T00:00:00.000Z',
  hostCaCertificatePem: 'certificate',
  hostCaFingerprint: 'a'.repeat(64),
  hostEndpoint: 'https://192.168.1.10:54545',
  kind: 'retirement',
  memberCredential: 'c'.repeat(43),
  memberId: 'member-one',
  projectId: 'project-one',
  retiredAt: '2026-08-13T00:00:00.000Z',
  schemaVersion: 1,
  updatedAt: '2026-08-13T00:00:00.000Z',
} as const satisfies RetirementRecord;

const CLEANUP = {
  choice: 'keep-files',
  createdAt: RETIREMENT.createdAt,
  kind: 'local-cleanup',
  markerNonce: 'm'.repeat(43),
  memberId: RETIREMENT.memberId,
  operationId: RETIREMENT.cleanupOperationId,
  phase: 'choice-applied',
  projectId: RETIREMENT.projectId,
  purpose: 'retire',
  schemaVersion: 1,
  updatedAt: RETIREMENT.updatedAt,
  workspacePath: 'workspace/project-one',
} as const satisfies LocalCleanupRecord;

async function admitProjectRecovery(
  _projectId: string,
  operation: () => Promise<void>,
): Promise<void> {
  await operation();
}

describe('RetirementLocalRecovery', () => {
  it('resumes a durable retirement record even when the index still says Active', async () => {
    const handler = { resume: jest.fn(async () => undefined) };
    const projectRecoveryAdmission = jest.fn(async (
      _projectId: string,
      operation: () => Promise<void>,
    ) => operation());
    const recovery = new RetirementLocalRecovery({
      loadIndex: jest.fn(async () => ({
        projects: [{
          authorityKind: 'lan' as const,
          createdAt: RETIREMENT.createdAt,
          id: RETIREMENT.projectId,
          lifecycle: 'active' as const,
          name: 'Project One',
          updatedAt: RETIREMENT.updatedAt,
          workspacePath: 'workspace/project-one',
        }],
        schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
        selectedProjectId: RETIREMENT.projectId,
      })),
      loadRetirementRecord: jest.fn(async () => RETIREMENT),
      listRetirementAcknowledgementProjectIds: jest.fn(async () => []),
    }, {
      load: jest.fn(async () => null),
    }, {
      listProjectIds: jest.fn(async () => []),
      load: jest.fn(async () => null),
    }, handler, { finalize: jest.fn(async () => undefined) }, projectRecoveryAdmission);

    await recovery.resume();

    expect(handler.resume).toHaveBeenCalledWith(RETIREMENT.projectId);
    expect(projectRecoveryAdmission).toHaveBeenCalledWith(
      RETIREMENT.projectId,
      expect.any(Function),
    );
  });

  it('removes an applied cleanup journal after its projection is already gone', async () => {
    const finalize = jest.fn(async () => undefined);
    const recovery = new RetirementLocalRecovery({
      loadIndex: jest.fn(async () => ({
        projects: [],
        schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
        selectedProjectId: null,
      })),
      loadRetirementRecord: jest.fn(async () => null),
      listRetirementAcknowledgementProjectIds: jest.fn(async () => []),
    }, {
      load: jest.fn(async () => null),
    }, {
      listProjectIds: jest.fn(async () => ['project-one']),
      load: jest.fn(async () => CLEANUP),
    }, {
      resume: jest.fn(async () => undefined),
    }, { finalize }, admitProjectRecovery);

    await recovery.resume();

    expect(finalize).toHaveBeenCalledWith({
      choice: 'keep-files',
      projectId: 'project-one',
    }, {});
  });

  it('retains an unindexed cleanup journal while a pending Leave can still adopt it', async () => {
    const finalize = jest.fn(async () => undefined);
    const recovery = new RetirementLocalRecovery({
      loadIndex: jest.fn(async () => ({
        projects: [],
        schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
        selectedProjectId: null,
      })),
      loadRetirementRecord: jest.fn(async () => null),
      listRetirementAcknowledgementProjectIds: jest.fn(async () => []),
    }, {
      load: jest.fn(async () => ({ projectId: 'project-one' }) as never),
    }, {
      listProjectIds: jest.fn(async () => ['project-one']),
      load: jest.fn(async () => CLEANUP),
    }, {
      resume: jest.fn(async () => undefined),
    }, { finalize }, admitProjectRecovery);

    await recovery.resume();

    expect(finalize).not.toHaveBeenCalled();
  });

  it('removes an applied journal when only the independent acknowledgement remains', async () => {
    const finalize = jest.fn(async () => undefined);
    const handler = { resume: jest.fn(async () => undefined) };
    const recovery = new RetirementLocalRecovery({
      loadIndex: jest.fn(async () => ({
        projects: [],
        schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
        selectedProjectId: null,
      })),
      loadRetirementRecord: jest.fn(async () => RETIREMENT),
      listRetirementAcknowledgementProjectIds: jest.fn(async () => ['project-one']),
    }, {
      load: jest.fn(async () => null),
    }, {
      listProjectIds: jest.fn(async () => ['project-one']),
      load: jest.fn(async () => CLEANUP),
    }, handler, { finalize }, admitProjectRecovery);

    await recovery.resume();

    expect(handler.resume).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledWith({
      choice: 'keep-files',
      projectId: 'project-one',
    }, {});
  });

  it('finishes an indexed Retired projection that has only the acknowledgement fallback', async () => {
    const finalize = jest.fn(async () => undefined);
    const handler = { resume: jest.fn(async () => undefined) };
    const recovery = new RetirementLocalRecovery({
      loadIndex: jest.fn(async () => ({
        projects: [{
          authorityKind: 'lan' as const,
          cleanupStatus: 'complete' as const,
          createdAt: RETIREMENT.createdAt,
          id: RETIREMENT.projectId,
          lifecycle: 'retired' as const,
          name: 'Project One',
          retiredAt: RETIREMENT.retiredAt,
          updatedAt: RETIREMENT.updatedAt,
          workspacePath: 'workspace/project-one',
        }],
        schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
        selectedProjectId: RETIREMENT.projectId,
      })),
      loadRetirementRecord: jest.fn(async () => RETIREMENT),
      listRetirementAcknowledgementProjectIds: jest.fn(async () => ['project-one']),
    }, {
      load: jest.fn(async () => null),
    }, {
      listProjectIds: jest.fn(async () => ['project-one']),
      load: jest.fn(async () => CLEANUP),
    }, handler, { finalize }, admitProjectRecovery);

    await recovery.resume();

    expect(handler.resume).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledWith({
      choice: 'keep-files',
      projectId: 'project-one',
    }, {});
  });

  it('finishes an indexed Retired projection from the applied cleanup journal alone', async () => {
    const finalize = jest.fn(async () => undefined);
    const handler = { resume: jest.fn(async () => undefined) };
    const recovery = new RetirementLocalRecovery({
      loadIndex: jest.fn(async () => ({
        projects: [{
          authorityKind: 'lan' as const,
          cleanupStatus: 'complete' as const,
          createdAt: RETIREMENT.createdAt,
          id: RETIREMENT.projectId,
          lifecycle: 'retired' as const,
          name: 'Project One',
          retiredAt: RETIREMENT.retiredAt,
          updatedAt: RETIREMENT.updatedAt,
          workspacePath: 'workspace/project-one',
        }],
        schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
        selectedProjectId: RETIREMENT.projectId,
      })),
      loadRetirementRecord: jest.fn(async () => RETIREMENT),
      listRetirementAcknowledgementProjectIds: jest.fn(async () => []),
    }, {
      load: jest.fn(async () => null),
    }, {
      listProjectIds: jest.fn(async () => ['project-one']),
      load: jest.fn(async () => CLEANUP),
    }, handler, { finalize }, admitProjectRecovery);

    await recovery.resume();

    expect(handler.resume).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledWith({
      choice: 'keep-files',
      projectId: 'project-one',
    }, {});
  });
});
