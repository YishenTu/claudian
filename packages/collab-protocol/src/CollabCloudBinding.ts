import { COLLAB_LIMITS, COLLAB_PROTOCOL_VERSION } from './CollabConstants';
import {
  COLLAB_CONTROL_OPERATION_CODECS,
  type CollabControlOperation,
} from './CollabControlOperationCodecs';
import {
  COLLAB_ERROR_CODES,
  CollabError,
  sanitizeCollabDiagnosticContext,
  type CollabDiagnosticContext,
  type CollabErrorCode,
  type CollabRecoveryAction,
} from './CollabError';
import {
  isCollabOpaqueId,
  isCollabProjectId,
} from './CollabValidation';

export const COLLAB_CLOUD_BINDING_VERSION = 1 as const;
export const COLLAB_CLOUD_CAPABILITY_DOCUMENT_SCHEMA_VERSION = 1 as const;

export const COLLAB_CLOUD_CAPABILITIES = Object.freeze([
  'accept',
  'development-bootstrap',
  'git-receive-pack-personal-ref',
  'git-upload-pack',
  'project-events',
  'project-snapshot',
  'requests',
  'tickets',
] as const);

export type CollabCloudCapability = typeof COLLAB_CLOUD_CAPABILITIES[number];

export const COLLAB_CLOUD_JSON_OPERATIONS = Object.freeze([
  'getProjectSnapshot',
  ...Object.keys(COLLAB_CONTROL_OPERATION_CODECS) as CollabControlOperation[],
] as const);

export type CollabCloudJsonOperation = typeof COLLAB_CLOUD_JSON_OPERATIONS[number];

export const COLLAB_CLOUD_BINDING_LIMITS = Object.freeze({
  bootstrapAttemptTtlMs: 24 * 60 * 60 * 1_000,
  defaultMaxConcurrentBootstrapUploads: 1,
  eventHeartbeatMs: 30_000,
  eventMissedHeartbeatLimit: 2,
  maxCloudOpenRequests: 100,
  maxCloudProjectMembers: 100,
  maxCloudSnapshotUtf8Bytes: 448 * 1024,
  maxCloudTicketHighlights: 5,
  maxDevelopmentBootstrapGitBundleBytes: 1024 * 1024 * 1024,
  maxDevelopmentBootstrapManifestUtf8Bytes: 64 * 1024,
  maxDevelopmentBootstrapReportUtf8Bytes: 64 * 1024,
  maxDevelopmentBootstrapRepositoryBytes: 1024 * 1024 * 1024,
  maxDevelopmentBootstrapStagingBytes: 2 * 1024 * 1024 * 1024,
  maxEventReplay: 500,
  maxGitReceivePackBytes: 256 * 1024 * 1024,
  maxRepositoryBytes: 1024 * 1024 * 1024,
  minRetainedEventCount: 10_000,
  maxUploadsPerBootstrapAttempt: 1,
  minEventRetentionDays: 30,
  uploadDeadlineMs: 15 * 60 * 1_000,
  uploadIdleTimeoutMs: 30_000,
} as const);

export interface CollabCloudCapabilityLimits {
  readonly maxDevelopmentBootstrapGitBundleBytes: number;
  readonly maxDevelopmentBootstrapManifestUtf8Bytes: number;
  readonly maxDevelopmentBootstrapReportUtf8Bytes: number;
  readonly maxEventReplay: number;
  readonly maxGitReceivePackBytes: number;
  readonly maxJsonPayloadUtf8Bytes: number;
  readonly maxRepositoryBytes: number;
}

export interface CollabCloudCapabilityDocument {
  readonly bindingVersions: readonly number[];
  readonly capabilities: readonly string[];
  readonly limits: CollabCloudCapabilityLimits;
  readonly protocolVersions: readonly number[];
  readonly schemaVersion: typeof COLLAB_CLOUD_CAPABILITY_DOCUMENT_SCHEMA_VERSION;
}

