import { createHash } from 'node:crypto';

import {
  COLLAB_CLOUD_BINDING_VERSION,
  COLLAB_PROTOCOL_VERSION,
  type CollabGitOid,
  type CollabIsoTimestamp,
  type CollabMemberId,
  type CollabProjectId,
  decodeDevelopmentBootstrapManifest,
  type DevelopmentBootstrapActivationResult,
  type DevelopmentBootstrapAttemptStatus,
  type DevelopmentBootstrapManifest,
  encodeDevelopmentBootstrapManifestCanonicalJson,
  isCollabGitOid,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
} from '@claudian/collab-protocol';

import {
  canonicalCloudOrigin,
  canonicalCloudUrl,
  cloudProjectGitRemoteUrl,
} from '@/app/collab/remote-authority/CloudAuthorityUrls';

export const CLOUD_BOOTSTRAP_TRANSITION_SCHEMA_VERSION = 1 as const;

export const CLOUD_BOOTSTRAP_TRANSITION_PHASES = Object.freeze([
  'intent',
  'readiness-confirmed',
  'origin-rotated',
  'cloud-verified',
  'membership-replaced',
  'index-repaired',
  'lan-authority-retired',
  'fence-terminal',
] as const);

export type CloudBootstrapTransitionPhase =
  typeof CLOUD_BOOTSTRAP_TRANSITION_PHASES[number];
export type CloudBootstrapAttemptObservation = 'pending' | 'activated' | 'cancelled';

export type CloudBootstrapHostFence =
  | {
      readonly fenceId: string;
      readonly state: 'active';
      readonly stoppedAt: null;
    }
  | {
      readonly fenceId: string;
      readonly state: 'host-stopped' | 'terminal';
      readonly stoppedAt: CollabIsoTimestamp;
    }
  | {
      readonly fenceId: string;
      readonly state: 'released-before-activation';
      readonly stoppedAt: CollabIsoTimestamp | null;
    }
  | {
      readonly fenceId: null;
      readonly state: 'not-applicable';
      readonly stoppedAt: null;
    };

export interface CloudBootstrapTransitionRecord {
  readonly activationResult: DevelopmentBootstrapActivationResult | null;
  readonly attemptId: string;
  readonly attemptState: CloudBootstrapAttemptObservation;
  readonly createdAt: CollabIsoTimestamp;
  readonly developmentActorId: CollabMemberId;
  readonly fence: CloudBootstrapHostFence;
  readonly kind: 'cloud-bootstrap-transition';
  readonly manifest: DevelopmentBootstrapManifest;
  readonly manifestSha256: string;
  readonly memberId: CollabMemberId;
  readonly newAuthority: {
    readonly bindingVersion: typeof COLLAB_CLOUD_BINDING_VERSION;
    readonly gitRemoteUrl: string;
    readonly serverUrl: string;
    readonly wireVersion: typeof COLLAB_PROTOCOL_VERSION;
  };
  readonly oldAuthority: {
    readonly caFingerprint: string;
    readonly endpoint: string;
    readonly gitRemoteUrl: string;
    readonly sourceHostMemberId: CollabMemberId;
  };
  readonly phase: CloudBootstrapTransitionPhase;
  readonly projectId: CollabProjectId;
  readonly repositoryIdentity: {
    readonly mainOid: CollabGitOid;
    readonly objectFormat: 'sha1' | 'sha256';
    readonly personalRef: string;
    readonly personalRefOid: CollabGitOid;
  };
  readonly schemaVersion: typeof CLOUD_BOOTSTRAP_TRANSITION_SCHEMA_VERSION;
  readonly terminalCleanupCompleted: boolean;
  readonly updatedAt: CollabIsoTimestamp;
}

export interface CreateCloudBootstrapTransitionRecordInput {
  readonly developmentActorId: CollabMemberId;
  readonly fenceId?: string;
  readonly manifest: DevelopmentBootstrapManifest;
  readonly manifestSha256: string;
  readonly memberId: CollabMemberId;
  readonly oldEndpoint: string;
  readonly oldGitRemoteUrl: string;
  readonly serverUrl: string;
  readonly timestamp: CollabIsoTimestamp;
}

