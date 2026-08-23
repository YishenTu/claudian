import { COLLAB_LIMITS as SHARED_COLLAB_LIMITS } from '@claudian-collab/protocol';

import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';

describe('ClaudianCollabConstants', () => {
  it('extends canonical limits with application-owned local policy', () => {
    expect(CLAUDIAN_COLLAB_LIMITS).toEqual({
      ...SHARED_COLLAB_LIMITS,
      hostRepositorySoftLimitBytes: 1024 * 1024 * 1024,
      maxCheckoutBytes: 500 * 1024 * 1024,
      maxReceivedPackBytes: 256 * 1024 * 1024,
      maxTextDiffBytes: 2 * 1024 * 1024,
      maxTextDiffLines: 20_000,
      maxRequestComments: 500,
      maxTicketAcceptedRelations: 2_000,
      maxTicketHighlights: 5,
    });
    expect(Object.isFrozen(CLAUDIAN_COLLAB_LIMITS)).toBe(true);
  });
});
