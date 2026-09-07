import type { CollabLocalLanMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { LanAuthorityAdapter } from '@/app/collab/remote-authority/LanAuthorityAdapter';

const PROJECT_ID = 'project-authority-lan';

function membership(): CollabLocalLanMembershipRecord {
  return {
    authority: {
      endpoint: 'https://192.168.1.20:41730',
      gitRemoteUrl: `https://192.168.1.20:41730/v1/git/${PROJECT_ID}/repository.git`,
      hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----',
      hostCaFingerprint: 'a'.repeat(64),
      kind: 'lan',
    },
    createdAt: '2026-08-22T00:00:00.000Z',
    hostOwnership: { autoStart: false, ownsAuthority: false },
    lastEventSequence: 12,
    lifecycle: 'active',
    member: {
      credential: 'c'.repeat(43),
      displayName: 'Alice',
      id: 'member-alice',
      personalRef: 'refs/claudian/members/member-alice',
      role: 'manager',
    },
    project: {
      id: PROJECT_ID,
      name: 'LAN Project',
      workspacePath: `workspace/${PROJECT_ID}`,
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: '2026-08-22T00:00:00.000Z',
  };
}

describe('LanAuthorityAdapter', () => {
  it('preserves pinned LAN control, event, and Git network facts', async () => {
    const control = { readSnapshot: jest.fn() } as never;
    const eventResource = { dispose: jest.fn() };
    const createEvent = jest.fn(() => eventResource);
    const adapter = new LanAuthorityAdapter({
      createControl: () => control,
      createEvent,
      createMembershipControl: () => ({ membership: jest.fn() }),
    });

    const session = await adapter.create(membership());
    const onInvalidation = jest.fn(async () => 12);
    const event = session.events.connect({ afterSequence: 12, onInvalidation });

    expect(session.authorityKind).toBe('lan');
    expect(session.control).toBe(control);
    expect(session.supports('project-snapshot')).toBe(true);
    expect(session.git).toEqual({
      caCertificatePem: '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----',
      headers: [{
        name: 'Authorization',
        value: `Basic ${Buffer.from(`member-alice:${'c'.repeat(43)}`).toString('base64')}`,
      }],
      remoteUrl: `https://192.168.1.20:41730/v1/git/${PROJECT_ID}/repository.git`,
    });
    expect(createEvent).toHaveBeenCalledWith({
      caCertificatePem: '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----',
      endpoint: 'https://192.168.1.20:41730',
      lastSequence: 12,
      memberCredential: 'c'.repeat(43),
      projectId: PROJECT_ID,
    }, onInvalidation);
    expect(event).toBe(eventResource);
  });

  it.each([
    {
      lane: 'ordinary Member',
      localEndpoint: null,
      ownsAuthority: false,
      expectedEndpoint: 'https://192.168.1.20:41730',
    },
    {
      lane: 'Host Member hosted elsewhere',
      localEndpoint: null,
      ownsAuthority: true,
      expectedEndpoint: 'https://192.168.1.20:41730',
    },
    {
      lane: 'Host Member hosted here',
      localEndpoint: 'https://192.168.1.44:41731',
      ownsAuthority: true,
      expectedEndpoint: 'https://192.168.1.44:41731',
    },
  ])('uses one Member-authenticated session for the $lane lane', async ({
    expectedEndpoint,
    localEndpoint,
    ownsAuthority,
  }) => {
    const controlMemberships: CollabLocalLanMembershipRecord[] = [];
    const membershipControlMemberships: CollabLocalLanMembershipRecord[] = [];
    const createEvent = jest.fn(() => ({ dispose: jest.fn() }));
    const adapter = new LanAuthorityAdapter({
      createControl: record => {
        controlMemberships.push(record);
        return { readSnapshot: jest.fn() } as never;
      },
      createEvent,
      createMembershipControl: record => {
        membershipControlMemberships.push(record);
        return { membership: jest.fn() };
      },
      resolveLocalTarget: jest.fn().mockResolvedValue(
        localEndpoint === null ? null : { endpoint: localEndpoint },
      ),
    });
    const record = {
      ...membership(),
      hostOwnership: { ownsAuthority },
    };

    const session = await adapter.create(record);
    session.events.connect({ afterSequence: 12, onInvalidation: async () => 12 });

    expect(session.constructor).toBe(Object);
    expect(controlMemberships).toEqual([expect.objectContaining({
      authority: expect.objectContaining({ endpoint: expectedEndpoint }),
      hostOwnership: { ownsAuthority },
      member: record.member,
    })]);
    expect(membershipControlMemberships).toEqual([expect.objectContaining({
      authority: expect.objectContaining({ endpoint: expectedEndpoint }),
      hostOwnership: { ownsAuthority },
      member: record.member,
    })]);
    expect(session.git.remoteUrl).toBe(
      `${expectedEndpoint}/v1/git/${PROJECT_ID}/repository.git`,
    );
    expect(session.git.headers).toEqual([{
      name: 'Authorization',
      value: `Basic ${Buffer.from(`member-alice:${'c'.repeat(43)}`).toString('base64')}`,
    }]);
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: expectedEndpoint,
      memberCredential: record.member.credential,
      projectId: PROJECT_ID,
    }), expect.any(Function));
  });

  it('rejects incomplete LAN authority state without fabricating Cloud fields', async () => {
    const record = membership();
    const adapter = new LanAuthorityAdapter();

    await expect(adapter.create({
      ...record,
      authority: { ...record.authority, endpoint: null },
    })).rejects.toMatchObject({
      code: 'host-stopped',
      safeContext: { reason: 'lan-authority-session-trust-unavailable' },
    });
  });
});