export type DevelopmentBootstrapOperation =
  | 'beginDevelopmentBootstrap'
  | 'submitDevelopmentBootstrapReport'
  | 'getDevelopmentBootstrap'
  | 'activateDevelopmentBootstrap'
  | 'cancelDevelopmentBootstrap'
  | 'putDevelopmentBootstrapGitBundle';

export type CollabCloudGitService = 'git-upload-pack' | 'git-receive-pack';

export type CollabCloudRouteMatch =
  | { readonly kind: 'capabilities' }
  | {
    readonly kind: 'project-operation';
    readonly operation: CollabCloudJsonOperation;
    readonly projectId: string;
  }
  | {
    readonly afterSequence: number;
    readonly kind: 'project-events';
    readonly projectId: string;
  }
  | {
    readonly kind: 'git-info-refs';
    readonly projectId: string;
    readonly service: CollabCloudGitService;
  }
  | {
    readonly kind: 'git-upload-pack' | 'git-receive-pack';
    readonly projectId: string;
  }
  | {
    readonly attemptId?: string;
    readonly kind: 'development-bootstrap';
    readonly operation: DevelopmentBootstrapOperation;
  };

export interface CollabCloudRoute {
  readonly match: CollabCloudRouteMatch;
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly target: string;
}

export interface CollabCloudSuccessEnvelope<T> {
  readonly data: T;
  readonly protocolVersion: typeof COLLAB_PROTOCOL_VERSION;
  readonly requestId: string;
}

export interface CollabCloudWireError {
  readonly code: CollabErrorCode;
  readonly recoveryActions: readonly CollabRecoveryAction[];
  readonly safeContext: CollabDiagnosticContext;
}

export interface CollabCloudErrorEnvelope {
  readonly error: CollabCloudWireError;
  readonly protocolVersion: typeof COLLAB_PROTOCOL_VERSION;
  readonly requestId: string;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

const CLOUD_CAPABILITY_SET: ReadonlySet<string> = new Set(COLLAB_CLOUD_CAPABILITIES);
const CLOUD_JSON_OPERATION_SET: ReadonlySet<string> = new Set(COLLAB_CLOUD_JSON_OPERATIONS);
const COLLAB_ERROR_CODE_SET: ReadonlySet<string> = new Set(COLLAB_ERROR_CODES);
const RECOVERY_ACTION_SET: ReadonlySet<string> = new Set([
  'retry',
  'review-conflicts',
  'request-access',
]);
const CAPABILITY_TOKEN_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

function invalidPayload(field: string): CollabError {
  return new CollabError({
    code: 'protocol-payload-invalid',
    safeContext: { field },
  });
}

function invalidRoute(): never {
  throw new RangeError('Invalid Collab Cloud route input');
}

function record(value: unknown, field: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidPayload(field);
  }
  return value as UnknownRecord;
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return keys.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => expected.has(key));
}

function exactRecord(value: unknown, field: string, keys: readonly string[]): UnknownRecord {
  const source = record(value, field);
  if (!hasExactKeys(source, keys)) throw invalidPayload(field);
  return source;
}

function positiveSafeInteger(value: unknown, field: string, maximum?: number): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 1
    || (maximum !== undefined && value > maximum)
  ) {
    throw invalidPayload(field);
  }
  return value;
}

function sortedUniqueIntegers(value: unknown, field: string): readonly number[] {
  if (!Array.isArray(value) || value.length === 0) throw invalidPayload(field);
  const decoded = value.map(item => positiveSafeInteger(item, field));
  if (decoded.some((item, index) => index > 0 && decoded[index - 1] >= item)) {
    throw invalidPayload(field);
  }
  return Object.freeze(decoded);
}

function sortedUniqueTokens(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) throw invalidPayload(field);
  const decoded = value.map((item) => {
    if (typeof item !== 'string' || !CAPABILITY_TOKEN_PATTERN.test(item)) {
      throw invalidPayload(field);
    }
    return item;
  });
  if (decoded.some((item, index) => index > 0 && decoded[index - 1].localeCompare(item, 'en-US') >= 0)) {
    throw invalidPayload(field);
  }
  return Object.freeze(decoded);
}

