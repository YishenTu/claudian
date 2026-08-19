import { LocalHostTransferProjection } from '@/app/collab/host-transfer/LocalHostTransferProjection';

const membership = {
  authority: {
    endpoint: 'https://192.168.1.10:27000',
    gitRemoteUrl: 'https://192.168.1.10:27000/v1/git/project-alpha/repository.git',
    hostCaCertificatePem: 'source-ca',
    hostCaFingerprint: 'a'.repeat(64),
    kind: 'lan' as const,
  },
  createdAt: '2026-08-13T00:00:00.000Z',
  hostOwnership: { autoStart: false, ownsAuthority: false },
  lastEventSequence: 5,
  member: {
    credential: 'credential', displayName: 'Member', id: 'member-target',
    personalRef: 'refs/heads/members/member-target', role: 'member' as const,
  },
  project: { id: 'project-alpha', name: 'Alpha', workspacePath: 'Projects/alpha' },
  schemaVersion: 1 as const,
  updatedAt: '2026-08-13T00:00:00.000Z',
};

describe('LocalHostTransferProjection', () => {
  it('promotes the target with new trust, origin, cursor, and Host ownership', async () => {
    const saveMembership = jest.fn().mockResolvedValue(undefined);
    const rotateOrigin = jest.fn().mockResolvedValue(undefined);
    const projection = new LocalHostTransferProjection({
      loadMembership: jest.fn().mockResolvedValue(membership),
      now: () => new Date('2026-08-13T00:01:00.000Z'),
      resolveWorkspace: jest.fn().mockResolvedValue('/vault/Projects/alpha'),
      rotateOrigin,
      saveMembership,
    });

    await projection.promoteTargetHost({
      autoStart: true, endpoint: 'https://192.168.1.20:27000', eventSequence: 12,
      ownsAuthority: true, projectId: 'project-alpha', targetCaCertificatePem: 'target-ca',
      targetCaFingerprint: 'b'.repeat(64), targetHostMemberId: 'member-target',
      transferId: 'transfer-alpha',
    });

    expect(rotateOrigin).toHaveBeenCalledWith(expect.objectContaining({
      newRemoteUrl: 'https://192.168.1.20:27000/v1/git/project-alpha/repository.git',
    }));
    expect(saveMembership).toHaveBeenCalledWith(expect.objectContaining({
      authority: expect.objectContaining({ endpoint: 'https://192.168.1.20:27000' }),
      hostOwnership: { autoStart: true, ownsAuthority: true },
      lastEventSequence: 12,
    }));
  });

  it('demotes the source only after rotating its exact old origin', async () => {
    const sourceMembership = {
      ...membership,
      hostOwnership: { autoStart: true, ownsAuthority: true },
      member: { ...membership.member, id: 'member-source' },
    };
    const saveMembership = jest.fn().mockResolvedValue(undefined);
    const rotateOrigin = jest.fn().mockResolvedValue(undefined);
    const projection = new LocalHostTransferProjection({
      loadMembership: jest.fn().mockResolvedValue(sourceMembership),
      now: () => new Date('2026-08-13T00:01:00.000Z'),
      resolveWorkspace: jest.fn().mockResolvedValue('/vault/Projects/alpha'),
      rotateOrigin,
      saveMembership,
    });

    await projection.demoteSourceHost({
      autoStart: false, endpoint: 'https://192.168.1.20:27000', ownsAuthority: false,
      projectId: 'project-alpha', proof: {} as never,
      targetCaCertificatePem: 'target-ca', targetCaFingerprint: 'b'.repeat(64),
      targetHostMemberId: 'member-target', transferId: 'transfer-alpha',
    });

    expect(saveMembership).toHaveBeenCalledWith(expect.objectContaining({
      hostOwnership: { autoStart: false, ownsAuthority: false },
    }));
  });

  it('returns only the currently pinned source CA and rejects a missing binding', async () => {
    const projection = new LocalHostTransferProjection({
      loadMembership: jest.fn().mockResolvedValue(membership),
      resolveWorkspace: jest.fn(), rotateOrigin: jest.fn(), saveMembership: jest.fn(),
    });
    await expect(projection.readPinnedSourceCa('project-alpha')).resolves.toBe('source-ca');
    await expect(new LocalHostTransferProjection({
      loadMembership: jest.fn().mockResolvedValue(null),
      resolveWorkspace: jest.fn(), rotateOrigin: jest.fn(), saveMembership: jest.fn(),
    }).readPinnedSourceCa('project-alpha')).rejects.toMatchObject({ code: 'project-not-found' });
  });
});
