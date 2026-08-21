import {
  COLLAB_LIMITS,
  COLLAB_MAIN_REF,
} from './CollabConstants';
import { COLLAB_CLOUD_BINDING_LIMITS } from './CollabCloudBinding';
import { CollabError } from './CollabError';
import type { CollabDecodeResult } from './CollabProtocol';
import type {
  CollabChangeRequest,
  CollabGitOid,
  CollabIsoTimestamp,
  CollabMemberId,
  CollabProjectId,
  CollabRequestTicketRelation,
  CollabRole,
  CollabTicketSummary,
} from './types';
import { collabMemberRef } from './types';
import {
  hasUtf8ByteLengthAtMost,
  isCollabGitOid,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
} from './CollabValidation';

export interface CollabCloudProjectSummary {
  readonly createdAt: CollabIsoTimestamp;
  readonly expectedMainOid: CollabGitOid;
  readonly id: CollabProjectId;
  readonly mainRef: typeof COLLAB_MAIN_REF;
  readonly name: string;
}

export interface CollabCloudProjectMember {
  readonly activatedAt: CollabIsoTimestamp;
  readonly createdAt: CollabIsoTimestamp;
  readonly displayName: string;
  readonly id: CollabMemberId;
  readonly personalRef: string;
  readonly role: CollabRole;
  readonly status: 'active';
}

export interface CollabCloudProjectSnapshot {
  readonly currentMember: CollabCloudProjectMember;
  readonly eventSequence: number;
  readonly members: readonly CollabCloudProjectMember[];
  readonly openRequests: readonly CollabChangeRequest[];
  readonly openTicketCount: number;
  readonly project: CollabCloudProjectSummary;
  readonly ticketHighlights: readonly CollabTicketSummary[];
}

export interface GetCollabCloudProjectSnapshotRequest {
  readonly projectId: CollabProjectId;
}

export interface CollabCloudProjectSnapshotCodec {
  readonly decodeRequest: (
    value: unknown,
  ) => CollabDecodeResult<GetCollabCloudProjectSnapshotRequest>;
  readonly decodeResponse: (value: unknown) => CollabCloudProjectSnapshot;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

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

function exactRecord(
  value: unknown,
  field: string,
  required: readonly string[],
  optional: readonly string[] = [],
): UnknownRecord {
  const source = record(value, field);
  const allowed = new Set([...required, ...optional]);
  if (
    !required.every(key => Object.hasOwn(source, key))
    || Object.keys(source).some(key => !allowed.has(key))
  ) throw invalidPayload(field);
  return source;
}

function stringField(
  source: UnknownRecord,
  field: string,
  maximum: number,
  validate?: (value: string) => boolean,
  allowEmpty = false,
): string {
  const value = source[field];
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length === 0)
    || value.length > maximum
    || (validate && !validate(value))
  ) throw invalidPayload(field);
  return value;
}

function textUtf8(source: UnknownRecord, field: string, maximum: number): string {
  const value = source[field];
  if (
    typeof value !== 'string'
    || !hasUtf8ByteLengthAtMost(value, maximum)
  ) throw invalidPayload(field);
  return value;
}

function timestamp(source: UnknownRecord, field: string): CollabIsoTimestamp {
  const value = stringField(source, field, 64);
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw invalidPayload(field);
  }
  return value;
}

function nonNegativeInteger(source: UnknownRecord, field: string, maximum?: number): number {
  const value = source[field];
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || (maximum !== undefined && value > maximum)
  ) throw invalidPayload(field);
  return value;
}

function positiveInteger(source: UnknownRecord, field: string): number {
  const value = nonNegativeInteger(source, field);
  if (value < 1) throw invalidPayload(field);
  return value;
}

function decodeProject(value: unknown): CollabCloudProjectSummary {
  const source = exactRecord(value, 'project', [
    'createdAt',
    'expectedMainOid',
    'id',
    'mainRef',
    'name',
  ]);
  if (source.mainRef !== COLLAB_MAIN_REF) throw invalidPayload('mainRef');
  return {
    createdAt: timestamp(source, 'createdAt'),
    expectedMainOid: stringField(source, 'expectedMainOid', 64, isCollabGitOid),
    id: stringField(source, 'id', 64, isCollabProjectId),
    mainRef: COLLAB_MAIN_REF,
    name: stringField(source, 'name', COLLAB_LIMITS.maxProjectNameUtf16),
  };
}

