import {
  COLLAB_LIMITS,
  COLLAB_MAIN_REF,
  COLLAB_PROTOCOL_VERSION,
  type CollabProtocolVersion,
} from './CollabConstants';
import {
  COLLAB_CLOUD_BINDING_LIMITS,
  type DevelopmentBootstrapOperation,
} from './CollabCloudBinding';
import { CollabError } from './CollabError';
import type { CollabDecodeResult } from './CollabProtocol';
import type {
  CollabGitOid,
  CollabIsoTimestamp,
  CollabMemberId,
  CollabOperationId,
  CollabProjectId,
  CollabRole,
} from './types';
import { collabMemberRef } from './types';
import {
  hasUtf8ByteLengthAtMost,
  isCollabGitOid,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
} from './CollabValidation';

export const DEVELOPMENT_BOOTSTRAP_MANIFEST_SCHEMA_VERSION = 1 as const;

export const DEVELOPMENT_BOOTSTRAP_ATTEMPT_STATES = Object.freeze([
  'collecting',
  'validating',
  'ready',
  'activating',
  'rejected',
  'cancelled',
  'recovery-required',
  'activated',
] as const);

export const DEVELOPMENT_BOOTSTRAP_ACTIVATION_PHASES = Object.freeze([
  'publish-intent',
  'repository-published',
  'activated',
  'completed',
] as const);

export const DEVELOPMENT_BOOTSTRAP_CANCELLATION_PHASES = Object.freeze([
  'cancel-intent',
  'cancelled',
  'recovery-required',
] as const);

export const DEVELOPMENT_BOOTSTRAP_OPERATIONS = Object.freeze([
  'beginDevelopmentBootstrap',
  'submitDevelopmentBootstrapReport',
  'getDevelopmentBootstrap',
  'activateDevelopmentBootstrap',
  'cancelDevelopmentBootstrap',
  'putDevelopmentBootstrapGitBundle',
] as const satisfies readonly DevelopmentBootstrapOperation[]);

export type DevelopmentBootstrapAttemptState =
  typeof DEVELOPMENT_BOOTSTRAP_ATTEMPT_STATES[number];
export type DevelopmentBootstrapActivationPhase =
  typeof DEVELOPMENT_BOOTSTRAP_ACTIVATION_PHASES[number];
export type DevelopmentBootstrapCancellationPhase =
  typeof DEVELOPMENT_BOOTSTRAP_CANCELLATION_PHASES[number];
export type DevelopmentBootstrapBundleState = 'missing' | 'uploaded' | 'validated';
export type DevelopmentBootstrapObjectFormat = 'sha1' | 'sha256';

export interface DevelopmentBootstrapComparisonMember {
  readonly activatedAt: CollabIsoTimestamp;
  readonly createdAt: CollabIsoTimestamp;
  readonly displayName: string;
  readonly memberId: CollabMemberId;
  readonly personalRef: string;
  readonly role: CollabRole;
  readonly status: 'active';
}

export interface DevelopmentBootstrapComparison {
  readonly mainOid: CollabGitOid;
  readonly mainRef: typeof COLLAB_MAIN_REF;
  readonly managerSetGeneration: number;
  readonly members: readonly [
    DevelopmentBootstrapComparisonMember,
    DevelopmentBootstrapComparisonMember,
  ];
  readonly projectCreatedAt: CollabIsoTimestamp;
  readonly projectId: CollabProjectId;
  readonly projectName: string;
  readonly sourceCaFingerprint: string;
  readonly sourceEventSequence: number;
  readonly sourceHostMemberId: CollabMemberId;
}

export interface DevelopmentBootstrapSourceEligibility {
  readonly liveInvitations: 0;
  readonly nonActiveMemberships: 0;
  readonly nonterminalAcceptOperations: 0;
  readonly nonterminalHostTransfers: 0;
  readonly nonterminalManagerOffers: 0;
  readonly requestComments: 0;
  readonly requests: 0;
  readonly terminalProjectTransitions: 0;
  readonly ticketComments: 0;
  readonly ticketMentions: 0;
  readonly ticketRelations: 0;
  readonly tickets: 0;
}

