import { testTime } from '@test/helpers/testClock';

import {
  type CloudManagerResponsibilityReceiptRecord,
  COLLAB_MANAGER_RESPONSIBILITY_RECEIPT_SCHEMA_VERSION,
  decodeCloudManagerResponsibilityReceiptRecord,
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
  offeredAt: testTime({ days: -14 }),
  expiresAt: testTime({ days: -14, minutes: 10 }),
  acknowledgedAt: null,
  updatedAt: testTime({ days: -14 }),
};

const cloudRecord: CloudManagerResponsibilityReceiptRecord = {
  authorityGeneration: 7,
  kind: 'manager-responsibility-receipt',
  memberId: 'member-bob',
  offer: {
    acknowledgedAt: null,
    expiresAt: testTime({ days: -13 }),
    managerSetGenerationAtOffer: 4,
    offeredAt: testTime({ days: -14 }),
    offerId: 'offer-cloud',
    purpose: 'manager-leave',
    revision: 2,
    sourceManagerMemberId: 'member-alice',
    state: 'offered',
    targetMemberId: 'member-bob',
    targetMembershipRevisionAtOffer: 3,
    terminalAt: null,
  },
  operation: 'acknowledgeManagerResponsibility',
  phase: 'submitted',
  projectId: 'project-alpha',
  request: {
    expectedOfferRevision: 2,
    idempotencyKey: 'manager-ack-cloud',
    offerId: 'offer-cloud',
    projectId: 'project-alpha',
  },
  schemaVersion: 3,
  serverUrl: 'https://cloud.example',
  updatedAt: testTime({ days: -14, minutes: 1 }),
};

describe('ManagerResponsibilityReceiptRecord', () => {
  it('round-trips one strict Cloud receipt without accepting a legacy Cloud shape', () => {
    expect(decodeCloudManagerResponsibilityReceiptRecord(cloudRecord)).toEqual(cloudRecord);
    expect(decodeManagerResponsibilityReceiptRecord(cloudRecord)).toEqual(cloudRecord);
    expect(() => decodeManagerResponsibilityReceiptRecord({ ...cloudRecord, schemaVersion: 2 }))
      .toThrow(TypeError);
  });

  it.each([
    { ...cloudRecord, extra: true },
    { ...cloudRecord, memberId: 'member-other' },
    { ...cloudRecord, projectId: 'project-other' },
    { ...cloudRecord, request: { ...cloudRecord.request!, offerId: 'offer-other' } },
    { ...cloudRecord, request: { ...cloudRecord.request!, expectedOfferRevision: 3 } },
    { ...cloudRecord, phase: 'settled', offer: { ...cloudRecord.offer, state: 'offered' } },
  ])('rejects a Cloud receipt whose durable tuple is not exact', value => {
    expect(() => decodeCloudManagerResponsibilityReceiptRecord(value)).toThrow();
  });

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
    { ...record, expiresAt: testTime({ days: -15 }) },
    { ...record, purpose: 'manager-transfer' },
  ])('rejects impossible receipt state', value => {
    expect(() => decodeManagerResponsibilityReceiptRecord(value)).toThrow(TypeError);
  });
});
