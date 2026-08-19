import {
  COLLAB_MAIN_REF,
  COLLAB_MEMBER_REF_PREFIX,
} from '@claudian/collab-protocol';

const ORIGIN_REMOTE = 'origin';
const ORIGIN_TRACKING_PREFIX = `refs/remotes/${ORIGIN_REMOTE}/`;
const HEAD_REF_PREFIX = COLLAB_MAIN_REF.slice(0, COLLAB_MAIN_REF.lastIndexOf('/') + 1);

function collabBranchPath(ref: string, allowMemberPrefix = false): string {
  if (
    !ref.startsWith(HEAD_REF_PREFIX)
    || (
      ref !== COLLAB_MAIN_REF
      && (
        !ref.startsWith(COLLAB_MEMBER_REF_PREFIX)
        || (!allowMemberPrefix && ref === COLLAB_MEMBER_REF_PREFIX)
      )
    )
  ) {
    throw new RangeError('Invalid Collab branch ref');
  }
  return ref.slice(HEAD_REF_PREFIX.length);
}

export const COLLAB_ORIGIN_MAIN_REF = `${ORIGIN_TRACKING_PREFIX}${collabBranchPath(
  COLLAB_MAIN_REF,
)}`;

export const COLLAB_ORIGIN_MEMBER_REF_PREFIX = `${ORIGIN_TRACKING_PREFIX}${collabBranchPath(
  COLLAB_MEMBER_REF_PREFIX,
  true,
)}`;

export const COLLAB_MAIN_FETCH_REFSPEC = `+${COLLAB_MAIN_REF}:${COLLAB_ORIGIN_MAIN_REF}`;

export const COLLAB_MEMBERS_FETCH_REFSPEC = `+${COLLAB_MEMBER_REF_PREFIX}*:${COLLAB_ORIGIN_MEMBER_REF_PREFIX}*`;

export function collabOriginTrackingRef(ref: string): string {
  return `${ORIGIN_TRACKING_PREFIX}${collabBranchPath(ref)}`;
}

export function collabBranchName(ref: string): string {
  return collabBranchPath(ref);
}
