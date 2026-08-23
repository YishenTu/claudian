import { COLLAB_LIMITS } from '@claudian-collab/protocol';

import {
  COLLAB_CONTROL_MAX_BODY_BYTES,
  COLLAB_CONTROL_ROUTE_PREFIX,
  COLLAB_HOST_PORT_RANGE,
  COLLAB_HOST_TRANSFER_PROTOCOL_VERSION,
  COLLAB_INVITATION_TTL_MS,
  COLLAB_PENDING_MEMBERSHIP_TTL_MS,
  COLLAB_TOKEN_BYTES,
} from '@/app/collab/lan/LanCollabConstants';

describe('LanCollabConstants', () => {
  it('freezes the LAN route prefix and Host port range', () => {
    expect(COLLAB_CONTROL_ROUTE_PREFIX).toBe('/v9/projects');
    expect(COLLAB_HOST_PORT_RANGE).toEqual({ first: 54545, last: 54564 });
  });

  it('freezes the LAN invitation and membership lifetimes', () => {
    expect(COLLAB_INVITATION_TTL_MS).toBe(15 * 60 * 1000);
    expect(COLLAB_PENDING_MEMBERSHIP_TTL_MS).toBe(30 * 60 * 1000);
    expect(COLLAB_TOKEN_BYTES).toBe(32);
    expect(COLLAB_CONTROL_MAX_BODY_BYTES).toBe(512 * 1024);
    expect(COLLAB_CONTROL_MAX_BODY_BYTES).toBe(COLLAB_LIMITS.maxJsonPayloadUtf8Bytes);
  });

  it('keeps the frozen Host-transfer recovery channel at v6', () => {
    expect(COLLAB_HOST_TRANSFER_PROTOCOL_VERSION).toBe(6);
  });

  it('carries every shared page and detail budget inside the LAN body cap', () => {
    // Envelope keys, requestId, and cursor strings ride on top of the
    // measured content; 4 KiB of headroom covers them.
    const envelopeHeadroom = 32 * 1024;
    for (const budget of [
      COLLAB_LIMITS.commentPageMaxUtf8Bytes,
      COLLAB_LIMITS.relationPageMaxUtf8Bytes,
      COLLAB_LIMITS.ticketPageMaxUtf8Bytes,
      COLLAB_LIMITS.detailMaxUtf8Bytes,
    ]) {
      expect(budget + envelopeHeadroom)
        .toBeLessThanOrEqual(COLLAB_CONTROL_MAX_BODY_BYTES);
    }
  });
});