function requireSupportedVersion(
  versions: readonly number[],
  supportedVersion: number,
  kind: string,
): void {
  if (versions.length === 1 && versions[0] === supportedVersion) return;
  throw new CollabError({
    code: 'protocol-version-unsupported',
    safeContext: {
      kind,
      receivedVersion: versions.find(version => version !== supportedVersion)
        ?? versions[0]
        ?? 0,
      supportedVersion,
    },
  });
}

function route(method: CollabCloudRoute['method'], target: string, match: CollabCloudRouteMatch) {
  return Object.freeze({ match: Object.freeze(match), method, target });
}

function assertProjectId(projectId: string): void {
  if (!isCollabProjectId(projectId)) invalidRoute();
}

function assertAttemptId(attemptId: string): void {
  if (!isCollabOpaqueId(attemptId)) invalidRoute();
}

function isCloudJsonOperation(value: string): value is CollabCloudJsonOperation {
  return CLOUD_JSON_OPERATION_SET.has(value);
}

export function collabCloudCapabilitiesRoute(): CollabCloudRoute {
  return route('GET', '/collab/capabilities', { kind: 'capabilities' });
}

export function collabCloudProjectOperationRoute(
  projectId: string,
  operation: CollabCloudJsonOperation,
): CollabCloudRoute {
  assertProjectId(projectId);
  if (!isCloudJsonOperation(operation)) invalidRoute();
  return route('POST', `/v1/projects/${projectId}/operations/${operation}`, {
    kind: 'project-operation',
    operation,
    projectId,
  });
}

export function collabCloudProjectEventsRoute(
  projectId: string,
  afterSequence: number,
): CollabCloudRoute {
  assertProjectId(projectId);
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) invalidRoute();
  return route('GET', `/v1/projects/${projectId}/events?afterSequence=${afterSequence}`, {
    afterSequence,
    kind: 'project-events',
    projectId,
  });
}

export function collabCloudGitRoute(
  projectId: string,
  routeKind: 'info-refs',
  service: CollabCloudGitService,
): CollabCloudRoute;
export function collabCloudGitRoute(
  projectId: string,
  routeKind: CollabCloudGitService,
): CollabCloudRoute;
export function collabCloudGitRoute(
  projectId: string,
  routeKind: 'info-refs' | CollabCloudGitService,
  service?: CollabCloudGitService,
): CollabCloudRoute {
  assertProjectId(projectId);
  if (routeKind === 'info-refs') {
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') invalidRoute();
    return route(
      'GET',
      `/v1/projects/${projectId}/repository.git/info/refs?service=${service}`,
      { kind: 'git-info-refs', projectId, service },
    );
  }
  if (service !== undefined) invalidRoute();
  return route('POST', `/v1/projects/${projectId}/repository.git/${routeKind}`, {
    kind: routeKind,
    projectId,
  });
}

export function collabDevelopmentBootstrapRoute(
  operation: 'beginDevelopmentBootstrap',
): CollabCloudRoute;
export function collabDevelopmentBootstrapRoute(
  operation: Exclude<DevelopmentBootstrapOperation, 'beginDevelopmentBootstrap'>,
  attemptId: string,
): CollabCloudRoute;
export function collabDevelopmentBootstrapRoute(
  operation: DevelopmentBootstrapOperation,
  attemptId?: string,
): CollabCloudRoute {
  const base = '/v1/development/bootstrap/attempts';
  if (operation === 'beginDevelopmentBootstrap') {
    if (attemptId !== undefined) invalidRoute();
    return route('POST', base, { kind: 'development-bootstrap', operation });
  }
  if (attemptId === undefined) invalidRoute();
  assertAttemptId(attemptId);
  const suffixes = {
    activateDevelopmentBootstrap: ['POST', 'activate'],
    cancelDevelopmentBootstrap: ['POST', 'cancel'],
    getDevelopmentBootstrap: ['GET', ''],
    putDevelopmentBootstrapGitBundle: ['PUT', 'git-bundle'],
    submitDevelopmentBootstrapReport: ['POST', 'reports'],
  } as const;
  const binding = suffixes[operation];
  if (!binding) invalidRoute();
  const [method, suffix] = binding;
  const target = suffix ? `${base}/${attemptId}/${suffix}` : `${base}/${attemptId}`;
  return route(method, target, {
    attemptId,
    kind: 'development-bootstrap',
    operation,
  });
}