export interface DevelopmentBootstrapGitRef {
  readonly name: string;
  readonly oid: CollabGitOid;
}

export interface DevelopmentBootstrapManifest {
  readonly attemptId: string;
  readonly comparison: DevelopmentBootstrapComparison;
  readonly createdAt: CollabIsoTimestamp;
  readonly git: {
    readonly bundle: {
      readonly byteCount: number;
      readonly sha256: string;
    };
    readonly objectFormat: DevelopmentBootstrapObjectFormat;
    readonly refs: readonly DevelopmentBootstrapGitRef[];
  };
  readonly manifestSchemaVersion: typeof DEVELOPMENT_BOOTSTRAP_MANIFEST_SCHEMA_VERSION;
  readonly protocolVersion: CollabProtocolVersion;
  readonly sourceEligibility: DevelopmentBootstrapSourceEligibility;
}

export interface DevelopmentBootstrapClientReadiness {
  readonly cleanupSettled: true;
  readonly collabGitChildrenDrained: true;
  readonly conflictRecoverySettled: true;
  readonly hostTransferSettled: true;
  readonly joinSettled: true;
  readonly leaveSettled: true;
  readonly managerResponsibilitySettled: true;
  readonly projectOperationQueueDrained: true;
  readonly projectSetupSettled: true;
  readonly projectWorkSessionClosed: true;
  readonly publishSettled: true;
  readonly reconciliationSettled: true;
  readonly reconnectSettled: true;
  readonly repositoryIdentityExact: true;
  readonly retirementSettled: true;
}

export interface DevelopmentHostStopAttestation {
  readonly attemptId: string;
  readonly autoStartDisabled: true;
  readonly fenceDurable: true;
  readonly fenceId: string;
  readonly hostStopped: true;
  readonly manifestSha256: string;
  readonly projectId: CollabProjectId;
  readonly resourcesDrained: true;
  readonly routeUnregistered: true;
  readonly stoppedAt: CollabIsoTimestamp;
}

export interface DevelopmentBootstrapReport {
  readonly attemptId: string;
  readonly capturedAt: CollabIsoTimestamp;
  readonly clientReadiness: DevelopmentBootstrapClientReadiness;
  readonly comparison: DevelopmentBootstrapComparison;
  readonly hostStopAttestation?: DevelopmentHostStopAttestation;
  readonly observedPersonalRefOid: CollabGitOid;
  readonly reporterMemberId: CollabMemberId;
}

export interface DevelopmentBootstrapActivationResult {
  readonly activatedAt: CollabIsoTimestamp;
  readonly activationOperationId: CollabOperationId;
  readonly placementGeneration: number;
  readonly projectId: CollabProjectId;
}

export interface DevelopmentBootstrapAttemptStatus {
  readonly activationPhase?: DevelopmentBootstrapActivationPhase;
  readonly activationResult?: DevelopmentBootstrapActivationResult;
  readonly attemptId: string;
  readonly bundleState: DevelopmentBootstrapBundleState;
  readonly cancellationPhase?: DevelopmentBootstrapCancellationPhase;
  readonly createdAt: CollabIsoTimestamp;
  readonly expiresAt: CollabIsoTimestamp;
  readonly manifestSha256: string;
  readonly projectId: CollabProjectId;
  readonly reporterMemberIds: readonly CollabMemberId[];
  readonly state: DevelopmentBootstrapAttemptState;
}

export interface BeginDevelopmentBootstrapRequest {
  readonly manifest: DevelopmentBootstrapManifest;
}

export interface SubmitDevelopmentBootstrapReportRequest {
  readonly attemptId: string;
  readonly report: DevelopmentBootstrapReport;
}

export interface GetDevelopmentBootstrapRequest {
  readonly attemptId: string;
}