export interface CloudBootstrapTransitionStorePort {
  create(record: CloudBootstrapTransitionRecord): Promise<CloudBootstrapTransitionRecord>;
  load(projectId: CollabProjectId): Promise<CloudBootstrapTransitionRecord | null>;
  save(record: CloudBootstrapTransitionRecord): Promise<void>;
}

type Value = Readonly<Record<string, unknown>>;

const DIGEST = /^[0-9a-f]{64}$/u;
const RECORD_KEYS = new Set([
  'activationResult',
  'attemptId',
  'attemptState',
  'createdAt',
  'developmentActorId',
  'fence',
  'kind',
  'manifest',
  'manifestSha256',
  'memberId',
  'newAuthority',
  'oldAuthority',
  'phase',
  'projectId',
  'repositoryIdentity',
  'schemaVersion',
  'terminalCleanupCompleted',
  'updatedAt',
]);

function valueRecord(value: unknown, name: string): Value {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`Invalid ${name}`);
  }
  return value as Value;
}

function exactRecord(value: unknown, name: string, keys: readonly string[]): Value {
  const source = valueRecord(value, name);
  const expected = new Set(keys);
  if (
    Object.keys(source).length !== expected.size
    || Object.keys(source).some(key => !expected.has(key))
  ) {
    throw new TypeError(`Invalid ${name}`);
  }
  return source;
}

function text(
  source: Value,
  key: string,
  maximum: number,
  validate?: (candidate: string) => boolean,
): string {
  const candidate = source[key];
  if (
    typeof candidate !== 'string'
    || candidate.length === 0
    || candidate.length > maximum
    || (validate && !validate(candidate))
  ) {
    throw new TypeError(`Invalid ${key}`);
  }
  return candidate;
}

function timestamp(source: Value, key: string): CollabIsoTimestamp {
  const candidate = text(source, key, 64);
  if (Number.isNaN(Date.parse(candidate)) || new Date(candidate).toISOString() !== candidate) {
    throw new TypeError(`Invalid ${key}`);
  }
  return candidate;
}

function canonicalHttpsOrigin(candidate: string, key: string): string {
  const normalized = canonicalCloudOrigin(candidate, key);
  if (new URL(normalized).protocol !== 'https:') throw new TypeError(`Invalid ${key}`);
  return normalized;
}

function canonicalHttpsUrl(candidate: string, key: string): string {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError(`Invalid ${key}`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
  ) {
    throw new TypeError(`Invalid ${key}`);
  }
  return parsed.toString();
}

export function developmentBootstrapManifestSha256(
  manifest: DevelopmentBootstrapManifest,
): string {
  return createHash('sha256')
    .update(encodeDevelopmentBootstrapManifestCanonicalJson(manifest))
    .digest('hex');
}

function decodeActivationResult(value: unknown): DevelopmentBootstrapActivationResult | null {
  if (value === null) return null;
  const source = exactRecord(value, 'activationResult', [
    'activatedAt',
    'activationOperationId',
    'placementGeneration',
    'projectId',
  ]);
  const activationOperationId = text(source, 'activationOperationId', 128);
  const projectId = text(source, 'projectId', 64);
  const placementGeneration = source.placementGeneration;
  if (
    !isCollabOpaqueId(activationOperationId)
    || !isCollabProjectId(projectId)
    || !Number.isSafeInteger(placementGeneration)
    || (placementGeneration as number) < 1
  ) {
    throw new TypeError('Invalid activationResult');
  }
  return {
    activatedAt: timestamp(source, 'activatedAt'),
    activationOperationId,
    placementGeneration: placementGeneration as number,
    projectId,
  };
}

