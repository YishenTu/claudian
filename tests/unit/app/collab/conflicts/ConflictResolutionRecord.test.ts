import {
  COLLAB_CONFLICT_RESOLUTION_SCHEMA_VERSION,
  type ConflictResolutionRecord,
  decodeConflictResolutionRecord,
} from '@/app/collab/conflicts/ConflictResolutionRecord';

const OID = {
  base: '1'.repeat(40),
  main: '2'.repeat(40),
  personal: '3'.repeat(40),
  result: '4'.repeat(40),
};

function record(
  overrides: Partial<ConflictResolutionRecord> = {},
): ConflictResolutionRecord {
  return {
    createdAt: '2026-08-08T00:00:00.000Z',
    descriptor: {
      conflicts: [
        { kind: 'text', path: 'note.md' },
        { kind: 'text', path: 'other.md' },
      ],
      mergeBaseOid: OID.base,
      operationId: 'operation-a',
      projectId: 'project-a',
      startingMainOid: OID.main,
      startingPersonalOid: OID.personal,
    },
    operationId: 'operation-a',
    phase: 'ready',
    projectId: 'project-a',
    resultCommitOid: null,
    schemaVersion: COLLAB_CONFLICT_RESOLUTION_SCHEMA_VERSION,
    updatedAt: '2026-08-08T00:00:01.000Z',
    ...overrides,
  };
}

describe('ConflictResolutionRecord', () => {
  it('decodes immutable OIDs without local decision state or a filesystem path', () => {
    const decoded = decodeConflictResolutionRecord(record());

    expect(decoded).toEqual(record());
    expect(decoded).not.toHaveProperty('scratchPath');
    expect(decoded).not.toHaveProperty('decisions');
    expect(JSON.stringify(decoded)).not.toContain('/Users/');
  });

  it('requires a result OID for committed phases', () => {
    expect(() => decodeConflictResolutionRecord(record({
      phase: 'committed',
      resultCommitOid: null,
    }))).toThrow();
    expect(decodeConflictResolutionRecord(record({
      phase: 'committed',
      resultCommitOid: OID.result,
    })).resultCommitOid).toBe(OID.result);
    expect(() => decodeConflictResolutionRecord({
      ...record(),
      phase: 'applied',
      resultCommitOid: OID.result,
    })).toThrow();
  });

  it('rejects identity drift and invalid paths', () => {
    expect(() => decodeConflictResolutionRecord({
      ...record(),
      operationId: 'operation-b',
    })).toThrow();
    expect(() => decodeConflictResolutionRecord({
      ...record(),
      descriptor: {
        ...record().descriptor,
        conflicts: [{ kind: 'text', path: '../outside.md' }],
      },
    })).toThrow();
  });

  it('migrates legacy decision records to the decision-free schema', () => {
    const decoded = decodeConflictResolutionRecord({
      ...record(),
      decisions: [{ choice: 'keep-personal', path: 'note.md' }],
      schemaVersion: 1,
    });

    expect(decoded.schemaVersion).toBe(COLLAB_CONFLICT_RESOLUTION_SCHEMA_VERSION);
    expect(decoded).not.toHaveProperty('decisions');
  });

  it('rejects invalid terminal timestamps', () => {
    expect(() => decodeConflictResolutionRecord(record({
      updatedAt: 'not-a-date',
    }))).toThrow();
  });
});