export interface ActivateDevelopmentBootstrapRequest {
  readonly attemptId: string;
  readonly manifestSha256: string;
}

export interface CancelDevelopmentBootstrapRequest {
  readonly attemptId: string;
}

export interface PutDevelopmentBootstrapGitBundleRequest {
  readonly attemptId: string;
  readonly byteCount: number;
  readonly contentEncoding: 'identity';
  readonly contentType: 'application/x-git-bundle';
  readonly sha256: string;
}

export interface DevelopmentBootstrapOperationMap {
  readonly activateDevelopmentBootstrap: {
    readonly request: ActivateDevelopmentBootstrapRequest;
    readonly response: DevelopmentBootstrapAttemptStatus;
  };
  readonly beginDevelopmentBootstrap: {
    readonly request: BeginDevelopmentBootstrapRequest;
    readonly response: DevelopmentBootstrapAttemptStatus;
  };
  readonly cancelDevelopmentBootstrap: {
    readonly request: CancelDevelopmentBootstrapRequest;
    readonly response: DevelopmentBootstrapAttemptStatus;
  };
  readonly getDevelopmentBootstrap: {
    readonly request: GetDevelopmentBootstrapRequest;
    readonly response: DevelopmentBootstrapAttemptStatus;
  };
  readonly putDevelopmentBootstrapGitBundle: {
    readonly request: PutDevelopmentBootstrapGitBundleRequest;
    readonly response: DevelopmentBootstrapAttemptStatus;
  };
  readonly submitDevelopmentBootstrapReport: {
    readonly request: SubmitDevelopmentBootstrapReportRequest;
    readonly response: DevelopmentBootstrapAttemptStatus;
  };
}

export interface DevelopmentBootstrapOperationCodec<Request, Response> {
  readonly decodeRequest: (value: unknown) => CollabDecodeResult<Request>;
  readonly decodeResponse: (value: unknown) => Response;
}

type UnknownRecord = Readonly<Record<string, unknown>>;
type DevelopmentBootstrapCodecMap = {
  readonly [Operation in DevelopmentBootstrapOperation]:
  DevelopmentBootstrapOperationCodec<
    DevelopmentBootstrapOperationMap[Operation]['request'],
    DevelopmentBootstrapOperationMap[Operation]['response']
  >;
};

const ATTEMPT_STATE_SET: ReadonlySet<string> = new Set(DEVELOPMENT_BOOTSTRAP_ATTEMPT_STATES);
const ACTIVATION_PHASE_SET: ReadonlySet<string> = new Set(DEVELOPMENT_BOOTSTRAP_ACTIVATION_PHASES);
const CANCELLATION_PHASE_SET: ReadonlySet<string> = new Set(DEVELOPMENT_BOOTSTRAP_CANCELLATION_PHASES);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

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

function exactRecordWithOptional(
  value: unknown,
  field: string,
  required: readonly string[],
  optional: readonly string[],
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
): string {
  const value = source[field];
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximum
    || (validate && !validate(value))
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

function nonNegativeInteger(source: UnknownRecord, field: string): number {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalidPayload(field);
  }
  return value;
}

function positiveInteger(source: UnknownRecord, field: string, maximum?: number): number {
  const value = nonNegativeInteger(source, field);
  if (value < 1 || (maximum !== undefined && value > maximum)) {
    throw invalidPayload(field);
  }
  return value;
}

function exactTrue(source: UnknownRecord, field: string): true {
  if (source[field] !== true) throw invalidPayload(field);
  return true;
}

function sha256(source: UnknownRecord, field: string): string {
  return stringField(source, field, 64, value => SHA256_PATTERN.test(value));
}

function assertSerializedLimit(value: unknown, maximum: number, field: string): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw invalidPayload(field);
  }
  if (!hasUtf8ByteLengthAtMost(serialized, maximum)) throw invalidPayload(field);
}

