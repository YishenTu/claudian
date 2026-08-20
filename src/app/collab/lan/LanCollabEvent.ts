import { type CollabProjectId, isCollabProjectId } from '@claudian/collab-protocol';

import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export const LAN_COLLAB_EVENT_KINDS = Object.freeze([
  'project-updated',
  'membership-updated',
  'request-updated',
  'comment-added',
  'ticket-updated',
  'ticket-comment-added',
  'main-updated',
  'invitation-updated',
  'host-state-updated',
  'host-updated',
  'project-retired',
  'snapshot-required',
] as const);

export type LanCollabEventKind = typeof LAN_COLLAB_EVENT_KINDS[number];

export interface LanCollabEvent {
  readonly protocolVersion: typeof COLLAB_CONTROL_PROTOCOL_VERSION;
  readonly projectId: CollabProjectId;
  readonly sequence: number;
  readonly kind: LanCollabEventKind;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type LanCollabEventDecodeResult =
  | { readonly status: 'event'; readonly event: LanCollabEvent }
  | {
    readonly status: 'snapshot-required';
    readonly projectId: CollabProjectId;
    readonly sequence: number;
    readonly unknownKind: string;
  }
  | { readonly status: 'invalid'; readonly error: CollabError };

function invalid(field: string): LanCollabEventDecodeResult {
  return {
    error: new CollabError({
      code: 'protocol-payload-invalid',
      safeContext: { field },
    }),
    status: 'invalid',
  };
}

export function decodeLanCollabEvent(input: unknown): LanCollabEventDecodeResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalid('event');
  const event = input as Readonly<Record<string, unknown>>;
  const expected = [
    'protocolVersion', 'projectId', 'sequence', 'kind', 'occurredAt', 'payload',
  ];
  if (
    Object.keys(event).length !== expected.length
    || !expected.every(key => Object.hasOwn(event, key))
    || event.protocolVersion !== COLLAB_CONTROL_PROTOCOL_VERSION
    || !isCollabProjectId(event.projectId)
    || typeof event.sequence !== 'number'
    || !Number.isSafeInteger(event.sequence)
    || event.sequence < 0
    || typeof event.kind !== 'string'
    || typeof event.occurredAt !== 'string'
    || Number.isNaN(Date.parse(event.occurredAt))
    || new Date(event.occurredAt).toISOString() !== event.occurredAt
    || !event.payload
    || typeof event.payload !== 'object'
    || Array.isArray(event.payload)
  ) return invalid('event');
  if (!(LAN_COLLAB_EVENT_KINDS as readonly string[]).includes(event.kind)) {
    return {
      projectId: event.projectId,
      sequence: event.sequence,
      status: 'snapshot-required',
      unknownKind: event.kind,
    };
  }
  return { status: 'event', event: event as unknown as LanCollabEvent };
}