function decodeFence(value: unknown): CloudBootstrapHostFence {
  const source = exactRecord(value, 'fence', ['fenceId', 'state', 'stoppedAt']);
  if (source.state === 'not-applicable') {
    if (source.fenceId !== null || source.stoppedAt !== null) {
      throw new TypeError('Invalid fence');
    }
    return { fenceId: null, state: 'not-applicable', stoppedAt: null };
  }
  const fenceId = text(source, 'fenceId', 128);
  if (!isCollabOpaqueId(fenceId)) throw new TypeError('Invalid fenceId');
  if (source.state === 'active') {
    if (source.stoppedAt !== null) throw new TypeError('Invalid fence');
    return { fenceId, state: 'active', stoppedAt: null };
  }
  if (
    source.state !== 'host-stopped'
    && source.state !== 'released-before-activation'
    && source.state !== 'terminal'
  ) {
    throw new TypeError('Invalid fence');
  }
  if (source.state === 'released-before-activation') {
    return {
      fenceId,
      state: 'released-before-activation',
      stoppedAt: source.stoppedAt === null ? null : timestamp(source, 'stoppedAt'),
    };
  }
  return {
    fenceId,
    state: source.state,
    stoppedAt: timestamp(source, 'stoppedAt'),
  };
}

export function decodeCloudBootstrapTransitionRecord(
  value: unknown,
): CloudBootstrapTransitionRecord {
  const source = valueRecord(value, 'Cloud bootstrap transition');
  if (
    Object.keys(source).length !== RECORD_KEYS.size
    || Object.keys(source).some(key => !RECORD_KEYS.has(key))
    || source.schemaVersion !== CLOUD_BOOTSTRAP_TRANSITION_SCHEMA_VERSION
    || source.kind !== 'cloud-bootstrap-transition'
  ) {
    throw new TypeError('Invalid Cloud bootstrap transition');
  }
  const projectId = text(source, 'projectId', 64);
  const memberId = text(source, 'memberId', 64);
  const attemptId = text(source, 'attemptId', 128);
  const developmentActorId = text(source, 'developmentActorId', 128);
  if (
    !isCollabProjectId(projectId)
    || !isCollabMemberId(memberId)
    || !isCollabOpaqueId(attemptId)
    || !isCollabMemberId(developmentActorId)
    || developmentActorId !== memberId
  ) {
    throw new TypeError('Invalid Cloud bootstrap identity');
  }
  const phase = source.phase;
  const attemptState = source.attemptState;
  if (
    typeof phase !== 'string'
    || !CLOUD_BOOTSTRAP_TRANSITION_PHASES.includes(phase as CloudBootstrapTransitionPhase)
    || (attemptState !== 'pending' && attemptState !== 'activated' && attemptState !== 'cancelled')
  ) {
    throw new TypeError('Invalid Cloud bootstrap state');
  }
  const activationResult = decodeActivationResult(source.activationResult);
  const terminalCleanupCompleted = source.terminalCleanupCompleted;
  const manifest = decodeDevelopmentBootstrapManifest(source.manifest);
  const fence = decodeFence(source.fence);
  const createdAt = timestamp(source, 'createdAt');
  const updatedAt = timestamp(source, 'updatedAt');
  if (
    updatedAt < createdAt
    || (attemptState === 'activated') !== (activationResult !== null)
    || (activationResult !== null && activationResult.projectId !== projectId)
    || manifest.attemptId !== attemptId
    || manifest.comparison.projectId !== projectId
    || !manifest.comparison.members.some(member => member.memberId === memberId)
    || (phase !== 'intent' && attemptState !== 'activated')
    || (attemptState === 'cancelled'
      && fence.state !== 'released-before-activation'
      && fence.state !== 'not-applicable')
    || (fence.state === 'released-before-activation' && attemptState !== 'cancelled')
    || (fence.state === 'terminal' && phase !== 'fence-terminal')
    || (phase === 'fence-terminal' && fence.state === 'active')
    || typeof terminalCleanupCompleted !== 'boolean'
    || (terminalCleanupCompleted && attemptState === 'pending')
  ) {
    throw new TypeError('Impossible Cloud bootstrap state');
  }

  const newAuthority = exactRecord(source.newAuthority, 'newAuthority', [
    'bindingVersion',
    'gitRemoteUrl',
    'serverUrl',
    'wireVersion',
  ]);
  const serverUrl = canonicalCloudOrigin(
    text(newAuthority, 'serverUrl', 2_048),
    'serverUrl',
  );
  const newGitRemoteUrl = canonicalCloudUrl(
    text(newAuthority, 'gitRemoteUrl', 2_048),
    'gitRemoteUrl',
  );
  if (
    newAuthority.bindingVersion !== COLLAB_CLOUD_BINDING_VERSION
    || newAuthority.wireVersion !== COLLAB_PROTOCOL_VERSION
    || newGitRemoteUrl !== cloudProjectGitRemoteUrl(serverUrl, projectId)
  ) {
    throw new TypeError('Invalid newAuthority');
  }

  const oldAuthority = exactRecord(source.oldAuthority, 'oldAuthority', [
    'caFingerprint',
    'endpoint',
    'gitRemoteUrl',
    'sourceHostMemberId',
  ]);
  const sourceHostMemberId = text(oldAuthority, 'sourceHostMemberId', 64);
  const caFingerprint = text(
    oldAuthority,
    'caFingerprint',
    64,
    candidate => DIGEST.test(candidate),
  );
  const oldEndpoint = canonicalHttpsOrigin(
    text(oldAuthority, 'endpoint', 2_048),
    'oldEndpoint',
  );
  const oldGitRemoteUrl = canonicalHttpsUrl(
    text(oldAuthority, 'gitRemoteUrl', 2_048),
    'oldGitRemoteUrl',
  );
  if (
    !isCollabMemberId(sourceHostMemberId)
    || new URL(oldGitRemoteUrl).origin !== new URL(oldEndpoint).origin
  ) {
    throw new TypeError('Invalid oldAuthority');
  }

  const repositoryIdentity = exactRecord(source.repositoryIdentity, 'repositoryIdentity', [
    'mainOid',
    'objectFormat',
    'personalRef',
    'personalRefOid',
  ]);
  const mainOid = text(repositoryIdentity, 'mainOid', 64);
  const personalRefOid = text(repositoryIdentity, 'personalRefOid', 64);
  const objectFormat = repositoryIdentity.objectFormat;
  const expectedOidLength = objectFormat === 'sha1' ? 40 : objectFormat === 'sha256' ? 64 : 0;
  if (
    !isCollabGitOid(mainOid)
    || !isCollabGitOid(personalRefOid)
    || mainOid.length !== expectedOidLength
    || personalRefOid.length !== expectedOidLength
  ) {
    throw new TypeError('Invalid repositoryIdentity');
  }
  const manifestMember = manifest.comparison.members.find(candidate => (
    candidate.memberId === memberId
  ));
  const manifestPersonalRefOid = manifest.git.refs.find(candidate => (
    candidate.name === manifestMember?.personalRef
  ))?.oid;
  const manifestSha256 = text(source, 'manifestSha256', 64, candidate => DIGEST.test(candidate));
  const calculatedManifestSha256 = developmentBootstrapManifestSha256(manifest);
  if (
    manifestSha256 !== calculatedManifestSha256
    || sourceHostMemberId !== manifest.comparison.sourceHostMemberId
    || caFingerprint !== manifest.comparison.sourceCaFingerprint
    || mainOid !== manifest.comparison.mainOid
    || objectFormat !== manifest.git.objectFormat
    || repositoryIdentity.personalRef !== manifestMember?.personalRef
    || personalRefOid !== manifestPersonalRefOid
  ) {
    throw new TypeError('Cloud bootstrap manifest identity mismatch');
  }

  return {
    activationResult,
    attemptId,
    attemptState,
    createdAt,
    developmentActorId,
    fence,
    kind: 'cloud-bootstrap-transition',
    manifest,
    manifestSha256,
    memberId,
    newAuthority: {
      bindingVersion: COLLAB_CLOUD_BINDING_VERSION,
      gitRemoteUrl: newGitRemoteUrl,
      serverUrl,
      wireVersion: COLLAB_PROTOCOL_VERSION,
    },
    oldAuthority: {
      caFingerprint,
      endpoint: oldEndpoint,
      gitRemoteUrl: oldGitRemoteUrl,
      sourceHostMemberId,
    },
    phase: phase as CloudBootstrapTransitionPhase,
    projectId,
    repositoryIdentity: {
      mainOid,
      objectFormat: objectFormat as 'sha1' | 'sha256',
      personalRef: text(repositoryIdentity, 'personalRef', 256),
      personalRefOid,
    },
    schemaVersion: CLOUD_BOOTSTRAP_TRANSITION_SCHEMA_VERSION,
    terminalCleanupCompleted,
    updatedAt,
  };
}