function decodeComparisonMember(value: unknown): DevelopmentBootstrapComparisonMember {
  const source = exactRecord(value, 'comparison.members', [
    'activatedAt',
    'createdAt',
    'displayName',
    'memberId',
    'personalRef',
    'role',
    'status',
  ]);
  const memberId = stringField(source, 'memberId', 64, isCollabMemberId);
  const role = source.role;
  if (role !== 'manager' && role !== 'member') throw invalidPayload('role');
  if (source.status !== 'active') throw invalidPayload('status');
  const personalRef = stringField(source, 'personalRef', COLLAB_LIMITS.maxRepositoryPathUtf16);
  if (personalRef !== collabMemberRef(memberId)) throw invalidPayload('personalRef');
  return {
    activatedAt: timestamp(source, 'activatedAt'),
    createdAt: timestamp(source, 'createdAt'),
    displayName: stringField(source, 'displayName', COLLAB_LIMITS.maxMemberDisplayNameUtf16),
    memberId,
    personalRef,
    role,
    status: 'active',
  };
}

function decodeComparison(value: unknown): DevelopmentBootstrapComparison {
  const source = exactRecord(value, 'comparison', [
    'mainOid',
    'mainRef',
    'managerSetGeneration',
    'members',
    'projectCreatedAt',
    'projectId',
    'projectName',
    'sourceCaFingerprint',
    'sourceEventSequence',
    'sourceHostMemberId',
  ]);
  if (!Array.isArray(source.members) || source.members.length !== 2) {
    throw invalidPayload('members');
  }
  const members = source.members.map(decodeComparisonMember) as [
    DevelopmentBootstrapComparisonMember,
    DevelopmentBootstrapComparisonMember,
  ];
  if (
    members[0].memberId.localeCompare(members[1].memberId, 'en-US') >= 0
    || !members.some(member => member.role === 'manager')
  ) throw invalidPayload('members');
  const sourceHostMemberId = stringField(
    source,
    'sourceHostMemberId',
    64,
    isCollabMemberId,
  );
  if (!members.some(member => member.memberId === sourceHostMemberId)) {
    throw invalidPayload('sourceHostMemberId');
  }
  if (source.mainRef !== COLLAB_MAIN_REF) throw invalidPayload('mainRef');
  return {
    mainOid: stringField(source, 'mainOid', 64, isCollabGitOid),
    mainRef: COLLAB_MAIN_REF,
    managerSetGeneration: nonNegativeInteger(source, 'managerSetGeneration'),
    members,
    projectCreatedAt: timestamp(source, 'projectCreatedAt'),
    projectId: stringField(source, 'projectId', 64, isCollabProjectId),
    projectName: stringField(source, 'projectName', COLLAB_LIMITS.maxProjectNameUtf16),
    sourceCaFingerprint: stringField(
      source,
      'sourceCaFingerprint',
      64,
      candidate => SHA256_PATTERN.test(candidate),
    ),
    sourceEventSequence: nonNegativeInteger(source, 'sourceEventSequence'),
    sourceHostMemberId,
  };
}

function decodeSourceEligibility(value: unknown): DevelopmentBootstrapSourceEligibility {
  const keys = [
    'liveInvitations',
    'nonActiveMemberships',
    'nonterminalAcceptOperations',
    'nonterminalHostTransfers',
    'nonterminalManagerOffers',
    'requestComments',
    'requests',
    'terminalProjectTransitions',
    'ticketComments',
    'ticketMentions',
    'ticketRelations',
    'tickets',
  ] as const;
  const source = exactRecord(value, 'sourceEligibility', keys);
  if (keys.some(key => source[key] !== 0)) throw invalidPayload('sourceEligibility');
  return {
    liveInvitations: 0,
    nonActiveMemberships: 0,
    nonterminalAcceptOperations: 0,
    nonterminalHostTransfers: 0,
    nonterminalManagerOffers: 0,
    requestComments: 0,
    requests: 0,
    terminalProjectTransitions: 0,
    ticketComments: 0,
    ticketMentions: 0,
    ticketRelations: 0,
    tickets: 0,
  };
}

