import {
  COLLAB_LIMITS,
  COLLAB_MAIN_REF,
  COLLAB_MEMBER_REF_PREFIX,
  COLLAB_PROTOCOL_VERSION,
} from '../src/CollabConstants';

describe('CollabConstants', () => {
  it('freezes the wire protocol version', () => {
    expect(COLLAB_PROTOCOL_VERSION).toBe(1);
  });

  it('defines the protected and personal ref semantics', () => {
    expect(COLLAB_MAIN_REF).toBe('refs/heads/main');
    expect(COLLAB_MEMBER_REF_PREFIX).toBe('refs/heads/members/');
  });

  it('freezes the shared repository and review limits', () => {
    expect(COLLAB_LIMITS).toEqual({
      maxBlobBytes: 50 * 1024 * 1024,
      maxChangedPaths: 2_000,
      maxCommentBytes: 16 * 1024,
      maxRequestDescriptionBytes: 16 * 1024,
      maxTicketTitleUtf16: 200,
      maxTicketBodyBytes: 32 * 1024,
      maxTicketCommentBytes: 16 * 1024,
      maxRequestTicketRelations: 32,
      defaultTicketPageSize: 50,
      maxTicketPageSize: 100,
      maxTicketComments: 500,
      maxPathSegmentUtf16: 120,
      maxRepositoryPathUtf16: 240,
    });
  });
});