export function createCloudBootstrapTransitionRecord(
  input: CreateCloudBootstrapTransitionRecordInput,
): CloudBootstrapTransitionRecord {
  const manifest = decodeDevelopmentBootstrapManifest(input.manifest);
  const member = manifest.comparison.members.find(candidate => candidate.memberId === input.memberId);
  const personalRef = member?.personalRef;
  const personalRefOid = manifest.git.refs.find(candidate => candidate.name === personalRef)?.oid;
  if (!member || !personalRefOid) throw new TypeError('Invalid bootstrap Member identity');
  const isFormerHost = input.memberId === manifest.comparison.sourceHostMemberId;
  if (isFormerHost !== (input.fenceId !== undefined)) {
    throw new TypeError('Invalid bootstrap Host fence identity');
  }
  return decodeCloudBootstrapTransitionRecord({
    activationResult: null,
    attemptId: manifest.attemptId,
    attemptState: 'pending',
    createdAt: input.timestamp,
    developmentActorId: input.developmentActorId,
    fence: isFormerHost
      ? { fenceId: input.fenceId, state: 'active', stoppedAt: null }
      : { fenceId: null, state: 'not-applicable', stoppedAt: null },
    kind: 'cloud-bootstrap-transition',
    manifest,
    manifestSha256: input.manifestSha256,
    memberId: input.memberId,
    newAuthority: {
      bindingVersion: COLLAB_CLOUD_BINDING_VERSION,
      gitRemoteUrl: cloudProjectGitRemoteUrl(
        input.serverUrl,
        manifest.comparison.projectId,
      ),
      serverUrl: canonicalCloudOrigin(input.serverUrl, 'serverUrl'),
      wireVersion: COLLAB_PROTOCOL_VERSION,
    },
    oldAuthority: {
      caFingerprint: manifest.comparison.sourceCaFingerprint,
      endpoint: canonicalHttpsOrigin(input.oldEndpoint, 'oldEndpoint'),
      gitRemoteUrl: canonicalHttpsUrl(input.oldGitRemoteUrl, 'oldGitRemoteUrl'),
      sourceHostMemberId: manifest.comparison.sourceHostMemberId,
    },
    phase: 'intent',
    projectId: manifest.comparison.projectId,
    repositoryIdentity: {
      mainOid: manifest.comparison.mainOid,
      objectFormat: manifest.git.objectFormat,
      personalRef,
      personalRefOid,
    },
    schemaVersion: CLOUD_BOOTSTRAP_TRANSITION_SCHEMA_VERSION,
    terminalCleanupCompleted: false,
    updatedAt: input.timestamp,
  });
}

