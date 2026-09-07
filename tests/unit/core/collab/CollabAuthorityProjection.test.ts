import { COLLAB_MAIN_REF } from '@claudian-collab/protocol';

import type {
  CollabProject,
  CollabProjectSnapshot,
} from '@/core/collab';

const CREATED_AT = '2026-08-22T00:00:00.000Z';
const MAIN_OID = 'a'.repeat(40);

function commonProject<AuthorityKind extends 'lan' | 'cloud'>(
  authorityKind: AuthorityKind,
) {
  return {
    authorityKind,
    createdAt: CREATED_AT,
    id: 'project-a',
    mainOid: MAIN_OID,
    mainRef: COLLAB_MAIN_REF,
    name: 'Project A',
  } as const;
}

describe('Collab authority projection', () => {
  it('keeps LAN lifecycle fields off Cloud Projects and snapshots', () => {
    const lan: CollabProject = {
      ...commonProject('lan'),
      hostMemberId: 'member-a',
      managerSetGeneration: 3,
    };
    const cloud: CollabProject = commonProject('cloud');

    expect(lan.authorityKind).toBe('lan');
    expect(cloud).toEqual({
      authorityKind: 'cloud',
      createdAt: CREATED_AT,
      id: 'project-a',
      mainOid: MAIN_OID,
      mainRef: COLLAB_MAIN_REF,
      name: 'Project A',
    });
    expect('hostMemberId' in cloud).toBe(false);
    expect('managerSetGeneration' in cloud).toBe(false);

    if (cloud.authorityKind === 'cloud') {
      // @ts-expect-error Cloud Projects cannot expose LAN Host identity.
      void cloud.hostMemberId;
      // @ts-expect-error Cloud Projects cannot expose LAN Manager generation.
      void cloud.managerSetGeneration;
    }
  });

  it('keeps LAN lifecycle extensions off Cloud snapshots', () => {
    const cloud: CollabProjectSnapshot = {
      currentMember: {
        activatedAt: CREATED_AT,
        createdAt: CREATED_AT,
        displayName: 'Member A',
        id: 'member-a',
        personalRef: 'refs/heads/members/member-a',
        role: 'manager',
        status: 'active',
      },
      eventSequence: 2,
      members: [],
      openRequests: [],
      openTicketCount: 0,
      project: commonProject('cloud'),
      ticketHighlights: [],
    };

    expect(cloud.project.authorityKind).toBe('cloud');
    expect('hostTransfer' in cloud).toBe(false);
    expect('managerResponsibilityOffer' in cloud).toBe(false);
  });
});
