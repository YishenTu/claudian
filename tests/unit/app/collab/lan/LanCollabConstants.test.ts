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
    expect(COLLAB_CONTROL_ROUTE_PREFIX).toBe('/v7/projects');
    expect(COLLAB_HOST_PORT_RANGE).toEqual({ first: 54545, last: 54564 });
  });

  it('freezes the LAN invitation and membership lifetimes', () => {
    expect(COLLAB_INVITATION_TTL_MS).toBe(15 * 60 * 1000);
    expect(COLLAB_PENDING_MEMBERSHIP_TTL_MS).toBe(30 * 60 * 1000);
    expect(COLLAB_TOKEN_BYTES).toBe(32);
    expect(COLLAB_CONTROL_MAX_BODY_BYTES).toBe(64 * 1024);
  });

  it('keeps the frozen Host-transfer recovery channel at v6', () => {
    expect(COLLAB_HOST_TRANSFER_PROTOCOL_VERSION).toBe(6);
  });
});
