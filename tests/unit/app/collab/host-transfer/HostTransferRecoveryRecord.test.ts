import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import {
  advanceHostTransferRecoveryRecord,
  createHostTransferRecoveryRecord,
} from '@/app/collab/host-transfer/HostTransferRecovery';
import {
  bindLegacyHostTransferRecoveryOwner,
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
  ownerInstallationKey: TEST_INSTALLATION_A,
  activationCertificate: null,
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
};

describe('HostTransferRecoveryRecord', () => {
  it('round-trips a private incoming recovery checkpoint', () => {
    expect(decodeHostTransferRecoveryRecord(record)).toEqual(record);
  });

  it('accepts schema 1 only as ownerless legacy recovery', () => {
    const { ownerInstallationKey: _, ...legacy } = record;
    expect(decodeHostTransferRecoveryRecord({
      ...legacy,
      schemaVersion: 1,
    })).toMatchObject({ schemaVersion: 1 });
  });

  it('binds only an outgoing legacy checkpoint to the explicitly claimed Host', () => {
    const { ownerInstallationKey: _, ...legacy } = record;
    const incoming = decodeHostTransferRecoveryRecord({ ...legacy, schemaVersion: 1 });
    const currentOutgoing = createHostTransferRecoveryRecord({
      ownerInstallationKey: TEST_INSTALLATION_A,
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
    const { ownerInstallationKey: _outgoingOwner, ...legacyOutgoing } = currentOutgoing;
    const outgoing = decodeHostTransferRecoveryRecord({ ...legacyOutgoing, schemaVersion: 1 });

    expect(() => bindLegacyHostTransferRecoveryOwner(incoming, TEST_INSTALLATION_A))
      .toThrow('Host transfer target owner is ambiguous');
    expect(bindLegacyHostTransferRecoveryOwner(outgoing, TEST_INSTALLATION_A)).toMatchObject({
      ownerInstallationKey: TEST_INSTALLATION_A,
      schemaVersion: COLLAB_HOST_TRANSFER_RECOVERY_SCHEMA_VERSION,
    });
  });

  it('rejects an invalid current installation owner', () => {
    expect(() => decodeHostTransferRecoveryRecord({
      ...record,
      ownerInstallationKey: 'device-invalid',
    })).toThrow(TypeError);
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
      ownerInstallationKey: TEST_INSTALLATION_A,
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
