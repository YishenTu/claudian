import type { CollabLocalLanMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { LocalMembershipControlPort } from '@/app/collab/membership/LocalMembershipControlPort';
import { MembershipControlClient } from '@/app/collab/membership/MembershipControlClient';

const PROJECT_ID = 'project-membership-port';
const MEMBER_ID = 'member-manager';
const CREATED_AT = '2026-09-01T00:00:00.000Z';

function membership(): CollabLocalLanMembershipRecord {
  return {
    authority: {
      endpoint: 'https://192.168.1.20:41730',
      gitRemoteUrl: `https://192.168.1.20:41730/v1/git/${PROJECT_ID}/repository.git`,
      hostCaCertificatePem: 'fixture-ca',
      hostCaFingerprint: 'a'.repeat(64),
      kind: 'lan',
    },
    createdAt: CREATED_AT,
    hostOwnership: { autoStart: false, ownsAuthority: false },
    lastEventSequence: 0,
    member: {
      credential: 'c'.repeat(43),
      displayName: 'Alice',
      id: MEMBER_ID,
      personalRef: `refs/heads/members/${MEMBER_ID}`,
      role: 'manager',
    },
    project: { id: PROJECT_ID, name: 'Membership', workspacePath: 'workspace/membership' },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: CREATED_AT,
  };
}

describe('LocalMembershipControlPort', () => {
  it('derives LAN responsibility identity from its binding and rejects another response target', async () => {
    let targetMemberId = MEMBER_ID;
    const received: unknown[] = [];
    const port = new LocalMembershipControlPort(membership(), {
      createClient: () => new MembershipControlClient({
        async requestWithMember(request, credential) {
          received.push({ body: request.body, credential });
          return request.decode({
            data: {
              acknowledgedAt: CREATED_AT,
              expiresAt: '2026-09-01T00:15:00.000Z',
              offeredAt: CREATED_AT,
              offerId: 'offer-one',
              purpose: 'manager-promotion',
              sourceManagerMemberId: 'member-source',
              status: 'acknowledged',
              targetMemberId,
            },
            protocolVersion: 9,
            requestId: 'acknowledge-response',
          });
        },
      }),
    });
    const intent = { idempotencyKey: 'acknowledge-one', offerId: 'offer-one', projectId: PROJECT_ID };
    await expect(port.membership('acknowledgeManagerResponsibility', intent))
      .resolves.toMatchObject({ offerId: 'offer-one', status: 'acknowledged', targetMemberId: MEMBER_ID });
    expect(received).toEqual([{
      body: { ...intent, expectedTargetMemberId: MEMBER_ID },
      credential: 'c'.repeat(43),
    }]);
    targetMemberId = 'member-other';
    await expect(port.membership('acknowledgeManagerResponsibility', intent))
      .rejects.toMatchObject({ code: 'protocol-payload-invalid' });
  });

  it('adapts a validated LAN role mutation to an authority-neutral completion', async () => {
    const received: unknown[] = [];
    const port = new LocalMembershipControlPort(membership(), {
      createClient: () => new MembershipControlClient({
        async requestWithMember(request, credential) {
          received.push({ body: request.body, credential, path: request.path });
          return request.decode({
            data: {
              demotedMemberId: 'member-peer',
              managerSetGeneration: 3,
              projectId: PROJECT_ID,
            },
            protocolVersion: 9,
            requestId: 'demote-response',
          });
        },
      }),
    });
    await expect(port.membership('demoteManager', {
      idempotencyKey: 'demote-one',
      projectId: PROJECT_ID,
      targetMemberId: 'member-peer',
    })).resolves.toBeUndefined();
    expect(received).toEqual([{
      body: {
        idempotencyKey: 'demote-one',
        projectId: PROJECT_ID,
        targetMemberId: 'member-peer',
      },
      credential: 'c'.repeat(43),
      path: '/v9/projects/project-membership-port/managers/member-peer/demote',
    }]);
  });
});
