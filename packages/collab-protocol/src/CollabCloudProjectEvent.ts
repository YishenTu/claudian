import { COLLAB_LIMITS, COLLAB_PROTOCOL_VERSION } from './CollabConstants';
import { CollabError } from './CollabError';
import type {
  CollabGitOid,
  CollabIsoTimestamp,
  CollabMemberId,
  CollabProjectId,
  CollabRequestId,
  CollabTicketId,
} from './types';
import {
  hasUtf8ByteLengthAtMost,
  isCollabGitOid,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
} from './CollabValidation';

export const COLLAB_CLOUD_EVENT_KINDS = Object.freeze([
  'membership.updated',
  'request.updated',
  'request.comment-added',
  'ticket.updated',
  'ticket.comment-added',
  'main.updated',
] as const);

export type CollabCloudEventKind = typeof COLLAB_CLOUD_EVENT_KINDS[number];

export interface CollabCloudEventPayloadMap {
  readonly 'main.updated': {
    readonly mainOid: CollabGitOid;
    readonly requestId: CollabRequestId;
  };
  readonly 'membership.updated': { readonly memberId: CollabMemberId };
  readonly 'request.comment-added': { readonly requestId: CollabRequestId };
  readonly 'request.updated': { readonly requestId: CollabRequestId };
  readonly 'ticket.comment-added': { readonly ticketId: CollabTicketId };
  readonly 'ticket.updated': { readonly ticketId: CollabTicketId };
}

export type CollabCloudProjectEvent = {
  readonly [Kind in CollabCloudEventKind]: {
    readonly kind: Kind;
    readonly occurredAt: CollabIsoTimestamp;
    readonly payload: CollabCloudEventPayloadMap[Kind];
    readonly projectId: CollabProjectId;
    readonly protocolVersion: typeof COLLAB_PROTOCOL_VERSION;
    readonly sequence: number;
  }
}[CollabCloudEventKind];

export interface CollabCloudSnapshotRequired {
  readonly kind: 'snapshot.required';
  readonly latestSequence: number;
}

export type CollabCloudProjectEventMessage =
  | CollabCloudProjectEvent
  | CollabCloudSnapshotRequired;

type UnknownRecord = Readonly<Record<string, unknown>>;

const EVENT_KIND_SET: ReadonlySet<string> = new Set(COLLAB_CLOUD_EVENT_KINDS);

function invalidPayload(field: string): CollabError {
  return new CollabError({
    code: 'protocol-payload-invalid',
    safeContext: { field },
  });
}

function record(value: unknown, field: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidPayload(field);
  }
  return value as UnknownRecord;
}

function exactRecord(value: unknown, field: string, keys: readonly string[]): UnknownRecord {
  const source = record(value, field);
  const expected = new Set(keys);
  if (
    !keys.every(key => Object.hasOwn(source, key))
    || Object.keys(source).some(key => !expected.has(key))
  ) throw invalidPayload(field);
  return source;
}

function stringField(
  source: UnknownRecord,
  field: string,
  maximum: number,
  validate: (value: string) => boolean,
): string {
  const value = source[field];
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximum
    || !validate(value)
  ) throw invalidPayload(field);
  return value;
}

function nonNegativeInteger(source: UnknownRecord, field: string): number {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidPayload(field);
  }
  return value;
}

function positiveInteger(source: UnknownRecord, field: string): number {
  const value = nonNegativeInteger(source, field);
  if (value < 1) throw invalidPayload(field);
  return value;
}

function timestamp(source: UnknownRecord, field: string): CollabIsoTimestamp {
  const value = source[field];
  if (
    typeof value !== 'string'
    || value.length > 64
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) throw invalidPayload(field);
  return value;
}

function decodePayload(kind: CollabCloudEventKind, value: unknown): unknown {
  switch (kind) {
    case 'membership.updated': {
      const source = exactRecord(value, 'payload', ['memberId']);
      return { memberId: stringField(source, 'memberId', 64, isCollabMemberId) };
    }
    case 'request.updated':
    case 'request.comment-added': {
      const source = exactRecord(value, 'payload', ['requestId']);
      return { requestId: stringField(source, 'requestId', 128, isCollabOpaqueId) };
    }
    case 'ticket.updated':
    case 'ticket.comment-added': {
      const source = exactRecord(value, 'payload', ['ticketId']);
      return { ticketId: stringField(source, 'ticketId', 128, isCollabOpaqueId) };
    }
    case 'main.updated': {
      const source = exactRecord(value, 'payload', ['mainOid', 'requestId']);
      return {
        mainOid: stringField(source, 'mainOid', 64, isCollabGitOid),
        requestId: stringField(source, 'requestId', 128, isCollabOpaqueId),
      };
    }
  }
}

export function decodeCollabCloudProjectEventMessage(
  value: unknown,
): CollabCloudProjectEventMessage {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw invalidPayload('event');
  }
  if (!hasUtf8ByteLengthAtMost(serialized, COLLAB_LIMITS.maxJsonPayloadUtf8Bytes)) {
    throw invalidPayload('event');
  }
  const candidate = record(value, 'event');
  if (candidate.kind === 'snapshot.required') {
    const source = exactRecord(candidate, 'snapshot.required', ['kind', 'latestSequence']);
    return {
      kind: 'snapshot.required',
      latestSequence: nonNegativeInteger(source, 'latestSequence'),
    };
  }
  const source = exactRecord(candidate, 'event', [
    'kind',
    'occurredAt',
    'payload',
    'projectId',
    'protocolVersion',
    'sequence',
  ]);
  if (
    source.protocolVersion !== COLLAB_PROTOCOL_VERSION
    || typeof source.kind !== 'string'
    || !EVENT_KIND_SET.has(source.kind)
  ) throw invalidPayload('event');
  const kind = source.kind as CollabCloudEventKind;
  return {
    kind,
    occurredAt: timestamp(source, 'occurredAt'),
    payload: decodePayload(kind, source.payload),
    projectId: stringField(source, 'projectId', 64, isCollabProjectId),
    protocolVersion: COLLAB_PROTOCOL_VERSION,
    sequence: positiveInteger(source, 'sequence'),
  } as CollabCloudProjectEvent;
}
