import type { HostTransferAuthorityRecord } from '@/app/collab/authority/HostTransferRepository';
import { createHostTransferPackageManifest } from '@/app/collab/host-transfer/HostTransferPackage';
import type { HostTransferRecoveryRecord } from '@/app/collab/host-transfer/HostTransferRecoveryRecord';
import type {
  HostTransferActivationCertificate,
} from '@/app/collab/host-transfer/HostTrustTransitionService';
import {
  OutgoingHostTransferCoordinator,
} from '@/app/collab/host-transfer/OutgoingHostTransferCoordinator';
import type { CollabHostTrustTransitionProof } from '@/core/collab';

const NOW = '2026-08-08T00:00:00.000Z';
const TARGET_CA = '-----BEGIN CERTIFICATE-----\nTARGET\n-----END CERTIFICATE-----\n';
const TARGET_FINGERPRINT = 'b'.repeat(64);
const MANIFEST_DIGEST = 'c'.repeat(64);

describe('OutgoingHostTransferCoordinator', () => {
  let authorityRecord: HostTransferAuthorityRecord;
  let recoveryRecord: HostTransferRecoveryRecord | null;
  let events: string[];
  let authority: { advance: jest.Mock; getTransfer: jest.Mock; relinquish: jest.Mock };
  let admission: Record<string, jest.Mock>;
  let target: Record<string, jest.Mock>;
  let projections: Record<string, jest.Mock>;
  let packages: { prepare: jest.Mock; restore: jest.Mock };
  let recovery: { load: jest.Mock; remove: jest.Mock; save: jest.Mock };

  const proof: CollabHostTrustTransitionProof = {
    issuedAt: NOW,
    nextCaCertificatePem: TARGET_CA,
    nextCaFingerprint: TARGET_FINGERPRINT,
    previousCaFingerprint: 'a'.repeat(64),
    projectId: 'project-alpha',
    schemaVersion: 1,
    signature: 'A'.repeat(342),
    signatureAlgorithm: 'rsa-pss-sha256',
    transferId: 'transfer-one',
  };
  const activation: HostTransferActivationCertificate = {
    cutoverAt: NOW,
    manifestDigest: MANIFEST_DIGEST,
    projectId: 'project-alpha',
    schemaVersion: 1,
    signature: 'B'.repeat(342),
    signatureAlgorithm: 'rsa-pss-sha256',
    targetCaFingerprint: TARGET_FINGERPRINT,
    targetHostMemberId: 'member-target',
    transferId: 'transfer-one',
  };

  beforeEach(() => {
    authorityRecord = {
      activationCertificate: null,
      expiresAt: '2026-08-09T00:00:00.000Z',
      manifestDigest: null,
      offeredAt: NOW,
      phase: 'accepted',
      receiverCredential: Buffer.alloc(32, 4).toString('base64url'),
      sourceHostMemberId: 'member-host',
      targetCaCertificatePem: TARGET_CA,
      targetCaFingerprint: TARGET_FINGERPRINT,
      targetEndpoint: 'https://192.168.1.9:54545',
      targetHostMemberId: 'member-target',
      transferId: 'transfer-one',
      updatedAt: NOW,
    };
    recoveryRecord = null;
    events = [];
    authority = {
      advance: jest.fn(async input => {
        events.push(`authority-${input.nextPhase}`);
        authorityRecord = {
          ...authorityRecord,
          manifestDigest: input.manifestDigest ?? authorityRecord.manifestDigest,
          phase: input.nextPhase,
        };
        return authorityRecord;
      }),
      getTransfer: jest.fn(async () => authorityRecord),
      relinquish: jest.fn(async input => {
        events.push('authority-relinquished');
        authorityRecord = {
          ...authorityRecord,
          activationCertificate: input.activationCertificate,
          phase: 'authority-relinquished',
        };
        return authorityRecord;
      }),
    };
    admission = {
      assertAcceptanceSettled: jest.fn(async () => events.push('accept-settled')),
      closeActiveAuthority: jest.fn(async () => events.push('old-route-closed')),
      finalizeOldAuthority: jest.fn(async () => events.push('old-authority-finalized')),
      quiesceAndDrain: jest.fn(async () => events.push('quiesced')),
      reopenBeforeRelinquishment: jest.fn(async () => events.push('reopened')),
    };
    const manifest = createHostTransferPackageManifest({
      authorityMainOid: 'a'.repeat(40),
      authoritySnapshot: { byteCount: 1, sha256: '1'.repeat(64) },
      createdAt: NOW,
      gitBundle: { byteCount: 1, sha256: '2'.repeat(64) },
      gitObjectFormat: 'sha1',
      projectId: 'project-alpha',
      proofChainDigest: '3'.repeat(64),
      sourceAuthorityGeneration: 5,
      targetCaFingerprint: TARGET_FINGERPRINT,
      targetHostMemberId: 'member-target',
      transferId: 'transfer-one',
    });
    async function* bytes() { yield Uint8Array.of(1); }
    const prepared = {
      authoritySnapshot: bytes(),
      gitBundle: bytes(),
      manifest,
      manifestDigest: MANIFEST_DIGEST,
      proof,
    };
    packages = {
      prepare: jest.fn(async () => prepared),
      restore: jest.fn(async () => ({ ...prepared, authoritySnapshot: bytes(), gitBundle: bytes() })),
    };
    target = {
      activate: jest.fn(async () => events.push('target-activated')),
      cancel: jest.fn(async () => events.push('target-cancelled')),
      confirmTerminal: jest.fn(async () => events.push('target-confirmed')),
      markCompleted: jest.fn(async () => events.push('target-completed')),
      probe: jest.fn(async () => events.push('target-probed')),
      stage: jest.fn(async () => {
        events.push('target-staged');
        return { manifestDigest: MANIFEST_DIGEST };
      }),
      verifyActive: jest.fn(async () => events.push('target-verified')),
    };
    projections = {
      demoteSourceHost: jest.fn(async () => events.push('source-demoted')),
      promoteTargetHost: jest.fn(),
      readPinnedSourceCa: jest.fn(),
    };
    recovery = {
      load: jest.fn(async () => recoveryRecord),
      remove: jest.fn(),
      save: jest.fn(async value => {
        recoveryRecord = value;
        events.push(`save-${value.phase}`);
      }),
    };
  });

  function coordinator() {
    return new OutgoingHostTransferCoordinator(
      authority,
      admission as never,
      packages,
      target as never,
      {
        hostCaSigner: jest.fn(async () => ({
          caCertificatePem: 'SOURCE CA',
          caFingerprint: 'a'.repeat(64),
          signRsaPssSha256: jest.fn(),
        })),
        memberCredential: jest.fn(async () => Buffer.alloc(32, 7).toString('base64url')),
      },
      projections as never,
      recovery,
      {
        installationKey: 'device-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        now: () => new Date(NOW),
        syncProjection: projectId => events.push(`projection-${projectId}`),
        trust: {
          signActivation: jest.fn(async () => activation),
          signTransition: jest.fn(async () => proof),
        } as never,
      },
    );
  }

  it('quiesces, stages, cuts over once, verifies target, then demotes the source', async () => {
    await coordinator().run('project-alpha', 'transfer-one');

    expect(recoveryRecord?.phase).toBe('completed');
    expect(events.indexOf('quiesced')).toBeLessThan(events.indexOf('target-staged'));
    expect(events.indexOf('target-staged')).toBeLessThan(events.indexOf('authority-relinquished'));
    expect(events.indexOf('authority-relinquished')).toBeLessThan(events.indexOf('old-route-closed'));
    expect(events.indexOf('old-route-closed')).toBeLessThan(events.indexOf('target-activated'));
    expect(events.indexOf('target-verified')).toBeLessThan(events.indexOf('source-demoted'));
    expect(events.indexOf('source-demoted')).toBeLessThan(
      events.indexOf('projection-project-alpha'),
    );
    expect(events.indexOf('authority-completed')).toBeLessThan(
      events.indexOf('old-authority-finalized'),
    );
    expect(events.indexOf('source-demoted')).toBeLessThan(events.indexOf('old-authority-finalized'));
    expect(projections.demoteSourceHost).toHaveBeenCalledWith({
      autoStart: false,
      endpoint: 'https://192.168.1.9:54545',
      ownsAuthority: false,
      projectId: 'project-alpha',
      proof,
      targetCaCertificatePem: TARGET_CA,
      targetCaFingerprint: TARGET_FINGERPRINT,
      targetHostMemberId: 'member-target',
      transferId: 'transfer-one',
    });
    expect(admission.reopenBeforeRelinquishment).not.toHaveBeenCalled();
    expect(target.markCompleted).toHaveBeenCalledWith({
      endpoint: 'https://192.168.1.9:54545',
      receiverCredential: Buffer.alloc(32, 4).toString('base64url'),
      targetCaCertificatePem: TARGET_CA,
      targetCaFingerprint: TARGET_FINGERPRINT,
      transferId: 'transfer-one',
    });
    expect(recovery.remove).toHaveBeenCalledWith('project-alpha', 'outgoing');
  });

  it('never reopens the old authority after relinquishment and resumes the same activation', async () => {
    target.activate.mockRejectedValueOnce(new Error('crash after cutover'));
    const first = coordinator();

    await expect(first.run('project-alpha', 'transfer-one')).rejects.toThrow('crash after cutover');
    expect(recoveryRecord?.phase).toBe('authority-relinquished');
    expect(admission.reopenBeforeRelinquishment).not.toHaveBeenCalled();
    expect(admission.closeActiveAuthority).toHaveBeenCalled();

    await coordinator().run('project-alpha', 'transfer-one');
    expect(recoveryRecord?.phase).toBe('completed');
    expect(authority.relinquish).toHaveBeenCalledTimes(1);
    expect(target.activate).toHaveBeenCalledTimes(2);
  });

  it('keeps the still-authoritative source quiesced when staging fails before cutover', async () => {
    target.stage.mockRejectedValueOnce(new Error('network'));

    await expect(coordinator().run('project-alpha', 'transfer-one')).rejects.toThrow('network');
    expect(recoveryRecord?.phase).toBe('quiescing');
    expect(admission.reopenBeforeRelinquishment).not.toHaveBeenCalled();
    expect(target.activate).not.toHaveBeenCalled();
    expect(projections.demoteSourceHost).not.toHaveBeenCalled();
  });

  it('reconciles an authority phase committed immediately before a local-checkpoint crash', async () => {
    recovery.save
      .mockImplementationOnce(async value => {
        recoveryRecord = value;
        events.push(`save-${value.phase}`);
      })
      .mockRejectedValueOnce(new Error('crash after authority quiesce'));
    await expect(coordinator().run('project-alpha', 'transfer-one'))
      .rejects.toThrow('crash after authority quiesce');
    expect(authorityRecord.phase).toBe('quiescing');
    expect(recoveryRecord?.phase).toBe('accepted');

    recovery.save.mockImplementation(async value => {
      recoveryRecord = value;
      events.push(`save-${value.phase}`);
    });
    await coordinator().run('project-alpha', 'transfer-one');
    expect(recoveryRecord?.phase).toBe('completed');
    expect(authority.advance.mock.calls.filter(call => (
      call[0].nextPhase === 'quiescing'
    ))).toHaveLength(1);
  });

  it('classifies authority cutover as post-relinquishment before mutating local recovery', async () => {
    recoveryRecord = {
      activationCertificate: null,
      createdAt: NOW,
      direction: 'outgoing',
      kind: 'host-transfer-recovery',
      manifestDigest: MANIFEST_DIGEST,
      phase: 'staged',
      projectId: 'project-alpha',
      receiverCredential: Buffer.alloc(32, 4).toString('base64url'),
      receiverCredentialHash: null,
      schemaVersion: 1,
      sourceHostMemberId: 'member-host',
      stagingDirectoryName: null,
      targetCaCertificatePem: TARGET_CA,
      targetCaFingerprint: TARGET_FINGERPRINT,
      targetEndpoint: 'https://192.168.1.9:54545',
      targetHostMemberId: 'member-target',
      targetTerminalResponseReceived: false,
      transferId: 'transfer-one',
      updatedAt: NOW,
    };
    authorityRecord = {
      ...authorityRecord,
      activationCertificate: activation,
      manifestDigest: MANIFEST_DIGEST,
      phase: 'authority-relinquished',
    };

    await expect(coordinator().inspectStartupRecovery(
      'project-alpha',
      'transfer-one',
    )).resolves.toBe('post-relinquishment');

    expect(recovery.save).not.toHaveBeenCalled();
  });

  it('resumes old-authority teardown after completed authority was checkpointed', async () => {
    admission.finalizeOldAuthority.mockRejectedValueOnce(new Error('teardown interrupted'));

    await expect(coordinator().run('project-alpha', 'transfer-one'))
      .rejects.toThrow('teardown interrupted');
    expect(authorityRecord.phase).toBe('completed');
    expect(recoveryRecord?.phase).toBe('completed');

    await coordinator().run('project-alpha', 'transfer-one');
    expect(admission.finalizeOldAuthority).toHaveBeenCalledTimes(2);
    expect(recovery.remove).toHaveBeenCalledWith('project-alpha', 'outgoing');
  });

  it('reopens only after a durable pre-cutover cancellation', async () => {
    target.stage.mockRejectedValueOnce(new Error('network'));
    const instance = coordinator();
    await expect(instance.run('project-alpha', 'transfer-one')).rejects.toThrow('network');
    authorityRecord = { ...authorityRecord, phase: 'cancelled' };

    await instance.cancelBeforeRelinquishment('project-alpha', 'transfer-one');
    expect(target.cancel).toHaveBeenCalledWith({
      endpoint: 'https://192.168.1.9:54545',
      receiverCredential: Buffer.alloc(32, 4).toString('base64url'),
      targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\nTARGET\n-----END CERTIFICATE-----\n',
      targetCaFingerprint: 'b'.repeat(64),
      transferId: 'transfer-one',
    });
    expect(events.indexOf('target-cancelled')).toBeLessThan(events.indexOf('reopened'));
    expect(admission.reopenBeforeRelinquishment).toHaveBeenCalledTimes(1);
    expect(recoveryRecord?.phase).toBe('cancelled');
    expect(recovery.remove).toHaveBeenCalledWith('project-alpha', 'outgoing');
  });

  it('persists accepted authority recovery before cancellation can clear the credential', async () => {
    const instance = coordinator();

    await instance.prepareCancellation('project-alpha', 'transfer-one');

    expect(recoveryRecord).toMatchObject({
      phase: 'accepted',
      receiverCredential: Buffer.alloc(32, 4).toString('base64url'),
      transferId: 'transfer-one',
    });
    expect(recovery.save).toHaveBeenCalledTimes(1);
  });

  it('resumes target cleanup after cancellation reconciliation crashes before cleanup', async () => {
    target.stage.mockRejectedValueOnce(new Error('network'));
    await expect(coordinator().run('project-alpha', 'transfer-one')).rejects.toThrow('network');
    authorityRecord = { ...authorityRecord, phase: 'cancelled', receiverCredential: null };
    target.cancel.mockRejectedValueOnce(new Error('crash before target cleanup'));

    await expect(coordinator().run('project-alpha', 'transfer-one'))
      .rejects.toThrow('crash before target cleanup');

    expect(recoveryRecord).toMatchObject({
      phase: 'cancelled',
      receiverCredential: Buffer.alloc(32, 4).toString('base64url'),
    });
    expect(admission.closeActiveAuthority).not.toHaveBeenCalled();
    expect(admission.reopenBeforeRelinquishment).not.toHaveBeenCalled();
    expect(recovery.remove).not.toHaveBeenCalled();

    const restarted = coordinator();
    await expect(restarted.inspectStartupRecovery('project-alpha', 'transfer-one'))
      .resolves.toBe('pre-relinquishment-cleanup');
    await restarted.prepareTerminalRecoveryBeforeStartup('project-alpha', 'transfer-one');

    expect(target.cancel).toHaveBeenCalledTimes(2);
    expect(recoveryRecord).toMatchObject({
      phase: 'cancelled',
      receiverCredential: Buffer.alloc(32, 4).toString('base64url'),
      targetTerminalResponseReceived: true,
    });
    expect(admission.reopenBeforeRelinquishment).not.toHaveBeenCalled();
    expect(recovery.remove).not.toHaveBeenCalled();

    await restarted.run('project-alpha', 'transfer-one');

    expect(admission.reopenBeforeRelinquishment).toHaveBeenCalledTimes(1);
    expect(recovery.remove).toHaveBeenCalledWith('project-alpha', 'outgoing');
    const targetCancelled = events.lastIndexOf('target-cancelled');
    expect(targetCancelled).toBeLessThan(events.lastIndexOf('save-cancelled'));
    expect(events.lastIndexOf('save-cancelled')).toBeLessThan(events.lastIndexOf('reopened'));
  });

  it('does not require target cleanup when an unaccepted offer is cancelled', async () => {
    recoveryRecord = null;
    authorityRecord = {
      ...authorityRecord,
      phase: 'cancelled',
      receiverCredential: null,
      targetCaCertificatePem: null,
      targetCaFingerprint: null,
      targetEndpoint: null,
    };

    await coordinator().cancelBeforeRelinquishment('project-alpha', 'transfer-one');

    expect(target.cancel).not.toHaveBeenCalled();
    expect(admission.reopenBeforeRelinquishment).not.toHaveBeenCalled();
  });

  it('replays a completed accepted cancellation after its response is lost', async () => {
    recoveryRecord = null;
    authorityRecord = {
      ...authorityRecord,
      phase: 'cancelled',
      receiverCredential: null,
    };
    const instance = coordinator();

    await instance.prepareCancellation('project-alpha', 'transfer-one');
    await instance.cancelBeforeRelinquishment('project-alpha', 'transfer-one');

    expect(target.cancel).not.toHaveBeenCalled();
    expect(admission.reopenBeforeRelinquishment).not.toHaveBeenCalled();
    expect(recovery.remove).not.toHaveBeenCalled();
  });
});
