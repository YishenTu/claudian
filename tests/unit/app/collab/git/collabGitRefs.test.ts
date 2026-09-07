import {
  COLLAB_MAIN_REF,
  collabMemberRef,
} from '@claudian-collab/protocol';

import {
  COLLAB_MAIN_FETCH_REFSPEC,
  COLLAB_MEMBERS_FETCH_REFSPEC,
  COLLAB_ORIGIN_MAIN_REF,
  COLLAB_ORIGIN_MEMBER_REF_PREFIX,
  collabBranchName,
  collabOriginTrackingRef,
} from '@/app/collab/git/collabGitRefs';

describe('collabGitRefs', () => {
  it('derives origin tracking refs and fetch refspecs from canonical protocol refs', () => {
    const memberRef = collabMemberRef('member_1');

    expect(COLLAB_ORIGIN_MAIN_REF).toBe('refs/remotes/origin/main');
    expect(COLLAB_ORIGIN_MEMBER_REF_PREFIX).toBe('refs/remotes/origin/members/');
    expect(COLLAB_MAIN_FETCH_REFSPEC)
      .toBe('+refs/heads/main:refs/remotes/origin/main');
    expect(COLLAB_MEMBERS_FETCH_REFSPEC)
      .toBe('+refs/heads/members/*:refs/remotes/origin/members/*');
    expect(collabOriginTrackingRef(memberRef))
      .toBe('refs/remotes/origin/members/member_1');
    expect(collabBranchName(COLLAB_MAIN_REF)).toBe('main');
    expect(collabBranchName(memberRef)).toBe('members/member_1');
  });

  it('rejects refs outside the protocol-owned Collab branches', () => {
    expect(() => collabOriginTrackingRef('refs/heads/members/'))
      .toThrow(new RangeError('Invalid Collab branch ref'));
    expect(() => collabOriginTrackingRef('refs/heads/other'))
      .toThrow(new RangeError('Invalid Collab branch ref'));
    expect(() => collabOriginTrackingRef('refs/tags/main'))
      .toThrow(new RangeError('Invalid Collab branch ref'));
  });
});