function decodeGit(
  value: unknown,
  comparison: DevelopmentBootstrapComparison,
): DevelopmentBootstrapManifest['git'] {
  const source = exactRecord(value, 'git', ['bundle', 'objectFormat', 'refs']);
  if (source.objectFormat !== 'sha1' && source.objectFormat !== 'sha256') {
    throw invalidPayload('objectFormat');
  }
  const objectFormat = source.objectFormat;
  const bundleSource = exactRecord(source.bundle, 'bundle', ['byteCount', 'sha256']);
  if (!Array.isArray(source.refs) || source.refs.length !== 3) throw invalidPayload('refs');
  const refs = source.refs.map((item): DevelopmentBootstrapGitRef => {
    const ref = exactRecord(item, 'refs', ['name', 'oid']);
    const oid = stringField(ref, 'oid', 64, isCollabGitOid);
    if (oid.length !== (objectFormat === 'sha1' ? 40 : 64)) throw invalidPayload('oid');
    return {
      name: stringField(ref, 'name', COLLAB_LIMITS.maxRepositoryPathUtf16),
      oid,
    };
  });
  if (
    refs.some((item, index) => (
      index > 0 && refs[index - 1].name.localeCompare(item.name, 'en-US') >= 0
    ))
  ) throw invalidPayload('refs');
  const expectedNames = [
    COLLAB_MAIN_REF,
    ...comparison.members.map(member => member.personalRef),
  ].sort((left, right) => left.localeCompare(right, 'en-US'));
  if (
    refs.some((item, index) => item.name !== expectedNames[index])
    || refs.find(item => item.name === COLLAB_MAIN_REF)?.oid !== comparison.mainOid
  ) throw invalidPayload('refs');
  return {
    bundle: {
      byteCount: positiveInteger(
        bundleSource,
        'byteCount',
        COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapGitBundleBytes,
      ),
      sha256: sha256(bundleSource, 'sha256'),
    },
    objectFormat,
    refs,
  };
}

export function decodeDevelopmentBootstrapManifest(
  value: unknown,
): DevelopmentBootstrapManifest {
  assertSerializedLimit(
    value,
    COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapManifestUtf8Bytes,
    'manifest',
  );
  const source = exactRecord(value, 'manifest', [
    'attemptId',
    'comparison',
    'createdAt',
    'git',
    'manifestSchemaVersion',
    'protocolVersion',
    'sourceEligibility',
  ]);
  if (
    source.manifestSchemaVersion !== DEVELOPMENT_BOOTSTRAP_MANIFEST_SCHEMA_VERSION
    || source.protocolVersion !== COLLAB_PROTOCOL_VERSION
  ) throw invalidPayload('manifestVersion');
  const comparison = decodeComparison(source.comparison);
  return {
    attemptId: stringField(source, 'attemptId', 128, isCollabOpaqueId),
    comparison,
    createdAt: timestamp(source, 'createdAt'),
    git: decodeGit(source.git, comparison),
    manifestSchemaVersion: DEVELOPMENT_BOOTSTRAP_MANIFEST_SCHEMA_VERSION,
    protocolVersion: COLLAB_PROTOCOL_VERSION,
    sourceEligibility: decodeSourceEligibility(source.sourceEligibility),
  };
}

export function encodeDevelopmentBootstrapManifestCanonicalJson(
  value: DevelopmentBootstrapManifest,
): string {
  return JSON.stringify(decodeDevelopmentBootstrapManifest(value));
}

