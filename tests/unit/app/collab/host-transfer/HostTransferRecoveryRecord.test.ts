import {
  advanceHostTransferRecoveryRecord,
  createHostTransferRecoveryRecord,
} from '@/app/collab/host-transfer/HostTransferRecovery';
import {
  COLLAB_HOST_TRANSFER_RECOVERY_SCHEMA_VERSION,
  decodeHostTransferRecoveryRecord,
  type HostTransferRecoveryRecord,
} from '@/app/collab/host-transfer/HostTransferRecoveryRecord';

const record: HostTransferRecoveryRecord = {
  schemaVersion: COLLAB_HOST_TRANSFER_RECOVERY_SCHEMA_VERSION,
  kind: 'host-transfer-recovery',
  direction: 'incoming',
  projectId: 'project-alpha',
  transferId: 'transfer-one',
  sourceHostMemberId: 'member-alice',
  targetHostMemberId: 'member-bob',
  phase: 'accepted',
  targetEndpoint: 'https://192.168.1.21:54545',
  targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
  targetCaFingerprint: 'b'.repeat(64),
  receiverCredential: 'A'.repeat(43),
  receiverCredentialHash: null,
  targetTerminalResponseReceived: false,
  stagingDirectoryName: '.claudian-host-transfer-transfer-one',
  manifestDigest: null,
  activationCertificate: null,
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
};

describe('HostTransferRecoveryRecord', () => {
  it('round-trips a private incoming recovery checkpoint', () => {
    expect(decodeHostTransferRecoveryRecord(record)).toEqual(record);
  });

  it.each([
    { ...record, packagePath: '/tmp/package' },
    { ...record, receiverCredential: null },
    { ...record, stagingDirectoryName: '../staging' },
    { ...record, phase: 'staged', manifestDigest: null },
    { ...record, phase: 'recovery-required' },
  ])('rejects unsafe or impossible recovery state', value => {
    expect(() => decodeHostTransferRecoveryRecord(value)).toThrow(TypeError);
  });

  it('retains outgoing cancellation authority until target cleanup is checkpointed', () => {
    const outgoing = createHostTransferRecoveryRecord({
      createdAt: record.createdAt,
      direction: 'outgoing',
      projectId: record.projectId,
      receiverCredential: record.receiverCredential,
      sourceHostMemberId: record.sourceHostMemberId,
      targetCaCertificatePem: record.targetCaCertificatePem,
      targetCaFingerprint: record.targetCaFingerprint,
      targetEndpoint: record.targetEndpoint,
      targetHostMemberId: record.targetHostMemberId,
      transferId: record.transferId,
    });

    const terminal = advanceHostTransferRecoveryRecord(
      outgoing,
      'cancelled',
      record.updatedAt,
    );
    expect(terminal.receiverCredential).toBe(record.receiverCredential);

    expect(advanceHostTransferRecoveryRecord(
      terminal,
      'cancelled',
      record.updatedAt,
      { targetTerminalResponseReceived: true },
    )).toMatchObject({
      receiverCredential: record.receiverCredential,
      targetTerminalResponseReceived: true,
    });
  });
});