function decodeMember(value: unknown): CollabCloudProjectMember {
  const source = exactRecord(value, 'member', [
    'activatedAt',
    'createdAt',
    'displayName',
    'id',
    'personalRef',
    'role',
    'status',
  ]);
  const id = stringField(source, 'id', 64, isCollabMemberId);
  if (
    source.status !== 'active'
    || (source.role !== 'manager' && source.role !== 'member')
  ) throw invalidPayload('member');
  const personalRef = stringField(source, 'personalRef', COLLAB_LIMITS.maxRepositoryPathUtf16);
  if (personalRef !== collabMemberRef(id)) throw invalidPayload('personalRef');
  return {
    activatedAt: timestamp(source, 'activatedAt'),
    createdAt: timestamp(source, 'createdAt'),
    displayName: stringField(source, 'displayName', COLLAB_LIMITS.maxMemberDisplayNameUtf16),
    id,
    personalRef,
    role: source.role,
    status: 'active',
  };
}

function decodeRequestTicketRelation(value: unknown): CollabRequestTicketRelation {
  const source = exactRecord(value, 'request.ticketRelations', [
    'commitOid',
    'id',
    'kind',
    'state',
    'ticketId',
    'ticketNumber',
    'ticketRevision',
    'ticketTitle',
  ]);
  if (
    (source.kind !== 'references' && source.kind !== 'resolves')
    || (source.state !== 'pending' && source.state !== 'accepted')
  ) throw invalidPayload('request.ticketRelations');
  return {
    commitOid: stringField(source, 'commitOid', 64, isCollabGitOid),
    id: stringField(source, 'id', 128, isCollabOpaqueId),
    kind: source.kind,
    state: source.state,
    ticketId: stringField(source, 'ticketId', 128, isCollabOpaqueId),
    ticketNumber: positiveInteger(source, 'ticketNumber'),
    ticketRevision: positiveInteger(source, 'ticketRevision'),
    ticketTitle: stringField(source, 'ticketTitle', COLLAB_LIMITS.maxTicketTitleUtf16),
  };
}

function decodeOpenRequest(value: unknown): CollabChangeRequest {
  const source = exactRecord(value, 'openRequest', [
    'commentCount',
    'createdAt',
    'description',
    'firstBaseOid',
    'id',
    'latestHeadOid',
    'memberId',
    'revision',
    'status',
    'ticketRelations',
    'updatedAt',
  ]);
  if (
    source.status !== 'open'
    || !Array.isArray(source.ticketRelations)
    || source.ticketRelations.length > COLLAB_LIMITS.maxRequestTicketRelations
  ) throw invalidPayload('openRequest');
  return {
    commentCount: nonNegativeInteger(
      source,
      'commentCount',
      COLLAB_LIMITS.maxRequestComments,
    ),
    createdAt: timestamp(source, 'createdAt'),
    description: textUtf8(source, 'description', COLLAB_LIMITS.maxRequestDescriptionBytes),
    firstBaseOid: stringField(source, 'firstBaseOid', 64, isCollabGitOid),
    id: stringField(source, 'id', 128, isCollabOpaqueId),
    latestHeadOid: stringField(source, 'latestHeadOid', 64, isCollabGitOid),
    memberId: stringField(source, 'memberId', 64, isCollabMemberId),
    revision: nonNegativeInteger(source, 'revision'),
    status: 'open',
    ticketRelations: source.ticketRelations.map(decodeRequestTicketRelation),
    updatedAt: timestamp(source, 'updatedAt'),
  };
}

