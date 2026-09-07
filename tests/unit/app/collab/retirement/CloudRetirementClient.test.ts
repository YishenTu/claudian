import type {
  CollabLocalCloudMembershipRecord,
} from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import {
  CloudRetirementClient,
} from '@/app/collab/retirement/CloudRetirementClient';

const PROJECT_ID = 'project-cloud-retire';
const RETIRED_AT = '2026-08-27T00:00:10.000Z';

function membership(): CollabLocalCloudMembershipRecord {
  return {
    authority: {
      authorityGeneration: 3,
      bindingVersion: 2,
      developmentActorId: 'member-manager',
      gitRemoteUrl: `https://cloud.example.test/v2/projects/${PROJECT_ID}/repository.git`,
      kind: 'cloud',
      serverUrl: 'https://cloud.example.test/',
      wireVersion: 6,
    },
    createdAt: '2026-08-27T00:00:00.000Z',
    lastEventSequence: 4,
    member: {
      displayName: 'Manager',
      id: 'member-manager',
      personalRef: 'refs/heads/members/member-manager',
      role: 'manager',
    },
    project: {
      id: PROJECT_ID,
      name: 'Cloud Retire',
      workspacePath: 'workspace/cloud-retire',
    },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: '2026-08-27T00:00:00.000Z',
  };
}

describe('CloudRetirementClient', () => {
  it('retires at the persisted authority generation without acknowledging before adoption', async () => {
    const retirement = jest.fn(async (operation: string) => {
      if (operation === 'retireProject') {
        return {
          acknowledgementRequired: true,
          kind: 'project-retired',
          projectId: PROJECT_ID,
          retiredAt: RETIRED_AT,
          retirementId: 'retirement-cloud',
          terminalExpiresAt: '2026-09-26T00:00:10.000Z',
        };
      }
      return {
        acknowledgedAt: '2026-08-27T00:00:11.000Z',
        idempotencyKey: 'retire-ack-retirement-cloud',
        projectId: PROJECT_ID,
        retirementId: 'retirement-cloud',
      };
    });
    const dispose = jest.fn();
    const client = new CloudRetirementClient({
      createLifecycle: async () => { throw new Error('not expected'); },
      createSession: async () => ({
        authorityKind: 'cloud',
        control: {
          readSnapshot: async () => ({
            currentMember: {
              displayName: 'Manager',
              id: 'member-manager',
              personalRef: 'refs/heads/members/member-manager',
              role: 'manager',
            },
            eventSequence: 4,
            members: [],
            openRequests: [],
            openTicketCount: 0,
            project: {
              authorityKind: 'cloud',
              createdAt: '2026-08-27T00:00:00.000Z',
              id: PROJECT_ID,
              mainOid: 'a'.repeat(40),
              mainRef: 'refs/heads/main',
              name: 'Cloud Retire',
            },
            ticketHighlights: [],
          }),
        },
        dispose,
        events: {},
        git: {},
        lifecycle: { retirement },
        supports: () => true,
      } as never),
    });

    await expect(client.retire(membership(), {
      expectedHostMemberId: 'member-manager',
      managerActorMemberId: 'member-manager',
      projectId: PROJECT_ID,
    })).resolves.toEqual({
      projectId: PROJECT_ID,
      retiredAt: RETIRED_AT,
      retirementId: 'retirement-cloud',
    });

    expect(retirement.mock.calls[0]).toEqual([
      'retireProject',
      expect.objectContaining({
        expectedAuthorityGeneration: 3,
        expectedMainOid: 'a'.repeat(40),
        projectId: PROJECT_ID,
      }),
      {},
    ]);
    expect(retirement).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('acknowledges from the minimal durable Cloud target', async () => {
    const retirement = jest.fn().mockResolvedValue({
      acknowledgedAt: '2026-08-27T00:00:11.000Z',
      idempotencyKey: 'retire-ack-cloud',
      projectId: PROJECT_ID,
      retirementId: 'retirement-cloud',
    });
    const dispose = jest.fn();
    const createLifecycle = jest.fn(async () => ({
      dispose,
      lifecycle: { retirement },
      supports: () => true,
    } as never));
    const client = new CloudRetirementClient({
      createLifecycle,
      createSession: async () => { throw new Error('not expected'); },
    });

    await client.acknowledge({
      developmentActorId: 'member-manager',
      projectId: PROJECT_ID,
      retirementId: 'retirement-cloud',
      serverUrl: 'https://cloud.example.test/',
    });

    expect(createLifecycle).toHaveBeenCalledWith({
      developmentActorId: 'member-manager',
      projectId: PROJECT_ID,
      retirementId: 'retirement-cloud',
      serverUrl: 'https://cloud.example.test/',
    });
    expect(retirement).toHaveBeenCalledWith(
      'acknowledgeProjectRetirement',
      {
        idempotencyKey: expect.stringMatching(/^retire-ack-[0-9a-f]{32}$/),
        projectId: PROJECT_ID,
        retirementId: 'retirement-cloud',
      },
      {},
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
