import { TEST_INSTALLATION_A } from '@test/helpers/installations';
import { testTime } from '@test/helpers/testClock';

import {
  RetirementTerminalService,
} from '@/app/collab/retirement/RetirementTerminalService';
import type { RetirementTombstoneRecord } from '@/app/collab/retirement/RetirementTombstoneRecord';
import type { RetirementTombstoneRepository } from '@/app/collab/retirement/RetirementTombstoneRepository';

describe('RetirementTerminalService', () => {
  it('returns only the minimum replayable acknowledgement result', async () => {
    const repository = {
      acknowledge: jest.fn().mockResolvedValue({
        acknowledgedAt: testTime({ days: -14, hours: 8, minutes: 1 }),
        result: { projectId: 'project-alpha', retiredAt: testTime({ days: -14, hours: 8 }) },
      }),
      authenticate: jest.fn().mockResolvedValue({ memberId: 'member-a', tombstone: record() }),
      load: jest.fn().mockResolvedValue(record()),
    } as unknown as RetirementTombstoneRepository;
    const service = new RetirementTerminalService(repository);

    const response = await service.acknowledge(
      'project-alpha',
      'a'.repeat(43),
      testTime({ days: -14, hours: 8 }),
    );

    expect(response.body).toEqual({
      acknowledgedAt: testTime({ days: -14, hours: 8, minutes: 1 }),
      projectId: 'project-alpha',
      retiredAt: testTime({ days: -14, hours: 8 }),
    });

    await expect(service.acknowledge(
      'project-alpha',
      'a'.repeat(43),
      testTime({ days: -14, hours: 8 }),
    )).resolves.toEqual(response);
    expect(repository.acknowledge).toHaveBeenCalledTimes(2);
  });

  it('rejects a stale retirement timestamp before persisting an acknowledgement', async () => {
    const repository = {
      acknowledge: jest.fn().mockRejectedValue(Object.assign(new Error('stale'), {
        code: 'stale-project-selection',
      })),
    } as unknown as RetirementTombstoneRepository;
    const service = new RetirementTerminalService(repository);

    await expect(service.acknowledge(
      'project-alpha',
      'a'.repeat(43),
      testTime({ days: -14, hours: 8, seconds: 1 }),
    )).rejects.toMatchObject({ code: 'stale-project-selection' });
    expect(repository.acknowledge).toHaveBeenCalledWith(
      'project-alpha',
      'a'.repeat(43),
      testTime({ days: -14, hours: 8, seconds: 1 }),
    );
  });

  it('serves the copied proof chain from the tombstone', async () => {
    const tombstone = record({
      hostTransitionProofs: [{
        issuedAt: testTime({ days: -15, hours: 8 }),
        nextCaCertificatePem: 'next-ca',
        nextCaFingerprint: 'b'.repeat(64),
        previousCaFingerprint: 'a'.repeat(64),
        projectId: 'project-alpha',
        schemaVersion: 1,
        signature: 'c'.repeat(64),
        signatureAlgorithm: 'rsa-pss-sha256',
        transferId: 'transfer-one',
      }],
    });
    const repository = {
      load: jest.fn().mockResolvedValue(tombstone),
    } as unknown as RetirementTombstoneRepository;
    const service = new RetirementTerminalService(repository);

    await expect(service.getHostTransitions('project-alpha'))
      .resolves.toEqual(tombstone.hostTransitionProofs);
  });
});

function record(
  overrides: Partial<RetirementTombstoneRecord> = {},
): RetirementTombstoneRecord {
  return {
    expiresAt: testTime({ days: 16, hours: 8 }),
    formerMembers: [{
      acknowledgedAt: null,
      credentialHash: 'a'.repeat(64),
      memberId: 'member-a',
    }],
    hostTransitionProofs: [],
    kind: 'retirement-tombstone',
    ownerInstallationKey: TEST_INSTALLATION_A,
    projectId: 'project-alpha',
    replay: {
      actorMemberId: 'member-a',
      idempotencyKey: 'retire-key-one',
      requestFingerprint: 'b'.repeat(64),
    },
    result: {
      projectId: 'project-alpha',
      retiredAt: testTime({ days: -14, hours: 8 }),
    },
    retiredAt: testTime({ days: -14, hours: 8 }),
    schemaVersion: 1,
    ...overrides,
  };
}
