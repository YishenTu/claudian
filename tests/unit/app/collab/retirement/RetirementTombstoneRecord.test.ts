import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import {
  COLLAB_RETIREMENT_TOMBSTONE_SCHEMA_VERSION,
  decodeRetirementTombstoneRecord,
  type RetirementTombstoneRecord,
} from '@/app/collab/retirement/RetirementTombstoneRecord';

const retiredAt = '2026-08-13T00:00:00.000Z';
const record: RetirementTombstoneRecord = {
  schemaVersion: COLLAB_RETIREMENT_TOMBSTONE_SCHEMA_VERSION,
  kind: 'retirement-tombstone',
  ownerInstallationKey: TEST_INSTALLATION_A,
  projectId: 'project-alpha',
  retiredAt,
  expiresAt: '2026-09-12T00:00:00.000Z',
  result: { projectId: 'project-alpha', retiredAt },
  replay: {
    actorMemberId: 'member-alice',
    idempotencyKey: 'retire-one',
    requestFingerprint: 'c'.repeat(64),
  },
  hostTransitionProofs: [],
  formerMembers: [{
    memberId: 'member-alice',
    credentialHash: 'd'.repeat(64),
    acknowledgedAt: null,
  }],
};

describe('RetirementTombstoneRecord', () => {
  it('round-trips the minimum terminal responder state', () => {
    expect(decodeRetirementTombstoneRecord(record)).toEqual(record);
  });

  it('classifies ownerless legacy input without assigning the current installation', () => {
    const { ownerInstallationKey: _, ...withoutOwner } = record;
    expect(decodeRetirementTombstoneRecord({
      ...withoutOwner,
      schemaVersion: 1,
    })).toMatchObject({ schemaVersion: 1 });
    expect(() => decodeRetirementTombstoneRecord(withoutOwner)).toThrow(TypeError);
    expect(() => decodeRetirementTombstoneRecord({
      ...record,
      ownerInstallationKey: 'device-invalid',
    })).toThrow(TypeError);
    expect(() => decodeRetirementTombstoneRecord({
      ...record,
      schemaVersion: 1,
    })).toThrow(TypeError);
  });

  it.each([
    { ...record, displayName: 'Alice' },
    { ...record, expiresAt: '2026-09-11T00:00:00.000Z' },
    { ...record, result: { ...record.result, projectId: 'other' } },
    { ...record, formerMembers: [...record.formerMembers, record.formerMembers[0]] },
    { ...record, formerMembers: [{ ...record.formerMembers[0], credentialHash: 'secret' }] },
  ])('rejects privacy leaks and inconsistent terminal state', value => {
    expect(() => decodeRetirementTombstoneRecord(value)).toThrow(TypeError);
  });
});