function decodeOpenTicket(value: unknown): CollabTicketSummary {
  const source = exactRecord(value, 'ticketHighlight', [
    'acceptedRelationCount',
    'authorMemberId',
    'commentCount',
    'createdAt',
    'id',
    'number',
    'revision',
    'status',
    'title',
    'updatedAt',
  ]);
  if (source.status !== 'open') throw invalidPayload('ticketHighlight');
  return {
    acceptedRelationCount: nonNegativeInteger(
      source,
      'acceptedRelationCount',
      COLLAB_LIMITS.maxTicketAcceptedRelations,
    ),
    authorMemberId: stringField(source, 'authorMemberId', 64, isCollabMemberId),
    commentCount: nonNegativeInteger(
      source,
      'commentCount',
      COLLAB_LIMITS.maxTicketComments,
    ),
    createdAt: timestamp(source, 'createdAt'),
    id: stringField(source, 'id', 128, isCollabOpaqueId),
    number: positiveInteger(source, 'number'),
    revision: nonNegativeInteger(source, 'revision'),
    status: 'open',
    title: stringField(source, 'title', COLLAB_LIMITS.maxTicketTitleUtf16),
    updatedAt: timestamp(source, 'updatedAt'),
  };
}

function assertSnapshotSize(value: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw invalidPayload('snapshot');
  }
  if (!hasUtf8ByteLengthAtMost(
    serialized,
    COLLAB_CLOUD_BINDING_LIMITS.maxCloudSnapshotUtf8Bytes,
  )) throw invalidPayload('snapshot');
}

export function decodeCollabCloudProjectSnapshot(value: unknown): CollabCloudProjectSnapshot {
  assertSnapshotSize(value);
  const source = exactRecord(value, 'snapshot', [
    'currentMember',
    'eventSequence',
    'members',
    'openRequests',
    'openTicketCount',
    'project',
    'ticketHighlights',
  ]);
  if (
    !Array.isArray(source.members)
    || source.members.length < 1
    || source.members.length > COLLAB_CLOUD_BINDING_LIMITS.maxCloudProjectMembers
    || !Array.isArray(source.openRequests)
    || source.openRequests.length > COLLAB_CLOUD_BINDING_LIMITS.maxCloudOpenRequests
    || !Array.isArray(source.ticketHighlights)
    || source.ticketHighlights.length > COLLAB_CLOUD_BINDING_LIMITS.maxCloudTicketHighlights
  ) throw invalidPayload('snapshotCollections');
  const members = source.members.map(decodeMember);
  if (members.some((item, index) => (
    index > 0 && members[index - 1].id.localeCompare(item.id, 'en-US') >= 0
  ))) throw invalidPayload('members');
  const currentMember = decodeMember(source.currentMember);
  const matchingMember = members.find(member => member.id === currentMember.id);
  if (!matchingMember || JSON.stringify(matchingMember) !== JSON.stringify(currentMember)) {
    throw invalidPayload('currentMember');
  }
  const openRequests = source.openRequests.map(decodeOpenRequest);
  if (
    openRequests.some((item, index) => (
      (index > 0 && openRequests[index - 1].id.localeCompare(item.id, 'en-US') >= 0)
      || !members.some(member => member.id === item.memberId)
    ))
  ) throw invalidPayload('openRequests');
  const ticketHighlights = source.ticketHighlights.map(decodeOpenTicket);
  if (ticketHighlights.some((item, index) => {
    if (index === 0) return false;
    const previous = ticketHighlights[index - 1];
    return previous.updatedAt < item.updatedAt
      || (previous.updatedAt === item.updatedAt
        && previous.id.localeCompare(item.id, 'en-US') >= 0);
  })) throw invalidPayload('ticketHighlights');
  const openTicketCount = nonNegativeInteger(source, 'openTicketCount');
  if (openTicketCount < ticketHighlights.length) throw invalidPayload('openTicketCount');
  return {
    currentMember,
    eventSequence: nonNegativeInteger(source, 'eventSequence'),
    members,
    openRequests,
    openTicketCount,
    project: decodeProject(source.project),
    ticketHighlights,
  };
}

function decodeSnapshotRequest(
  value: unknown,
): CollabDecodeResult<GetCollabCloudProjectSnapshotRequest> {
  try {
    const source = exactRecord(value, 'request', ['projectId']);
    return {
      status: 'ok',
      value: { projectId: stringField(source, 'projectId', 64, isCollabProjectId) },
    };
  } catch (error) {
    return {
      status: 'invalid',
      error: error instanceof CollabError ? error : invalidPayload('request'),
    };
  }
}

export const COLLAB_CLOUD_PROJECT_SNAPSHOT_CODEC = Object.freeze({
  decodeRequest: decodeSnapshotRequest,
  decodeResponse: decodeCollabCloudProjectSnapshot,
} as const satisfies CollabCloudProjectSnapshotCodec);
