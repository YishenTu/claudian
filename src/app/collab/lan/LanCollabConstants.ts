import { COLLAB_LIMITS } from '@claudian-collab/protocol';

export const COLLAB_CONTROL_PROTOCOL_VERSION = 9 as const;
export const COLLAB_CONTROL_ROUTE_PREFIX = `/v${COLLAB_CONTROL_PROTOCOL_VERSION}/projects` as const;

export const COLLAB_HOST_PORT_RANGE = Object.freeze({
  first: 54545,
  last: 54564,
});

export const COLLAB_INVITATION_TTL_MS = 15 * 60 * 1000;
export const COLLAB_PENDING_MEMBERSHIP_TTL_MS = 30 * 60 * 1000;
export const COLLAB_TOKEN_BYTES = 32;
export const COLLAB_CONTROL_MAX_BODY_BYTES = COLLAB_LIMITS.maxJsonPayloadUtf8Bytes;

export const COLLAB_HOST_TRANSFER_PROTOCOL_VERSION = 6 as const;
export type CollabHostTransferProtocolVersion =
  typeof COLLAB_HOST_TRANSFER_PROTOCOL_VERSION;
