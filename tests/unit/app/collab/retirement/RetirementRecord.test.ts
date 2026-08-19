import {
  COLLAB_RETIREMENT_RECORD_SCHEMA_VERSION,
  decodeRetirementRecord,
  type RetirementRecord,
} from '@/app/collab/retirement/RetirementRecord';

const record: RetirementRecord = {
  schemaVersion: COLLAB_RETIREMENT_RECORD_SCHEMA_VERSION,
  kind: 'retirement',
  projectId: 'project-alpha',
  memberId: 'member-alice',
  retiredAt: '2026-08-13T00:00:00.000Z',
  cleanupOperationId: 'cleanup-one',
  cleanupStatus: 'pending',
  acknowledgementStatus: 'pending',
  acknowledgedAt: null,
  memberCredential: 'A'.repeat(43),
  hostEndpoint: 'https://192.168.1.20:54545',
  hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
  hostCaFingerprint: 'a'.repeat(64),
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: '2026-08-13T00:00:00.000Z',
};

describe('RetirementRecord', () => {
  it('round-trips a pending terminal acknowledgement', () => {
    expect(decodeRetirementRecord(record)).toEqual(record);
  });

  it.each([
    { ...record, role: 'manager' },
    { ...record, acknowledgementStatus: 'acknowledged', acknowledgedAt: null },
    { ...record, acknowledgementStatus: 'acknowledged', acknowledgedAt: record.retiredAt },
    { ...record, hostEndpoint: '/tmp/socket' },
  ])('rejects excess or impossible retired state', value => {
    if (value.acknowledgementStatus === 'acknowledged' && value.acknowledgedAt) {
      value.memberCredential = 'A'.repeat(43);
    }
    expect(() => decodeRetirementRecord(value)).toThrow(TypeError);
  });
});
