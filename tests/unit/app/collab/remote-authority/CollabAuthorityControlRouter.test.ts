import {
  CollabProjectWorkSessionRegistry,
} from '@/app/collab/activity/CollabProjectWorkSession';
import { CollabAuthorityControlRouter } from '@/app/collab/remote-authority/CollabAuthorityControlRouter';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const PROJECT_ID = 'project-authority-router';

describe('CollabAuthorityControlRouter', () => {
  it('routes membership administration through the retained authority session and retries once', async () => {
    const sessions = new CollabProjectWorkSessionRegistry();
    const first = jest.fn().mockRejectedValue(new CollabError({
      code: 'endpoint-unreachable',
    }));
    const second = jest.fn().mockResolvedValue({
      encodedInvitation: 'claudian-collab:v2:invite-router',
      expiresAt: '2026-08-29T00:15:00.000Z',
    });
    const create = jest.fn()
      .mockResolvedValueOnce({
        authorityKind: 'lan',
        control: {},
        dispose: jest.fn(),
        events: {},
        git: { headers: [], remoteUrl: 'https://host.test/repository.git' },
        membership: { membership: first },
        supports: () => true,
      })
      .mockResolvedValueOnce({
        authorityKind: 'lan',
        control: {},
        dispose: jest.fn(),
        events: {},
        git: { headers: [], remoteUrl: 'https://host.test/repository.git' },
        membership: { membership: second },
        supports: () => true,
      });
    const reconnect = jest.fn(async () => {
      sessions.acquire(PROJECT_ID).resetProjection();
      return true;
    });
    const router = new CollabAuthorityControlRouter(
      { loadMembership: jest.fn().mockResolvedValue({ project: { id: PROJECT_ID } }) },
      sessions,
      { create } as never,
      { tryReconnect: reconnect },
    );

    await expect(router.membership('createInvitation', {
      idempotencyKey: 'create-invitation-router',
      projectId: PROJECT_ID,
    })).resolves.toEqual({
      encodedInvitation: 'claudian-collab:v2:invite-router',
      expiresAt: '2026-08-29T00:15:00.000Z',
    });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
  });
});
