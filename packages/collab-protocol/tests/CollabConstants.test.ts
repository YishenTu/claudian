import {
  COLLAB_LIMITS,
  COLLAB_MAIN_REF,
  COLLAB_MEMBER_REF_PREFIX,
  COLLAB_PROTOCOL_VERSION,
} from '../src/CollabConstants';

describe('CollabConstants', () => {
  it('freezes the wire protocol version', () => {
    expect(COLLAB_PROTOCOL_VERSION).toBe(4);
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
      maxMemberDisplayNameUtf16: 200,
      maxRequestDescriptionBytes: 16 * 1024,
      maxProjectNameUtf16: 200,
      maxTicketTitleUtf16: 200,
      maxTicketBodyBytes: 32 * 1024,
      maxTicketCommentBytes: 16 * 1024,
      maxRequestTicketRelations: 32,
      maxRequestComments: 500,
      defaultTicketPageSize: 50,
      maxTicketPageSize: 100,
      maxTicketComments: 500,
      maxTicketAcceptedRelations: 2_000,
      defaultCommentPageSize: 50,
      maxCommentPageSize: 100,
      commentPageMaxUtf8Bytes: 128 * 1024,
      maxRelationsPerPage: 100,
      relationPageMaxUtf8Bytes: 96 * 1024,
      ticketPageMaxUtf8Bytes: 96 * 1024,
      detailMaxUtf8Bytes: 448 * 1024,
      maxJsonPayloadUtf8Bytes: 512 * 1024,
      maxPageCursorUtf16: 512,
      maxPathSegmentUtf16: 120,
      maxRepositoryPathUtf16: 240,
    });
  });
});
