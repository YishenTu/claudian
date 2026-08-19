import {
  type CollabChangeRequest,
  type CollabChangedFile,
  type CollabComment,
  type CollabMember,
  collabMemberRef,
} from '../src/index';

describe('shared Collab domain types', () => {
  it('builds only safe personal refs', () => {
    expect(collabMemberRef('member_123')).toBe('refs/heads/members/member_123');
    expect(() => collabMemberRef('')).toThrow('Invalid Collab member ID');
    expect(() => collabMemberRef('../main')).toThrow('Invalid Collab member ID');
    expect(() => collabMemberRef('member/name')).toThrow('Invalid Collab member ID');
  });

  it('represents transport-neutral request, comment, member, and file projections', () => {
    const member: CollabMember = {
      activatedAt: '2026-08-07T00:00:01.000Z',
      createdAt: '2026-08-07T00:00:00.000Z',
      displayName: 'Alice',
      id: 'member_1',
      personalRef: 'refs/heads/members/member_1',
      role: 'manager',
      status: 'active',
    };
    const request: CollabChangeRequest = {
      commentCount: 1,
      createdAt: '2026-08-07T00:01:00.000Z',
      description: 'Resolves #1',
      firstBaseOid: '1'.repeat(40),
      id: 'request_1',
      latestHeadOid: '2'.repeat(40),
      memberId: member.id,
      revision: 1,
      status: 'open',
      ticketRelations: [],
      updatedAt: '2026-08-07T00:02:00.000Z',
    };
    const comment: CollabComment = {
      authorMemberId: member.id,
      body: 'Please clarify this section.',
      createdAt: '2026-08-07T00:02:00.000Z',
      id: 'comment_1',
      requestId: request.id,
    };
    const file: CollabChangedFile = {
      binary: false,
      kind: 'modified',
      largeForReview: false,
      path: 'notes/example.md',
    };

    expect(request.description).toBe('Resolves #1');
    expect(comment.body).toContain('clarify');
    expect(file).not.toHaveProperty('workingTreeContentHash');
  });
});
