import { TEST_INSTALLATION_A } from '@test/helpers/installations';

import {
  RetirementTerminalService,
} from '@/app/collab/retirement/RetirementTerminalService';
import type { RetirementTombstoneRecord } from '@/app/collab/retirement/RetirementTombstoneRecord';
import type { RetirementTombstoneRepository } from '@/app/collab/retirement/RetirementTombstoneRepository';

describe('RetirementTerminalService', () => {
  it('returns only the minimum replayable acknowledgement result', async () => {
    const repository = {
      acknowledge: jest.fn().mockResolvedValue({
        acknowledgedAt: '2026-08-13T08:01:00.000Z',
        result: { projectId: 'project-alpha', retiredAt: '2026-08-13T08:00:00.000Z' },
      }),
      authenticate: jest.fn().mockResolvedValue({ memberId: 'member-a', tombstone: record() }),
      load: jest.fn().mockResolvedValue(record()),
    } as unknown as RetirementTombstoneRepository;
    const service = new RetirementTerminalService(repository);

    const response = await service.acknowledge(
      'project-alpha',
      'a'.repeat(43),
      '2026-08-13T08:00:00.000Z',
    );

    expect(response.body).toEqual({
      acknowledgedAt: '2026-08-13T08:01:00.000Z',
      projectId: 'project-alpha',
      retiredAt: '2026-08-13T08:00:00.000Z',
    });

    await expect(service.acknowledge(
      'project-alpha',
      'a'.repeat(43),
      '2026-08-13T08:00:00.000Z',
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
      '2026-08-13T08:00:01.000Z',
    )).rejects.toMatchObject({ code: 'stale-project-selection' });
    expect(repository.acknowledge).toHaveBeenCalledWith(
      'project-alpha',
      'a'.repeat(43),
      '2026-08-13T08:00:01.000Z',
    );
  });

  it('serves the copied proof chain from the tombstone', async () => {
    const tombstone = record({
      hostTransitionProofs: [{
        issuedAt: '2026-08-12T08:00:00.000Z',
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
    expiresAt: '2026-09-12T08:00:00.000Z',
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
      retiredAt: '2026-08-13T08:00:00.000Z',
    },
    retiredAt: '2026-08-13T08:00:00.000Z',
    schemaVersion: 1,
    ...overrides,
  };
}
