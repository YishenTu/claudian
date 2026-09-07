import { COLLAB_LIMITS as SHARED_COLLAB_LIMITS } from '@claudian-collab/protocol';

/** Shared wire limits plus Claudian-owned checkout, diff, and LAN Host policy. */
export const CLAUDIAN_COLLAB_LIMITS = Object.freeze({
  ...SHARED_COLLAB_LIMITS,
  hostRepositorySoftLimitBytes: 1024 * 1024 * 1024,
  maxCheckoutBytes: 500 * 1024 * 1024,
  maxReceivedPackBytes: 256 * 1024 * 1024,
  maxTextDiffBytes: 2 * 1024 * 1024,
  maxTextDiffLines: 20_000,
  maxTicketHighlights: 5,
});
