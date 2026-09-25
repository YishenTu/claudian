import { testTime } from '@test/helpers/testClock';

import {
  COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
  type CollabPublicationStateRecord,
  decodeCollabPublicationStateRecord,
} from '@/app/collab/publish/CollabPublicationStateRecord';

const OID = {
  base: '1'.repeat(40),
  candidate: '2'.repeat(40),
  contribution: '3'.repeat(40),
  main: '4'.repeat(40),
};

function record(
  overrides: Partial<CollabPublicationStateRecord> = {},
): CollabPublicationStateRecord {
  return {
    baseMainOid: OID.base,
    operation: null,
    projectId: 'project-a',
    schemaVersion: COLLAB_PUBLICATION_STATE_SCHEMA_VERSION,
    updatedAt: testTime({ days: -18 }),
    ...overrides,
  };
}

describe('CollabPublicationStateRecord', () => {
  it('retains Update intent and its applied personal review baseline across decoding', () => {
    const reviewBaseline = {
      acceptedMainOid: OID.main,
      baselineOid: OID.base,
      sourceHeadOid: OID.contribution,
    };
    const value = {
      ...record(),
      reviewBaseline,
      operation: {
        candidateOid: OID.candidate,
        contributionHeadOid: OID.contribution,
        createdAt: testTime({ days: -18 }),
        currentMainOid: OID.main,
        intent: 'update',
        operationId: 'update-a',
        phase: 'applied',
        reviewBaseline,
        updatedAt: testTime({ days: -18, minutes: 1 }),
      },
    };
    expect(decodeCollabPublicationStateRecord(JSON.parse(JSON.stringify(value)))).toEqual(value);
    expect(() => decodeCollabPublicationStateRecord({
      ...value, operation: { ...value.operation, intent: 'unknown' },
    })).toThrow();
    expect(() => decodeCollabPublicationStateRecord({
      ...value, reviewBaseline: { ...reviewBaseline, baselineOid: 'invalid' },
    })).toThrow();
    expect(() => decodeCollabPublicationStateRecord({
      ...value, operation: { ...value.operation, phase: 'pushed' },
    })).toThrow();
  });

  it('decodes a required base and exact review-ready operation', () => {
    const value = record({
      operation: {
        candidateOid: OID.candidate,
        contributionHeadOid: OID.contribution,
        createdAt: testTime({ days: -18 }),
        currentMainOid: OID.main,
        operationId: 'publish-a',
        phase: 'review-ready',
        updatedAt: testTime({ days: -18, minutes: 1 }),
      },
    });

    expect(decodeCollabPublicationStateRecord(value)).toEqual(value);
    expect(JSON.stringify(value)).not.toContain('/Users/');
  });

  it('uses phase as the sole confirmation authority and rejects the legacy boolean', () => {
    const operation = {
      candidateOid: OID.candidate,
      contributionHeadOid: OID.contribution,
      createdAt: testTime({ days: -18 }),
      currentMainOid: OID.main,
      operationId: 'publish-a',
      phase: 'confirmed' as const,
      updatedAt: testTime({ days: -18, minutes: 1 }),
    };

    expect(decodeCollabPublicationStateRecord(record({ operation })).operation)
      .toMatchObject({ phase: 'confirmed' });
    expect(() => decodeCollabPublicationStateRecord(record({
      operation: { ...operation, confirmed: true } as never,
    }))).toThrow();
  });

  it('allows captured state only before main and candidate are known', () => {
    const captured = record({
      operation: {
        candidateOid: null,
        contributionHeadOid: OID.contribution,
        createdAt: testTime({ days: -18 }),
        currentMainOid: null,
        operationId: 'publish-a',
        phase: 'captured',
        updatedAt: testTime({ days: -18 }),
      },
    });

    expect(decodeCollabPublicationStateRecord(captured)).toEqual(captured);
    expect(() => decodeCollabPublicationStateRecord({
      ...captured,
      operation: { ...captured.operation, candidateOid: OID.candidate },
    })).toThrow();
  });

  it('rejects missing bases, invalid OIDs, unsupported phases, and extra unsafe data', () => {
    expect(() => decodeCollabPublicationStateRecord({
      ...record(),
      baseMainOid: undefined,
    })).toThrow();
    expect(() => decodeCollabPublicationStateRecord({
      ...record(),
      baseMainOid: 'not-an-oid',
    })).toThrow();
    expect(() => decodeCollabPublicationStateRecord({
      ...record(),
      operation: {
        candidateOid: OID.candidate,
        contributionHeadOid: OID.contribution,
        createdAt: testTime({ days: -18 }),
        currentMainOid: OID.main,
        operationId: 'publish-a',
        phase: 'unknown',
        updatedAt: testTime({ days: -18, minutes: 1 }),
      },
    })).toThrow();
    expect(() => decodeCollabPublicationStateRecord({
      ...record(),
      credential: 'secret',
    })).toThrow();
  });
});
