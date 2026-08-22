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