function decodeClientReadiness(value: unknown): DevelopmentBootstrapClientReadiness {
  const keys = [
    'cleanupSettled',
    'collabGitChildrenDrained',
    'conflictRecoverySettled',
    'hostTransferSettled',
    'joinSettled',
    'leaveSettled',
    'managerResponsibilitySettled',
    'projectOperationQueueDrained',
    'projectSetupSettled',
    'projectWorkSessionClosed',
    'publishSettled',
    'reconciliationSettled',
    'reconnectSettled',
    'repositoryIdentityExact',
    'retirementSettled',
  ] as const;
  const source = exactRecord(value, 'clientReadiness', keys);
  const result = Object.fromEntries(keys.map(key => [key, exactTrue(source, key)]));
  return result as unknown as DevelopmentBootstrapClientReadiness;
}

function decodeHostStopAttestation(
  value: unknown,
  attemptId: string,
  projectId: string,
): DevelopmentHostStopAttestation {
  const source = exactRecord(value, 'hostStopAttestation', [
    'attemptId',
    'autoStartDisabled',
    'fenceDurable',
    'fenceId',
    'hostStopped',
    'manifestSha256',
    'projectId',
    'resourcesDrained',
    'routeUnregistered',
    'stoppedAt',
  ]);
  const decodedAttemptId = stringField(source, 'attemptId', 128, isCollabOpaqueId);
  const decodedProjectId = stringField(source, 'projectId', 64, isCollabProjectId);
  if (decodedAttemptId !== attemptId || decodedProjectId !== projectId) {
    throw invalidPayload('hostStopAttestation');
  }
  return {
    attemptId: decodedAttemptId,
    autoStartDisabled: exactTrue(source, 'autoStartDisabled'),
    fenceDurable: exactTrue(source, 'fenceDurable'),
    fenceId: stringField(source, 'fenceId', 128, isCollabOpaqueId),
    hostStopped: exactTrue(source, 'hostStopped'),
    manifestSha256: sha256(source, 'manifestSha256'),
    projectId: decodedProjectId,
    resourcesDrained: exactTrue(source, 'resourcesDrained'),
    routeUnregistered: exactTrue(source, 'routeUnregistered'),
    stoppedAt: timestamp(source, 'stoppedAt'),
  };
}

export function decodeDevelopmentBootstrapReport(value: unknown): DevelopmentBootstrapReport {
  assertSerializedLimit(
    value,
    COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapReportUtf8Bytes,
    'report',
  );
  const source = exactRecordWithOptional(value, 'report', [
    'attemptId',
    'capturedAt',
    'clientReadiness',
    'comparison',
    'observedPersonalRefOid',
    'reporterMemberId',
  ], ['hostStopAttestation']);
  const attemptId = stringField(source, 'attemptId', 128, isCollabOpaqueId);
  const comparison = decodeComparison(source.comparison);
  const reporterMemberId = stringField(source, 'reporterMemberId', 64, isCollabMemberId);
  if (!comparison.members.some(member => member.memberId === reporterMemberId)) {
    throw invalidPayload('reporterMemberId');
  }
  const isHost = reporterMemberId === comparison.sourceHostMemberId;
  if (isHost !== Object.hasOwn(source, 'hostStopAttestation')) {
    throw invalidPayload('hostStopAttestation');
  }
  const hostStopAttestation = isHost
    ? decodeHostStopAttestation(
      source.hostStopAttestation,
      attemptId,
      comparison.projectId,
    )
    : undefined;
  return {
    attemptId,
    capturedAt: timestamp(source, 'capturedAt'),
    clientReadiness: decodeClientReadiness(source.clientReadiness),
    comparison,
    ...(hostStopAttestation ? { hostStopAttestation } : {}),
    observedPersonalRefOid: stringField(
      source,
      'observedPersonalRefOid',
      64,
      isCollabGitOid,
    ),
    reporterMemberId,
  };
}

function decodeActivationResult(value: unknown): DevelopmentBootstrapActivationResult {
  const source = exactRecord(value, 'activationResult', [
    'activatedAt',
    'activationOperationId',
    'placementGeneration',
    'projectId',
  ]);
  return {
    activatedAt: timestamp(source, 'activatedAt'),
    activationOperationId: stringField(
      source,
      'activationOperationId',
      128,
      isCollabOpaqueId,
    ),
    placementGeneration: positiveInteger(source, 'placementGeneration'),
    projectId: stringField(source, 'projectId', 64, isCollabProjectId),
  };
}