export function markCloudBootstrapTerminalCleanupCompleted(
  record: CloudBootstrapTransitionRecord,
  updatedAt: CollabIsoTimestamp,
): CloudBootstrapTransitionRecord {
  const current = decodeCloudBootstrapTransitionRecord(record);
  if (
    current.attemptState === 'pending'
    || (current.attemptState === 'activated' && current.phase !== 'fence-terminal')
  ) {
    throw new TypeError('Cloud bootstrap attempt is not terminal');
  }
  if (current.terminalCleanupCompleted) return current;
  return decodeCloudBootstrapTransitionRecord({
    ...current,
    terminalCleanupCompleted: true,
    updatedAt,
  });
}

export function advanceCloudBootstrapTransitionPhase(
  record: CloudBootstrapTransitionRecord,
  nextPhase: CloudBootstrapTransitionPhase,
  updatedAt: CollabIsoTimestamp,
): CloudBootstrapTransitionRecord {
  const current = decodeCloudBootstrapTransitionRecord(record);
  if (current.attemptState !== 'activated') {
    throw new TypeError('Cloud bootstrap attempt is not activated');
  }
  const currentIndex = CLOUD_BOOTSTRAP_TRANSITION_PHASES.indexOf(current.phase);
  const nextIndex = CLOUD_BOOTSTRAP_TRANSITION_PHASES.indexOf(nextPhase);
  if (nextIndex === currentIndex) return current;
  if (nextIndex !== currentIndex + 1) {
    throw new TypeError('Invalid Cloud bootstrap transition phase');
  }
  if (
    nextPhase === 'fence-terminal'
    && current.fence.state !== 'host-stopped'
    && current.fence.state !== 'not-applicable'
  ) {
    throw new TypeError('Cloud bootstrap Host fence is not stopped');
  }
  return decodeCloudBootstrapTransitionRecord({
    ...current,
    fence: nextPhase === 'fence-terminal' && current.fence.state === 'host-stopped'
      ? { ...current.fence, state: 'terminal' }
      : current.fence,
    phase: nextPhase,
    updatedAt,
  });
}