function exactQuery(url: URL, expectedKeys: readonly string[]): boolean {
  const keys = [...url.searchParams.keys()];
  return keys.length === expectedKeys.length
    && expectedKeys.every(key => keys.filter(candidate => candidate === key).length === 1)
    && keys.every(key => expectedKeys.includes(key))
    && url.search === (expectedKeys.length === 0 ? '' : `?${url.searchParams.toString()}`);
}

function parseCanonicalNonNegativeInteger(value: string | null): number | null {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function matchCollabCloudRoute(
  method: string,
  target: string,
): CollabCloudRouteMatch | null {
  if (!target.startsWith('/') || target.includes('#')) return null;
  let url: URL;
  try {
    url = new URL(target, 'http://collab.invalid');
  } catch {
    return null;
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (url.pathname !== `/${segments.join('/')}` || target.endsWith('?')) return null;
  if (
    method === 'GET'
    && url.pathname === '/collab/capabilities'
    && exactQuery(url, [])
  ) return { kind: 'capabilities' };

  if (
    segments[0] === 'v1'
    && segments[1] === 'projects'
    && isCollabProjectId(segments[2])
  ) {
    const projectId = segments[2];
    if (
      method === 'POST'
      && segments.length === 5
      && segments[3] === 'operations'
      && isCloudJsonOperation(segments[4])
      && exactQuery(url, [])
    ) {
      return { kind: 'project-operation', operation: segments[4], projectId };
    }
    if (
      method === 'GET'
      && segments.length === 4
      && segments[3] === 'events'
      && exactQuery(url, ['afterSequence'])
    ) {
      const afterSequence = parseCanonicalNonNegativeInteger(
        url.searchParams.get('afterSequence'),
      );
      return afterSequence === null
        ? null
        : { afterSequence, kind: 'project-events', projectId };
    }
    if (
      method === 'GET'
      && segments.length === 6
      && segments[3] === 'repository.git'
      && segments[4] === 'info'
      && segments[5] === 'refs'
      && exactQuery(url, ['service'])
    ) {
      const service = url.searchParams.get('service');
      return service === 'git-upload-pack' || service === 'git-receive-pack'
        ? { kind: 'git-info-refs', projectId, service }
        : null;
    }
    if (
      method === 'POST'
      && segments.length === 5
      && segments[3] === 'repository.git'
      && (segments[4] === 'git-upload-pack' || segments[4] === 'git-receive-pack')
      && exactQuery(url, [])
    ) return { kind: segments[4], projectId };
  }

  if (
    segments[0] !== 'v1'
    || segments[1] !== 'development'
    || segments[2] !== 'bootstrap'
    || segments[3] !== 'attempts'
    || !exactQuery(url, [])
  ) return null;
  if (method === 'POST' && segments.length === 4) {
    return { kind: 'development-bootstrap', operation: 'beginDevelopmentBootstrap' };
  }
  const attemptId = segments[4];
  if (!isCollabOpaqueId(attemptId)) return null;
  if (method === 'GET' && segments.length === 5) {
    return { attemptId, kind: 'development-bootstrap', operation: 'getDevelopmentBootstrap' };
  }
  const operation = (segments.length === 6
    ? {
      activate: method === 'POST' ? 'activateDevelopmentBootstrap' : null,
      cancel: method === 'POST' ? 'cancelDevelopmentBootstrap' : null,
      'git-bundle': method === 'PUT' ? 'putDevelopmentBootstrapGitBundle' : null,
      reports: method === 'POST' ? 'submitDevelopmentBootstrapReport' : null,
    }[segments[5]]
    : null) as Exclude<DevelopmentBootstrapOperation, 'beginDevelopmentBootstrap' | 'getDevelopmentBootstrap'>
      | null
      | undefined;
  return operation
    ? { attemptId, kind: 'development-bootstrap', operation }
    : null;
}

export function decodeCollabCloudCapabilityDocument(
  value: unknown,
): CollabCloudCapabilityDocument {
  const source = exactRecord(value, 'capabilities', [
    'bindingVersions',
    'capabilities',
    'limits',
    'protocolVersions',
    'schemaVersion',
  ]);
  if (source.schemaVersion !== COLLAB_CLOUD_CAPABILITY_DOCUMENT_SCHEMA_VERSION) {
    throw invalidPayload('schemaVersion');
  }
  const bindingVersions = sortedUniqueIntegers(source.bindingVersions, 'bindingVersions');
  const protocolVersions = sortedUniqueIntegers(source.protocolVersions, 'protocolVersions');
  requireSupportedVersion(bindingVersions, COLLAB_CLOUD_BINDING_VERSION, 'cloud-binding');
  requireSupportedVersion(protocolVersions, COLLAB_PROTOCOL_VERSION, 'canonical-wire');
  const capabilities = sortedUniqueTokens(source.capabilities, 'capabilities');
  const limitsSource = exactRecord(source.limits, 'limits', [
    'maxDevelopmentBootstrapGitBundleBytes',
    'maxDevelopmentBootstrapManifestUtf8Bytes',
    'maxDevelopmentBootstrapReportUtf8Bytes',
    'maxEventReplay',
    'maxGitReceivePackBytes',
    'maxJsonPayloadUtf8Bytes',
    'maxRepositoryBytes',
  ]);
  const limits = Object.freeze({
    maxDevelopmentBootstrapGitBundleBytes: positiveSafeInteger(
      limitsSource.maxDevelopmentBootstrapGitBundleBytes,
      'maxDevelopmentBootstrapGitBundleBytes',
      COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapGitBundleBytes,
    ),
    maxDevelopmentBootstrapManifestUtf8Bytes: positiveSafeInteger(
      limitsSource.maxDevelopmentBootstrapManifestUtf8Bytes,
      'maxDevelopmentBootstrapManifestUtf8Bytes',
      COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapManifestUtf8Bytes,
    ),
    maxDevelopmentBootstrapReportUtf8Bytes: positiveSafeInteger(
      limitsSource.maxDevelopmentBootstrapReportUtf8Bytes,
      'maxDevelopmentBootstrapReportUtf8Bytes',
      COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapReportUtf8Bytes,
    ),
    maxEventReplay: positiveSafeInteger(
      limitsSource.maxEventReplay,
      'maxEventReplay',
      COLLAB_CLOUD_BINDING_LIMITS.maxEventReplay,
    ),
    maxGitReceivePackBytes: positiveSafeInteger(
      limitsSource.maxGitReceivePackBytes,
      'maxGitReceivePackBytes',
      COLLAB_CLOUD_BINDING_LIMITS.maxGitReceivePackBytes,
    ),
    maxJsonPayloadUtf8Bytes: positiveSafeInteger(
      limitsSource.maxJsonPayloadUtf8Bytes,
      'maxJsonPayloadUtf8Bytes',
      COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
    ),
    maxRepositoryBytes: positiveSafeInteger(
      limitsSource.maxRepositoryBytes,
      'maxRepositoryBytes',
      COLLAB_CLOUD_BINDING_LIMITS.maxRepositoryBytes,
    ),
  });
  return Object.freeze({
    bindingVersions,
    capabilities,
    limits,
    protocolVersions,
    schemaVersion: COLLAB_CLOUD_CAPABILITY_DOCUMENT_SCHEMA_VERSION,
  });
}

export function collabCloudCapabilityDocument(
  capabilities: readonly CollabCloudCapability[],
  limits: CollabCloudCapabilityLimits,
): CollabCloudCapabilityDocument {
  if (!capabilities.every(capability => CLOUD_CAPABILITY_SET.has(capability))) {
    throw invalidPayload('capabilities');
  }
  return decodeCollabCloudCapabilityDocument({
    bindingVersions: [COLLAB_CLOUD_BINDING_VERSION],
    capabilities: [...capabilities].sort((left, right) => left.localeCompare(right, 'en-US')),
    limits,
    protocolVersions: [COLLAB_PROTOCOL_VERSION],
    schemaVersion: COLLAB_CLOUD_CAPABILITY_DOCUMENT_SCHEMA_VERSION,
  });
}

export function collabCloudCapabilitySupported(
  document: CollabCloudCapabilityDocument,
  capability: CollabCloudCapability,
): boolean {
  return CLOUD_CAPABILITY_SET.has(capability) && document.capabilities.includes(capability);
}

export function collabCloudSuccessEnvelope<T>(
  requestId: string,
  data: T,
): CollabCloudSuccessEnvelope<T> {
  if (!isCollabOpaqueId(requestId)) throw invalidPayload('requestId');
  return Object.freeze({ data, protocolVersion: COLLAB_PROTOCOL_VERSION, requestId });
}

export function decodeCollabCloudSuccessEnvelope<T = unknown>(
  value: unknown,
): CollabCloudSuccessEnvelope<T> {
  const source = exactRecord(value, 'envelope', ['data', 'protocolVersion', 'requestId']);
  if (source.protocolVersion !== COLLAB_PROTOCOL_VERSION || !isCollabOpaqueId(source.requestId)) {
    throw invalidPayload('envelope');
  }
  return Object.freeze({
    data: source.data as T,
    protocolVersion: COLLAB_PROTOCOL_VERSION,
    requestId: source.requestId,
  });
}

export function collabCloudErrorEnvelope(
  requestId: string,
  error: CollabError,
): CollabCloudErrorEnvelope {
  if (!isCollabOpaqueId(requestId)) throw invalidPayload('requestId');
  return Object.freeze({
    error: Object.freeze({
      code: error.code,
      recoveryActions: Object.freeze([...error.recoveryActions]),
      safeContext: error.safeContext,
    }),
    protocolVersion: COLLAB_PROTOCOL_VERSION,
    requestId,
  });
}

export function decodeCollabCloudErrorEnvelope(value: unknown): CollabCloudErrorEnvelope {
  const source = exactRecord(value, 'envelope', ['error', 'protocolVersion', 'requestId']);
  const wireError = exactRecord(source.error, 'error', [
    'code',
    'recoveryActions',
    'safeContext',
  ]);
  if (
    source.protocolVersion !== COLLAB_PROTOCOL_VERSION
    || !isCollabOpaqueId(source.requestId)
    || typeof wireError.code !== 'string'
    || !COLLAB_ERROR_CODE_SET.has(wireError.code)
    || !Array.isArray(wireError.recoveryActions)
    || !wireError.recoveryActions.every(action => (
      typeof action === 'string' && RECOVERY_ACTION_SET.has(action)
    ))
  ) throw invalidPayload('error');
  const safeContextSource = record(wireError.safeContext, 'safeContext');
  const safeContext = sanitizeCollabDiagnosticContext(safeContextSource);
  if (
    Object.keys(safeContextSource).length !== Object.keys(safeContext).length
    || Object.entries(safeContextSource).some(([key, item]) => safeContext[key] !== item)
  ) throw invalidPayload('safeContext');
  return Object.freeze({
    error: Object.freeze({
      code: wireError.code as CollabErrorCode,
      recoveryActions: Object.freeze([
        ...wireError.recoveryActions as CollabRecoveryAction[],
      ]),
      safeContext,
    }),
    protocolVersion: COLLAB_PROTOCOL_VERSION,
    requestId: source.requestId,
  });
}
