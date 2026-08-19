import {
  COLLAB_MANAGER_RESPONSIBILITY_RECEIPT_SCHEMA_VERSION,
  decodeManagerResponsibilityReceiptRecord,
  type ManagerResponsibilityReceiptRecord,
} from '@/app/collab/exit/ManagerResponsibilityReceiptRecord';

const record: ManagerResponsibilityReceiptRecord = {
  schemaVersion: COLLAB_MANAGER_RESPONSIBILITY_RECEIPT_SCHEMA_VERSION,
  kind: 'manager-responsibility-receipt',
  projectId: 'project-alpha',
  offerId: 'offer-one',
  sourceManagerMemberId: 'member-alice',
  targetMemberId: 'member-bob',
  purpose: 'manager-leave',
  status: 'offered',
  offeredAt: '2026-08-13T00:00:00.000Z',
  expiresAt: '2026-08-13T00:10:00.000Z',
  acknowledgedAt: null,
  updatedAt: '2026-08-13T00:00:00.000Z',
};

describe('ManagerResponsibilityReceiptRecord', () => {
  it('round-trips an offered receipt', () => {
    expect(decodeManagerResponsibilityReceiptRecord(record)).toEqual(record);
  });

  it.each([
    ['manager-transfer', 'manager-promotion'],
    ['manager-leave', 'manager-leave'],
  ] as const)('migrates schema 1 %s receipts into schema 2 %s records', (
    legacyPurpose,
    purpose,
  ) => {
    expect(decodeManagerResponsibilityReceiptRecord({
      ...record,
      purpose: legacyPurpose,
      schemaVersion: 1,
    })).toEqual({
      ...record,
      purpose,
      schemaVersion: 2,
    });
  });

  it.each([
    { ...record, extra: true },
    { ...record, status: 'acknowledged', acknowledgedAt: null },
    { ...record, status: 'offered', acknowledgedAt: record.offeredAt },
    { ...record, expiresAt: '2026-08-12T00:00:00.000Z' },
    { ...record, purpose: 'manager-transfer' },
  ])('rejects impossible receipt state', value => {
    expect(() => decodeManagerResponsibilityReceiptRecord(value)).toThrow(TypeError);
  });
});