export function markCloudBootstrapHostStopped(
  record: CloudBootstrapTransitionRecord,
  stoppedAt: CollabIsoTimestamp,
  updatedAt: CollabIsoTimestamp,
): CloudBootstrapTransitionRecord {
  const current = decodeCloudBootstrapTransitionRecord(record);
  if (current.fence.state === 'host-stopped') return current;
  if (current.fence.state !== 'active') {
    throw new TypeError('Cloud bootstrap Host fence is not active');
  }
  return decodeCloudBootstrapTransitionRecord({
    ...current,
    fence: {
      fenceId: current.fence.fenceId,
      state: 'host-stopped',
      stoppedAt,
    },
    updatedAt,
  });
}

export function observeCloudBootstrapAttemptStatus(
  record: CloudBootstrapTransitionRecord,
  status: DevelopmentBootstrapAttemptStatus,
  updatedAt: CollabIsoTimestamp,
): CloudBootstrapTransitionRecord {
  const current = decodeCloudBootstrapTransitionRecord(record);
  if (
    status.attemptId !== current.attemptId
    || status.projectId !== current.projectId
    || status.manifestSha256 !== current.manifestSha256
  ) {
    throw new TypeError('Cloud bootstrap attempt identity mismatch');
  }
  if (status.state === 'activated') {
    if (
      status.activationPhase !== 'completed'
      || !status.activationResult
      || (current.fence.state !== 'host-stopped'
        && current.fence.state !== 'not-applicable')
    ) {
      throw new TypeError('Incomplete Cloud bootstrap activation');
    }
    return decodeCloudBootstrapTransitionRecord({
      ...current,
      activationResult: status.activationResult,
      attemptState: 'activated',
      updatedAt,
    });
  }
  if (status.state === 'cancelled') {
    if (status.cancellationPhase !== 'cancelled' || current.activationResult !== null) {
      throw new TypeError('Incomplete Cloud bootstrap cancellation');
    }
    return decodeCloudBootstrapTransitionRecord({
      ...current,
      attemptState: 'cancelled',
      fence: current.fence.state === 'not-applicable'
        ? current.fence
        : {
            fenceId: current.fence.fenceId,
            state: 'released-before-activation',
            stoppedAt: current.fence.stoppedAt,
          },
      updatedAt,
    });
  }
  return current;
}