function decodeAttemptStatus(value: unknown): DevelopmentBootstrapAttemptStatus {
  const source = exactRecordWithOptional(value, 'attempt', [
    'attemptId',
    'bundleState',
    'createdAt',
    'expiresAt',
    'manifestSha256',
    'projectId',
    'reporterMemberIds',
    'state',
  ], ['activationPhase', 'activationResult', 'cancellationPhase']);
  if (typeof source.state !== 'string' || !ATTEMPT_STATE_SET.has(source.state)) {
    throw invalidPayload('state');
  }
  if (
    source.bundleState !== 'missing'
    && source.bundleState !== 'uploaded'
    && source.bundleState !== 'validated'
  ) throw invalidPayload('bundleState');
  if (!Array.isArray(source.reporterMemberIds) || source.reporterMemberIds.length > 2) {
    throw invalidPayload('reporterMemberIds');
  }
  const reporterMemberIds = source.reporterMemberIds.map((item) => {
    if (!isCollabMemberId(item)) throw invalidPayload('reporterMemberIds');
    return item;
  });
  if (reporterMemberIds.some((item, index) => (
    index > 0 && reporterMemberIds[index - 1].localeCompare(item, 'en-US') >= 0
  ))) throw invalidPayload('reporterMemberIds');
  const activationPhase = source.activationPhase;
  const cancellationPhase = source.cancellationPhase;
  if (
    activationPhase !== undefined
    && (typeof activationPhase !== 'string' || !ACTIVATION_PHASE_SET.has(activationPhase))
  ) throw invalidPayload('activationPhase');
  if (
    cancellationPhase !== undefined
    && (typeof cancellationPhase !== 'string' || !CANCELLATION_PHASE_SET.has(cancellationPhase))
  ) throw invalidPayload('cancellationPhase');
  const activationResult = source.activationResult === undefined
    ? undefined
    : decodeActivationResult(source.activationResult);
  const projectId = stringField(source, 'projectId', 64, isCollabProjectId);
  if (
    source.state === 'activated'
    && (
      (activationPhase !== 'activated' && activationPhase !== 'completed')
      || activationResult === undefined
    )
  ) throw invalidPayload('activationResult');
  if (
    source.state !== 'activated'
    && activationResult !== undefined
  ) throw invalidPayload('activationResult');
  if (activationPhase !== undefined && cancellationPhase !== undefined) {
    throw invalidPayload('attemptPhase');
  }
  if (activationResult !== undefined && activationResult.projectId !== projectId) {
    throw invalidPayload('activationResult');
  }
  return {
    ...(activationPhase
      ? { activationPhase: activationPhase as DevelopmentBootstrapActivationPhase }
      : {}),
    ...(activationResult ? { activationResult } : {}),
    attemptId: stringField(source, 'attemptId', 128, isCollabOpaqueId),
    bundleState: source.bundleState,
    ...(cancellationPhase
      ? { cancellationPhase: cancellationPhase as DevelopmentBootstrapCancellationPhase }
      : {}),
    createdAt: timestamp(source, 'createdAt'),
    expiresAt: timestamp(source, 'expiresAt'),
    manifestSha256: sha256(source, 'manifestSha256'),
    projectId,
    reporterMemberIds,
    state: source.state as DevelopmentBootstrapAttemptState,
  };
}

function decodeAttemptOnlyRequest(value: unknown): GetDevelopmentBootstrapRequest {
  const source = exactRecord(value, 'request', ['attemptId']);
  return { attemptId: stringField(source, 'attemptId', 128, isCollabOpaqueId) };
}

