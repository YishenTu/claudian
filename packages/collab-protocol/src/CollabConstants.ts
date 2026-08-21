export const COLLAB_PROTOCOL_VERSION = 4 as const;

export const COLLAB_MAIN_REF = 'refs/heads/main' as const;
export const COLLAB_MEMBER_REF_PREFIX = 'refs/heads/members/' as const;

export const COLLAB_LIMITS = Object.freeze({
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

export type CollabProtocolVersion = typeof COLLAB_PROTOCOL_VERSION;
