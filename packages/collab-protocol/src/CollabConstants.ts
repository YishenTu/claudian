export const COLLAB_PROTOCOL_VERSION = 1 as const;

export const COLLAB_MAIN_REF = 'refs/heads/main' as const;
export const COLLAB_MEMBER_REF_PREFIX = 'refs/heads/members/' as const;

export const COLLAB_LIMITS = Object.freeze({
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

export type CollabProtocolVersion = typeof COLLAB_PROTOCOL_VERSION;