function decodeOperationRequest(
  operation: DevelopmentBootstrapOperation,
  value: unknown,
): DevelopmentBootstrapOperationMap[DevelopmentBootstrapOperation]['request'] {
  switch (operation) {
    case 'beginDevelopmentBootstrap': {
      const source = exactRecord(value, 'request', ['manifest']);
      return { manifest: decodeDevelopmentBootstrapManifest(source.manifest) };
    }
    case 'submitDevelopmentBootstrapReport': {
      const source = exactRecord(value, 'request', ['attemptId', 'report']);
      const attemptId = stringField(source, 'attemptId', 128, isCollabOpaqueId);
      const report = decodeDevelopmentBootstrapReport(source.report);
      if (report.attemptId !== attemptId) throw invalidPayload('attemptId');
      return { attemptId, report };
    }
    case 'getDevelopmentBootstrap':
    case 'cancelDevelopmentBootstrap':
      return decodeAttemptOnlyRequest(value);
    case 'activateDevelopmentBootstrap': {
      const source = exactRecord(value, 'request', ['attemptId', 'manifestSha256']);
      return {
        attemptId: stringField(source, 'attemptId', 128, isCollabOpaqueId),
        manifestSha256: sha256(source, 'manifestSha256'),
      };
    }
    case 'putDevelopmentBootstrapGitBundle': {
      const source = exactRecord(value, 'request', [
        'attemptId',
        'byteCount',
        'contentEncoding',
        'contentType',
        'sha256',
      ]);
      if (
        source.contentEncoding !== 'identity'
        || source.contentType !== 'application/x-git-bundle'
      ) throw invalidPayload('contentType');
      return {
        attemptId: stringField(source, 'attemptId', 128, isCollabOpaqueId),
        byteCount: positiveInteger(
          source,
          'byteCount',
          COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapGitBundleBytes,
        ),
        contentEncoding: 'identity',
        contentType: 'application/x-git-bundle',
        sha256: sha256(source, 'sha256'),
      };
    }
  }
}

function decodeRequestResult(
  operation: DevelopmentBootstrapOperation,
  value: unknown,
): CollabDecodeResult<DevelopmentBootstrapOperationMap[DevelopmentBootstrapOperation]['request']> {
  try {
    return { status: 'ok', value: decodeOperationRequest(operation, value) };
  } catch (error) {
    return {
      status: 'invalid',
      error: error instanceof CollabError ? error : invalidPayload('request'),
    };
  }
}

function codec<Operation extends DevelopmentBootstrapOperation>(
  operation: Operation,
): DevelopmentBootstrapCodecMap[Operation] {
  return Object.freeze({
    decodeRequest: (value: unknown) => decodeRequestResult(operation, value) as
      CollabDecodeResult<DevelopmentBootstrapOperationMap[Operation]['request']>,
    decodeResponse: decodeAttemptStatus,
  }) as DevelopmentBootstrapCodecMap[Operation];
}

export const DEVELOPMENT_BOOTSTRAP_OPERATION_CODECS = Object.freeze({
  beginDevelopmentBootstrap: codec('beginDevelopmentBootstrap'),
  submitDevelopmentBootstrapReport: codec('submitDevelopmentBootstrapReport'),
  getDevelopmentBootstrap: codec('getDevelopmentBootstrap'),
  activateDevelopmentBootstrap: codec('activateDevelopmentBootstrap'),
  cancelDevelopmentBootstrap: codec('cancelDevelopmentBootstrap'),
  putDevelopmentBootstrapGitBundle: codec('putDevelopmentBootstrapGitBundle'),
} as const satisfies DevelopmentBootstrapCodecMap);

export function developmentBootstrapOperationCodec<
  Operation extends DevelopmentBootstrapOperation,
>(operation: Operation): DevelopmentBootstrapCodecMap[Operation] {
  const selected = DEVELOPMENT_BOOTSTRAP_OPERATION_CODECS[operation];
  if (!selected) {
    throw new CollabError({
      code: 'operation-failed',
      safeContext: { reason: 'bootstrap-operation-codec-missing' },
    });
  }
  return selected;
}
