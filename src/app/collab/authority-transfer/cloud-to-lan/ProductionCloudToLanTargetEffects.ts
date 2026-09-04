import {
  constants as cryptoConstants,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  X509Certificate,
} from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  type AcceptCloudToLanTransferTargetRequest,
  type ClaimTransferredMembershipRequest,
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  type CollabAuthorityRelinquishmentProof,
  type CollabCloudAuthorityTransferArtifact,
  type CollabCloudToLanTargetCleanupProof,
  type CollabMemberId,
  type CollabProjectCheckpointManifest,
  type CollabTransferredMembershipClaimBatch,
  type CollabTransferredMembershipRedemptionReceipt,
  decodeCollabCloudToLanTargetCleanupProof,
  decodeCollabProjectCheckpointCoordinationNdjson,
  decodeCollabTransferredMembershipClaimBatch,
  decodeCollabTransferredMembershipRedemptionReceipt,
  encodeCollabCloudToLanTargetCleanupProofSigningInput,
  encodeCollabTransferredMembershipClaimBatchDigestInput,
  encodeCollabTransferredMembershipRedemptionReceiptSigningInput,
} from '@claudian-collab/protocol';

import { PendingMembershipRepository } from '@/app/collab/authority/PendingMembershipRepository';
import { verifyAuthorityRelinquishmentProof } from '@/app/collab/authority-transfer/AuthorityRelinquishmentProofVerifier';
import {
  type AuthorityTransferImportedTargetIdentity,
  decodeAuthorityTransferImportedTargetIdentity,
} from '@/app/collab/authority-transfer/AuthorityTransferImportedTargetIdentity';
import type { AuthorityTransferLocalConvergence } from '@/app/collab/authority-transfer/AuthorityTransferLocalConvergence';
import {
  authorityTransferChildIdempotencyKey,
} from '@/app/collab/authority-transfer/AuthorityTransferOperationIdentity';
import type { AuthorityTransferRecord } from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import { AuthorityTransferCheckpointGit } from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferCheckpointGit';
import { verifyAuthorityTransferCheckpointManifest } from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferCheckpointManifest';
import { AuthorityTransferCheckpointRepository } from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferCheckpointRepository';
import type {
  CloudToLanDownloadedArtifact,
  CloudToLanTargetEffects,
  CloudToLanTargetStageResult,
} from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLanTargetCoordinator';
import {
  removeDurablePrivateFile,
  writeDurablePrivateFile,
} from '@/app/collab/authority-transfer/DurablePrivateFile';
import type { AuthorityTransferPersistence } from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import type {
  ClaudianCollabService,
  CollabAuthorityFoundation,
} from '@/app/collab/ClaudianCollabService';
import {
  type CollabLocalLanMembershipRecord,
  isCollabLocalCloudMembership,
  isCollabLocalLanMembership,
} from '@/app/collab/CollabLocalProjectRepository';
import type {
  LanAuthorityTransferRouteRegistration,
  LanAuthorityTransferTargetStagedService,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferRouter';
import { PersistentLanAuthorityTransferTargetActiveService } from '@/app/collab/lan/authority-transfer/PersistentLanAuthorityTransferServices';
import type { LanHostAuthorityTransferPreparation } from '@/app/collab/lan/LanHostCoordinator';
import { fingerprintCertificatePem } from '@/app/collab/lan/LanTlsIdentity';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import type { CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const MANIFEST_FILE = 'checkpoint.json';
const COORDINATION_FILE = 'coordination.ndjson';
const BUNDLE_FILE = 'repository.bundle';
const TARGET_STATE_FILE = 'target-private.json';
const AUTHORITY_TARGET_STATE_FILE = 'authority-transfer-target.json';

interface TargetReceiptKey {
  readonly privateKey: string;
  readonly publicKey: string;
  readonly receiptKeyId: string;
}

interface TargetPrivateState {
  readonly claimBatch: CollabTransferredMembershipClaimBatch | null;
  readonly cleanup: TargetCleanupState | null;
  readonly hostCredential: string;
  readonly importedIdentity: AuthorityTransferImportedTargetIdentity | null;
  readonly receiptKey: TargetReceiptKey;
  readonly receipts: Readonly<Record<string, CollabTransferredMembershipRedemptionReceipt>>;
  readonly schemaVersion: 2;
  readonly targetProof: string | null;
  readonly transferCredential: string;
  readonly transferId: string | null;
}

interface TargetCleanupState {
  readonly cleanupSha256: string;
  readonly invalidatedAt: string;
  readonly operationIntentId: string;
  readonly proof: CollabCloudToLanTargetCleanupProof | null;
}

const TARGET_PRIVATE_STATE_KEYS = [
  'claimBatch',
  'cleanup',
  'hostCredential',
  'importedIdentity',
  'receiptKey',
  'receipts',
  'schemaVersion',
  'targetProof',
  'transferCredential',
  'transferId',
] as const;

interface TargetProofEnvelope {
  readonly caCertificatePem: string;
  readonly caFingerprint: string;
  readonly certificate: string;
  readonly payload: Readonly<{
    readonly projectId: string;
    readonly receiptKeyId: string;
    readonly receiptPublicKey: string;
    readonly targetAuthorityGeneration: number;
    readonly targetHostMemberId: string;
    readonly targetUrl: string;
    readonly transferCredential: string;
    readonly transferId: string;
  }>;
  readonly schemaVersion: 1;
}

const TARGET_PROOF_KEYS = [
  'caCertificatePem',
  'caFingerprint',
  'certificate',
  'payload',
  'schemaVersion',
] as const;
const TARGET_PROOF_PAYLOAD_KEYS = [
  'projectId',
  'receiptKeyId',
  'receiptPublicKey',
  'targetAuthorityGeneration',
  'targetHostMemberId',
  'targetUrl',
  'transferCredential',
  'transferId',
] as const;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function isCanonicalBase64Url(value: unknown, byteLength?: number): value is string {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value
    && (byteLength === undefined || decoded.byteLength === byteLength);
}

function encodeTargetProofPayload(payload: TargetProofEnvelope['payload']): string {
  return JSON.stringify({
    projectId: payload.projectId,
    receiptKeyId: payload.receiptKeyId,
    receiptPublicKey: payload.receiptPublicKey,
    targetAuthorityGeneration: payload.targetAuthorityGeneration,
    targetHostMemberId: payload.targetHostMemberId,
    targetUrl: payload.targetUrl,
    transferCredential: payload.transferCredential,
    transferId: payload.transferId,
  });
}

function decodeTargetProof(value: string): TargetProofEnvelope {
  if (!isCanonicalBase64Url(value) || Buffer.from(value, 'base64url').byteLength > 128 * 1024) {
    throw targetError('authority-transfer-target-proof-invalid');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw targetError('authority-transfer-target-proof-invalid');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw targetError('authority-transfer-target-proof-invalid');
  }
  const envelope = decoded as Readonly<Record<string, unknown>>;
  if (!hasExactKeys(envelope, TARGET_PROOF_KEYS) || envelope.schemaVersion !== 1) {
    throw targetError('authority-transfer-target-proof-invalid');
  }
  if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
    throw targetError('authority-transfer-target-proof-invalid');
  }
  const payload = envelope.payload as Readonly<Record<string, unknown>>;
  if (
    !hasExactKeys(payload, TARGET_PROOF_PAYLOAD_KEYS)
    || typeof envelope.caCertificatePem !== 'string'
    || envelope.caCertificatePem.length > 64 * 1024
    || typeof envelope.caFingerprint !== 'string'
    || !FINGERPRINT_PATTERN.test(envelope.caFingerprint)
    || !isCanonicalBase64Url(envelope.certificate)
    || Buffer.from(envelope.certificate, 'base64url').byteLength > 2048
    || typeof payload.projectId !== 'string'
    || typeof payload.receiptKeyId !== 'string'
    || !isCanonicalBase64Url(payload.receiptPublicKey, 32)
    || !Number.isSafeInteger(payload.targetAuthorityGeneration)
    || (payload.targetAuthorityGeneration as number) < 1
    || typeof payload.targetHostMemberId !== 'string'
    || typeof payload.targetUrl !== 'string'
    || !isCanonicalBase64Url(payload.transferCredential, 32)
    || typeof payload.transferId !== 'string'
  ) throw targetError('authority-transfer-target-proof-invalid');
  return decoded as TargetProofEnvelope;
}

export interface ProductionCloudToLanTargetEffectsOptions {
  readonly cloudSession: Readonly<{ readonly serverUrl: string }> | null;
  readonly convergence: AuthorityTransferLocalConvergence;
  readonly foundation: ClaudianCollabService;
  readonly now?: () => Date;
  readonly persistence: AuthorityTransferPersistence;
  readonly projectId: string;
}

type LanClaimRequest = Extract<
  ClaimTransferredMembershipRequest,
  { readonly credentialHash: string }
>;

function targetError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function projectsFolder(workspacePath: string): string {
  const separator = workspacePath.lastIndexOf('/');
  if (separator <= 0) throw targetError('authority-transfer-workspace-path-invalid');
  return workspacePath.slice(0, separator);
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function credential(): string {
  return randomBytes(32).toString('base64url');
}

function receiptKey(): TargetReceiptKey {
  const pair = generateKeyPairSync('ed25519');
  const publicKey = pair.publicKey.export({ format: 'jwk' }).x;
  if (!publicKey) throw targetError('authority-transfer-target-key-invalid');
  return {
    privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    publicKey,
    receiptKeyId: `lan-${sha256(publicKey).slice(0, 32)}`,
  };
}

function initialState(): TargetPrivateState {
  return {
    claimBatch: null,
    cleanup: null,
    hostCredential: credential(),
    importedIdentity: null,
    receiptKey: receiptKey(),
    receipts: {},
    schemaVersion: 2,
    targetProof: null,
    transferCredential: credential(),
    transferId: null,
  };
}

function assertState(value: unknown): TargetPrivateState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw targetError('authority-transfer-target-state-invalid');
  }
  const state = value as Partial<TargetPrivateState>;
  const schemaVersion = (value as { readonly schemaVersion?: unknown }).schemaVersion;
  if (
    schemaVersion !== 2
    || !hasExactKeys(value as Record<string, unknown>, TARGET_PRIVATE_STATE_KEYS)
    || typeof state.hostCredential !== 'string'
    || Buffer.from(state.hostCredential, 'base64url').byteLength !== 32
    || typeof state.transferCredential !== 'string'
    || Buffer.from(state.transferCredential, 'base64url').byteLength !== 32
    || !state.receiptKey
    || typeof state.receiptKey.privateKey !== 'string'
    || typeof state.receiptKey.publicKey !== 'string'
    || typeof state.receiptKey.receiptKeyId !== 'string'
    || !state.receipts
    || typeof state.receipts !== 'object'
    || Array.isArray(state.receipts)
    || (state.transferId !== null && typeof state.transferId !== 'string')
    || (state.targetProof !== null && typeof state.targetProof !== 'string')
  ) throw targetError('authority-transfer-target-state-invalid');
  let cleanup: TargetCleanupState | null = null;
  if (state.cleanup !== null) {
    if (
      !state.cleanup
      || typeof state.cleanup !== 'object'
      || Array.isArray(state.cleanup)
      || !hasExactKeys(state.cleanup as unknown as Record<string, unknown>, [
        'cleanupSha256',
        'invalidatedAt',
        'operationIntentId',
        'proof',
      ])
      || typeof state.cleanup.cleanupSha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(state.cleanup.cleanupSha256)
      || typeof state.cleanup.invalidatedAt !== 'string'
      || !Number.isFinite(Date.parse(state.cleanup.invalidatedAt))
      || typeof state.cleanup.operationIntentId !== 'string'
    ) throw targetError('authority-transfer-target-state-invalid');
    try {
      cleanup = {
        cleanupSha256: state.cleanup.cleanupSha256,
        invalidatedAt: state.cleanup.invalidatedAt,
        operationIntentId: state.cleanup.operationIntentId,
        proof: state.cleanup.proof === null
          ? null
          : decodeCollabCloudToLanTargetCleanupProof(state.cleanup.proof),
      };
    } catch {
      throw targetError('authority-transfer-target-state-invalid');
    }
  }
  let importedIdentity: AuthorityTransferImportedTargetIdentity | null;
  try {
    importedIdentity = state.importedIdentity === null
      ? null
      : decodeAuthorityTransferImportedTargetIdentity(state.importedIdentity);
  } catch {
    throw targetError('authority-transfer-target-state-invalid');
  }
  return {
    ...(state as Omit<TargetPrivateState, 'cleanup' | 'importedIdentity' | 'schemaVersion'>),
    cleanup,
    importedIdentity,
    schemaVersion: 2,
  };
}

async function readState(filePath: string): Promise<TargetPrivateState | null> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) {
      throw targetError('authority-transfer-target-state-invalid');
    }
    return assertState(JSON.parse(await readFile(filePath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof CollabError) throw error;
    throw targetError('authority-transfer-target-state-invalid');
  }
}

async function writeState(filePath: string, state: TargetPrivateState): Promise<void> {
  await writeDurablePrivateFile(filePath, `${JSON.stringify(state)}\n`, {
    invalidFile: () => targetError('authority-transfer-target-state-invalid'),
    writeFailed: () => targetError('authority-transfer-target-state-write-failed'),
  });
}

function targetCleanupInvalidatedAt(now: Date, record: AuthorityTransferRecord): string {
  const minimum = Date.parse(record.status.updatedAt) + 1;
  return new Date(Math.max(now.getTime(), minimum)).toISOString();
}

function targetStageSha256(state: TargetPrivateState): string | null {
  if (!state.claimBatch || !state.targetProof) return null;
  return sha256(JSON.stringify({
    batchSha256: state.claimBatch.batchSha256,
    manifestSha256: state.claimBatch.checkpointSha256,
    targetProof: state.targetProof,
  }));
}

function targetCleanupBatchFacts(
  record: AuthorityTransferRecord,
  state: TargetPrivateState,
): Readonly<{
  readonly batchRevision: number | null;
  readonly batchSha256: string | null;
  readonly checkpointSha256: string | null;
}> {
  if (!state.claimBatch) {
    return {
      batchRevision: record.status.batchRevision,
      batchSha256: record.status.batchSha256,
      checkpointSha256: record.status.checkpointSha256,
    };
  }
  let batch: CollabTransferredMembershipClaimBatch;
  try {
    batch = decodeCollabTransferredMembershipClaimBatch(state.claimBatch);
  } catch {
    throw targetError('authority-transfer-target-state-owner-mismatch');
  }
  if (
    batch.projectId !== record.projectId
    || batch.transferId !== record.transferId
    || batch.targetAuthorityGeneration !== record.status.targetAuthority.generation
    || batch.checkpointSha256 !== record.status.checkpointSha256
    || batch.batchSha256 !== sha256(
      encodeCollabTransferredMembershipClaimBatchDigestInput(batch),
    )
    || (
      record.status.batchRevision !== null
      && batch.batchRevision !== record.status.batchRevision
    )
    || (
      record.status.batchSha256 !== null
      && batch.batchSha256 !== record.status.batchSha256
    )
  ) throw targetError('authority-transfer-target-state-owner-mismatch');
  return {
    batchRevision: batch.batchRevision,
    batchSha256: batch.batchSha256,
    checkpointSha256: batch.checkpointSha256,
  };
}

function targetCleanupSha256(input: Readonly<{
  readonly batchRevision: number | null;
  readonly batchSha256: string | null;
  readonly checkpointSha256: string | null;
  readonly invalidatedAt: string;
  readonly operationIntentId: string;
  readonly record: AuthorityTransferRecord;
  readonly stageSha256: string | null;
  readonly targetHostMemberId: string;
}>): string {
  return sha256(JSON.stringify({
    domain: 'claudian-collab.cloud-to-lan-target-cleanup.v1',
    payload: {
      batchRevision: input.batchRevision,
      batchSha256: input.batchSha256,
      checkpointSha256: input.checkpointSha256,
      invalidatedAt: input.invalidatedAt,
      operationIntentId: input.operationIntentId,
      projectId: input.record.projectId,
      sourceAuthority: input.record.status.sourceAuthority,
      stageSha256: input.stageSha256,
      targetAuthority: input.record.status.targetAuthority,
      targetHostMemberId: input.targetHostMemberId,
      transferId: input.record.transferId,
    },
  }));
}

function artifactLimit(artifact: CollabCloudAuthorityTransferArtifact): number {
  switch (artifact) {
    case MANIFEST_FILE: return COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxManifestBytes;
    case COORDINATION_FILE: return COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxCoordinationBytes;
    case BUNDLE_FILE: return COLLAB_CHECKPOINT_ARTIFACT_LIMITS.maxRepositoryBundleBytes;
  }
}

async function receiveArtifact(
  stagingPath: string,
  input: CloudToLanDownloadedArtifact,
  signal?: AbortSignal,
): Promise<void> {
  if (input.byteCount < 1 || input.byteCount > artifactLimit(input.artifact)) {
    throw targetError('authority-transfer-target-artifact-size-invalid');
  }
  const destination = path.join(stagingPath, input.artifact);
  const partial = `${destination}.partial`;
  await rm(partial, { force: true }).catch(() => undefined);
  try {
    await pipeline(
      input.body,
      createWriteStream(partial, { flags: 'wx', mode: 0o600 }),
      signal ? { signal } : {},
    );
    const info = await lstat(partial);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== input.byteCount) {
      throw targetError('authority-transfer-target-artifact-size-mismatch');
    }
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true }).catch(() => undefined);
    throw error;
  }
}

function assertArtifact(
  manifest: CollabProjectCheckpointManifest,
  name: typeof COORDINATION_FILE | typeof BUNDLE_FILE,
  bytes: Buffer,
): void {
  const fact = manifest.artifacts.find(candidate => candidate.name === name);
  if (!fact || fact.byteCount !== bytes.byteLength || fact.sha256 !== sha256(bytes)) {
    throw targetError('authority-transfer-target-artifact-digest-mismatch');
  }
}

async function assertArtifactFile(
  manifest: CollabProjectCheckpointManifest,
  name: typeof BUNDLE_FILE,
  filePath: string,
): Promise<void> {
  const fact = manifest.artifacts.find(candidate => candidate.name === name);
  const info = await lstat(filePath).catch(() => null);
  if (!fact || !info || !info.isFile() || info.isSymbolicLink() || info.size !== fact.byteCount) {
    throw targetError('authority-transfer-target-artifact-digest-mismatch');
  }
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) digest.update(chunk as Buffer);
  if (digest.digest('hex') !== fact.sha256) {
    throw targetError('authority-transfer-target-artifact-digest-mismatch');
  }
}

function claimBatch(
  record: AuthorityTransferRecord,
  manifest: CollabProjectCheckpointManifest,
  coordination: string,
  targetHostMemberId: string,
): CollabTransferredMembershipClaimBatch {
  const claims = decodeCollabProjectCheckpointCoordinationNdjson(
    coordination,
    'authority-transfer',
  ).filter(candidate => (
    candidate.kind === 'member'
    && candidate.value.status === 'active'
    && candidate.value.memberId !== targetHostMemberId
  )).map(candidate => {
    if (candidate.kind !== 'member') throw targetError('authority-transfer-member-invalid');
    return { claim: credential(), memberId: candidate.value.memberId };
  }).sort((left, right) => left.memberId.localeCompare(right.memberId, 'en-US'));
  const unsigned = {
    batchRevision: 1,
    batchSha256: '0'.repeat(64),
    checkpointSha256: manifest.manifestSha256,
    claims,
    expiresAt: record.status.expiresAt,
    projectId: record.projectId,
    targetAuthorityGeneration: record.status.targetAuthority.generation,
    transferId: record.transferId,
  };
  return decodeCollabTransferredMembershipClaimBatch({
    ...unsigned,
    batchSha256: sha256(encodeCollabTransferredMembershipClaimBatchDigestInput(unsigned)),
  });
}

export class ProductionCloudToLanTargetEffects implements CloudToLanTargetEffects {
   #activeRegistration: LanAuthorityTransferRouteRegistration | null = null;
  private readonly now: () => Date;
   #preparation: LanHostAuthorityTransferPreparation | null = null;
  private readonly queue = new SerialTaskQueue();
   #stagedRegistration: LanAuthorityTransferRouteRegistration | null = null;

  constructor(private readonly options: ProductionCloudToLanTargetEffectsOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async dispose(): Promise<void> {
    const preparation = this.#preparation;
    if (!preparation) return;
    await preparation.dispose();
    if (this.#preparation === preparation) this.#preparation = null;
  }

  async prepareTarget(expectedEndpoint?: string): Promise<Readonly<{
    readonly caCertificatePem: string;
    readonly caFingerprint: string;
    readonly targetUrl: string;
  }>> {
    if (!this.#preparation) {
      this.#preparation = await this.options.foundation.lanHost.prepareAuthorityTransferTarget(
        expectedEndpoint ?? null,
      );
    }
    if (expectedEndpoint && this.#preparation.endpoint !== expectedEndpoint) {
      throw targetError('authority-transfer-target-url-mismatch');
    }
    return {
      caCertificatePem: this.#preparation.caCertificatePem,
      caFingerprint: this.#preparation.caFingerprint,
      targetUrl: this.#preparation.endpoint,
    };
  }

  async acceptanceRequest(
    record: AuthorityTransferRecord,
  ): Promise<AcceptCloudToLanTransferTargetRequest> {
    return this.queue.run(async () => {
      const { memberId, stagingPath, state: initial } = await this.#prepareState(record);
      const prepared = await this.prepareTarget(record.status.targetUrl);
      const preparation = this.#preparation;
      if (!preparation) throw targetError('authority-transfer-target-preparation-missing');
      if (record.status.targetUrl !== prepared.targetUrl) {
        throw targetError('authority-transfer-target-url-mismatch');
      }
      let state = initial;
      if (state.transferId === null) {
        const payload = {
          projectId: record.projectId,
          receiptKeyId: state.receiptKey.receiptKeyId,
          receiptPublicKey: state.receiptKey.publicKey,
          targetAuthorityGeneration: record.status.targetAuthority.generation,
          targetHostMemberId: memberId,
          targetUrl: prepared.targetUrl,
          transferCredential: state.transferCredential,
          transferId: record.transferId,
        };
        const signer = await this.options.foundation.lanHost.hostCaSigner();
        const proof: TargetProofEnvelope = {
          caCertificatePem: preparation.caCertificatePem,
          caFingerprint: preparation.caFingerprint,
          certificate: await signer.signRsaPssSha256(
            Buffer.from(encodeTargetProofPayload(payload), 'utf8'),
          ),
          payload,
          schemaVersion: 1,
        };
        state = {
          ...state,
          targetProof: Buffer.from(JSON.stringify(proof), 'utf8').toString('base64url'),
          transferId: record.transferId,
        };
        await writeState(path.join(stagingPath, TARGET_STATE_FILE), state);
      }
      if (state.transferId !== record.transferId || !state.targetProof) {
        throw targetError('authority-transfer-target-state-owner-mismatch');
      }
      await this.#ensureStagedRoute(record, state);
      return {
        idempotencyKey: authorityTransferChildIdempotencyKey(
          record.operationIntentId,
          'accept',
        ),
        projectId: record.projectId,
        targetHostMemberId: memberId,
        targetProof: state.targetProof,
        transferId: record.transferId,
      };
    });
  }

  async stage(
    record: AuthorityTransferRecord,
    artifacts: readonly CloudToLanDownloadedArtifact[],
    options: CollabOperationOptions = {},
  ): Promise<CloudToLanTargetStageResult> {
    return this.queue.run(async () => {
      const { memberId, stagingPath } = await this.#prepareState(record);
      for (const artifact of artifacts) {
        await receiveArtifact(stagingPath, artifact, options.signal);
      }
      const manifestValue: unknown = JSON.parse(
        await readFile(path.join(stagingPath, MANIFEST_FILE), 'utf8'),
      );
      const manifest = verifyAuthorityTransferCheckpointManifest(manifestValue);
      if (
        manifest.projectId !== record.projectId
        || manifest.operationId !== record.transferId
        || manifest.targetAuthority?.kind !== 'lan'
        || manifest.targetAuthority.generation !== record.status.targetAuthority.generation
        || (record.status.checkpointSha256 !== null
          && record.status.checkpointSha256 !== manifest.manifestSha256)
      ) throw targetError('authority-transfer-target-manifest-owner-mismatch');
      const coordinationBytes = await readFile(path.join(stagingPath, COORDINATION_FILE));
      assertArtifact(manifest, COORDINATION_FILE, coordinationBytes);
      await assertArtifactFile(manifest, BUNDLE_FILE, path.join(stagingPath, BUNDLE_FILE));
      let state = (await readState(path.join(stagingPath, TARGET_STATE_FILE)))!;
      const targetProof = await this.#validatePreparedStateBindings(record, state);
      if (targetProof.payload.targetHostMemberId !== memberId) {
        throw targetError('authority-transfer-target-imported-identity-mismatch');
      }
      if (state.claimBatch === null) {
        await this.options.foundation.discardAuthorityTransferTarget(
          record.projectId,
          record.ownerInstallationKey,
        );
        const authority = await this.options.foundation.openAuthorityTransferTarget(
          record.projectId,
          record.ownerInstallationKey,
        );
        const git = await this.options.foundation.requireGitFoundation();
        const checkpoint = new AuthorityTransferCheckpointRepository();
        let importedIdentity: AuthorityTransferImportedTargetIdentity;
        try {
          importedIdentity = (await authority.database.mutate(connection => checkpoint.importCoordination(connection, {
            coordinationNdjson: coordinationBytes.toString('utf8'),
            manifest,
            targetHostCredentialHash: createHash('sha256')
              .update(state.hostCredential, 'utf8')
              .digest(),
            targetHostMemberId: memberId,
          }))).value;
          await new AuthorityTransferCheckpointGit(git.runner).importIntoEmptyBareRepository({
            bundlePath: path.join(stagingPath, BUNDLE_FILE),
            manifest,
            ...(options.signal ? { signal: options.signal } : {}),
            targetRepositoryPath: path.join(authority.authorityDirectory, 'repository.git'),
          });
        } finally {
          await authority.database.close();
        }
        if (
          importedIdentity.project.id !== record.projectId
          || importedIdentity.authorityGeneration !== record.status.targetAuthority.generation
          || importedIdentity.currentMember.id !== memberId
        ) throw targetError('authority-transfer-target-imported-identity-mismatch');
        state = {
          ...state,
          claimBatch: claimBatch(
            record,
            manifest,
            coordinationBytes.toString('utf8'),
            memberId,
          ),
          importedIdentity,
        };
        await writeState(path.join(stagingPath, TARGET_STATE_FILE), state);
      }
      if (!state.claimBatch || !state.importedIdentity || !state.targetProof) {
        throw targetError('authority-transfer-target-stage-incomplete');
      }
      return {
        claimBatch: state.claimBatch,
        checkpointSha256: manifest.manifestSha256,
        stageSha256: sha256(JSON.stringify({
          batchSha256: state.claimBatch.batchSha256,
          manifestSha256: manifest.manifestSha256,
          targetProof: state.targetProof,
        })),
        targetAuthority: {
          generation: record.status.targetAuthority.generation,
          kind: 'lan',
        },
        targetHostMemberId: state.importedIdentity.currentMember.id,
        targetProof: state.targetProof,
      };
    });
  }

  async activate(
    record: AuthorityTransferRecord,
    proof: CollabAuthorityRelinquishmentProof,
  ): Promise<string> {
    return this.queue.run(async () => (
      this.#activateLocal(record, proof).then(({ state }) => (
        this.signActivation(record, proof, state)
      ))
    ));
  }

  async converge(
    record: AuthorityTransferRecord,
    proof: CollabAuthorityRelinquishmentProof,
  ): Promise<void> {
    return this.queue.run(() => this.#convergeLocal(record, proof));
  }

  async restoreCompleted(record: AuthorityTransferRecord): Promise<void> {
    return this.queue.run(async () => {
      const proof = record.status.relinquishmentProof;
      if (record.status.state !== 'completed' || !proof) {
        throw targetError('authority-transfer-target-completion-missing');
      }
      const membership = await this.options.foundation.local.projects.loadMembership(
        record.projectId,
      );
      if (!membership) throw targetError('authority-transfer-membership-missing');
      const expired = this.now().getTime() >= Date.parse(record.status.expiresAt);
      const authority = await this.options.foundation.inspectAuthority(record.projectId);
      if (!authority) throw targetError('authority-transfer-target-authority-missing');
      const state = await readState(
        path.join(authority.authorityDirectory, AUTHORITY_TARGET_STATE_FILE),
      );
      if (!state) {
        if (expired) {
          await this.options.foundation.lanHost.stopAuthorityTransferRoute(
            record.projectId,
            'target-active',
          );
          this.#activeRegistration = null;
          await this.#expireActiveRouteUnlocked(record);
          return;
        }
        throw targetError('authority-transfer-target-state-owner-mismatch');
      }
      const targetProof = await this.#assertActiveState(record, proof, state, authority);
      await this.#convergePersistedState(record, state, targetProof, authority);
      if (expired) {
        await this.options.foundation.lanHost.stopAuthorityTransferRoute(
          record.projectId,
          'target-active',
        );
        this.#activeRegistration = null;
        await this.#expireActiveRouteUnlocked(record);
      } else {
        await this.#startActiveRoute(record, state);
      }
    });
  }

  async invalidateStaging(
    record: AuthorityTransferRecord,
  ): Promise<CollabCloudToLanTargetCleanupProof> {
    return this.queue.run(async () => {
      if (
        record.status.direction !== 'cloud-to-lan'
        || record.status.phase !== 'cancel-intent'
        || record.status.relinquishmentProof !== null
      ) throw targetError('authority-transfer-target-cancellation-invalid');
      const prepared = await this.#prepareState(record);
      const statePath = path.join(prepared.stagingPath, TARGET_STATE_FILE);
      let state = prepared.state;
      const targetProof = await this.#validatePreparedStateBindings(record, state);
      if (targetProof.payload.targetHostMemberId !== prepared.memberId) {
        throw targetError('authority-transfer-target-imported-identity-mismatch');
      }
      const operationIntentId = authorityTransferChildIdempotencyKey(
        record.operationIntentId,
        'cancel',
      );
      const stageSha256 = targetStageSha256(state);
      const batchFacts = targetCleanupBatchFacts(record, state);
      const invalidatedAt = state.cleanup?.invalidatedAt
        ?? targetCleanupInvalidatedAt(this.now(), record);
      const cleanupSha256 = targetCleanupSha256({
        ...batchFacts,
        invalidatedAt,
        operationIntentId,
        record,
        stageSha256,
        targetHostMemberId: prepared.memberId,
      });
      if (
        state.cleanup
        && (
          state.cleanup.cleanupSha256 !== cleanupSha256
          || state.cleanup.operationIntentId !== operationIntentId
        )
      ) throw targetError('authority-transfer-target-cleanup-state-mismatch');
      if (!state.cleanup) {
        state = {
          ...state,
          cleanup: {
            cleanupSha256,
            invalidatedAt,
            operationIntentId,
            proof: null,
          },
        };
        await writeState(statePath, state);
      }

      await this.options.foundation.lanHost.stopAuthorityTransferRoute(
        record.projectId,
        'target-only-staged',
      );
      this.#stagedRegistration = null;
      const preparation = this.#preparation;
      await preparation?.dispose();
      if (this.#preparation === preparation) this.#preparation = null;
      await this.options.foundation.discardAuthorityTransferTarget(
        record.projectId,
        record.ownerInstallationKey,
      );

      if (state.cleanup?.proof) return state.cleanup.proof;
      const payload = {
        ...batchFacts,
        cleanupSha256,
        invalidatedAt,
        operationIntentId,
        projectId: record.projectId,
        receiptKeyId: state.receiptKey.receiptKeyId,
        signatureAlgorithm: 'ed25519' as const,
        sourceAuthority: record.status.sourceAuthority as { readonly generation: number; readonly kind: 'cloud' },
        stageSha256,
        targetAuthority: record.status.targetAuthority as { readonly generation: number; readonly kind: 'lan' },
        targetHostMemberId: prepared.memberId,
        transferId: record.transferId,
      };
      const proof = decodeCollabCloudToLanTargetCleanupProof({
        ...payload,
        signature: sign(
          null,
          Buffer.from(encodeCollabCloudToLanTargetCleanupProofSigningInput(payload), 'utf8'),
          createPrivateKey({
            format: 'der',
            key: Buffer.from(state.receiptKey.privateKey, 'base64url'),
            type: 'pkcs8',
          }),
        ).toString('base64url'),
      });
      state = {
        ...state,
        cleanup: {
          cleanupSha256,
          invalidatedAt,
          operationIntentId,
          proof,
        },
      };
      await writeState(statePath, state);
      return proof;
    });
  }

  async cancelStaging(record: AuthorityTransferRecord): Promise<void> {
    await this.options.foundation.lanHost.stopAuthorityTransferRoute(
      record.projectId,
      'target-only-staged',
    );
    this.#stagedRegistration = null;
    const preparation = this.#preparation;
    await preparation?.dispose();
    if (this.#preparation === preparation) this.#preparation = null;
    await this.options.foundation.discardAuthorityTransferTarget(
      record.projectId,
      record.ownerInstallationKey,
    );
    await this.#cleanupStaging(record);
  }

   async #activateRoute(
    record: AuthorityTransferRecord,
    proof: CollabAuthorityRelinquishmentProof,
    state: TargetPrivateState,
  ): Promise<void> {
    if (this.#activeRegistration) return;
    await this.#ensureStagedRoute(record, state);
    const expected = this.#stagedRegistration;
    if (!expected) throw targetError('authority-transfer-target-route-missing');
    const service = this.#activeService(record);
    const next: LanAuthorityTransferRouteRegistration = {
      expectedEndpoint: record.status.targetUrl,
      projectId: record.projectId,
      service,
      state: 'target-active',
      transferId: record.transferId,
    };
    await this.options.foundation.lanHost.transitionAuthorityTransferRoute({
      expected,
      next,
      relinquishmentProof: proof,
    });
    this.#activeRegistration = next;
    this.#stagedRegistration = null;
  }

   #activeService(record: AuthorityTransferRecord) {
    return new PersistentLanAuthorityTransferTargetActiveService({
      bind: request => this.#bindClaim(record, request),
      expire: () => this.#expireActiveRoute(record),
      expiresAt: record.status.expiresAt,
      projectId: record.projectId,
      targetAuthorityGeneration: record.status.targetAuthority.generation,
      transferId: record.transferId,
    });
  }

   async #expireActiveRoute(record: AuthorityTransferRecord): Promise<void> {
    return this.queue.run(() => this.#expireActiveRouteUnlocked(record));
  }

   async #expireActiveRouteUnlocked(record: AuthorityTransferRecord): Promise<void> {
    const current = await this.#assertExpiredRecordCurrent(record);
    if (current.terminalCleanupCompleted) {
      await this.options.persistence.completeTerminalCleanup({
        operationIntentId: current.operationIntentId,
        projectId: current.projectId,
        stagingDirectoryName: current.stagingDirectoryName,
        transferId: current.transferId,
      });
      return;
    }
    const proof = current.status.relinquishmentProof;
    if (!proof) throw targetError('authority-transfer-target-completion-missing');
    const authority = await this.options.foundation.inspectAuthority(current.projectId);
    if (!authority) throw targetError('authority-transfer-target-authority-missing');
    const state = await readState(
      path.join(authority.authorityDirectory, AUTHORITY_TARGET_STATE_FILE),
    );
    if (!state) {
      const membership = await this.#assertCompletedTargetConvergence(
        current,
        authority,
        null,
        null,
        false,
      );
      await this.options.persistence.assertCloudToLanCompletedTargetIdentity({
        memberId: membership.member.id,
        operationIntentId: current.operationIntentId,
        personalRef: membership.member.personalRef,
        projectId: current.projectId,
        transferId: current.transferId,
      });
      await this.#startConfiguredHost(current);
      await this.#completeExpiredTargetCleanup(current, authority);
      return;
    }
    const targetProof = await this.#assertActiveState(current, proof, state, authority);
    await this.#assertCompletedTargetConvergence(
      current,
      authority,
      state,
      targetProof,
      true,
    );
    await this.#completeExpiredTargetCleanup(current, authority);
  }

   async #assertExpiredRecordCurrent(
    record: AuthorityTransferRecord,
  ): Promise<AuthorityTransferRecord> {
    if (this.now().getTime() < Date.parse(record.status.expiresAt)) {
      throw targetError('authority-transfer-target-expiry-early');
    }
    const current = await this.options.persistence.load(record.projectId);
    if (
      !current
      || current.transferId !== record.transferId
      || current.operationIntentId !== record.operationIntentId
      || current.localRole !== 'target'
      || current.status.state !== 'completed'
    ) throw targetError('authority-transfer-target-expiry-owner-mismatch');
    return current;
  }

   async #assertCompletedTargetConvergence(
    record: AuthorityTransferRecord,
    authority: CollabAuthorityFoundation,
    state: TargetPrivateState | null,
    targetProof: TargetProofEnvelope | null,
    requireRunningHost: boolean,
  ): Promise<CollabLocalLanMembershipRecord> {
    const [membership, index] = await Promise.all([
      this.#assertCompletedTargetMembership(record, authority, state, targetProof),
      this.options.foundation.local.projects.loadIndex(),
    ]);
    const indexed = index.projects.find(candidate => candidate.id === record.projectId);
    if (
      !indexed
      || indexed.authorityKind !== 'lan'
      || indexed.name !== membership.project.name
      || indexed.workspacePath !== membership.project.workspacePath
      || (
        requireRunningHost
        && membership.hostOwnership.autoStart
        && !this.options.foundation.lanHost.isProjectRunning(record.projectId)
      )
    ) throw targetError('authority-transfer-target-convergence-incomplete');
    return membership;
  }

   async #assertCompletedTargetMembership(
    record: AuthorityTransferRecord,
    authority: CollabAuthorityFoundation,
    state: TargetPrivateState | null,
    targetProof: TargetProofEnvelope | null,
  ): Promise<CollabLocalLanMembershipRecord> {
    const [membership, facts, signer] = await Promise.all([
      this.options.foundation.local.projects.loadMembership(record.projectId),
      authority.database.read(connection => {
        const members = new PendingMembershipRepository();
        return {
          members: members.listCredentialRecords(connection, ['active']),
          project: authority.projects.get(connection),
        };
      }),
      this.options.foundation.lanHost.hostCaSigner(),
    ]);
    const project = facts.project;
    const targetMembers = facts.members.filter(candidate => (
      candidate.member.id === membership?.member.id
    ));
    const targetMember = targetMembers[0];
    const credentialHash = membership && isCollabLocalLanMembership(membership)
      ? createHash('sha256').update(membership.member.credential, 'utf8').digest()
      : null;
    const targetEndpoint = new URL(record.status.targetUrl).origin;
    if (
      !membership
      || !isCollabLocalLanMembership(membership)
      || membership.project.id !== record.projectId
      || membership.authority.authorityGeneration
        !== record.status.targetAuthority.generation
      || membership.authority.endpoint !== targetEndpoint
      || membership.authority.gitRemoteUrl
        !== `${targetEndpoint}/v1/git/${record.projectId}/repository.git`
      || membership.authority.hostCaCertificatePem !== signer.caCertificatePem
      || membership.authority.hostCaFingerprint !== signer.caFingerprint
      || membership.hostOwnership.ownsAuthority !== true
      || typeof membership.hostOwnership.autoStart !== 'boolean'
      || !project
      || project.projectId !== membership.project.id
      || project.name !== membership.project.name
      || project.state !== 'active'
      || project.authorityGeneration !== record.status.targetAuthority.generation
      || project.hostMemberId !== membership.member.id
      || targetMembers.length !== 1
      || targetMember?.accessState !== 'bound'
      || targetMember.member.displayName !== membership.member.displayName
      || targetMember.member.personalRef !== membership.member.personalRef
      || targetMember.member.role !== membership.member.role
      || targetMember.credentialHash === null
      || credentialHash === null
      || targetMember.credentialHash.byteLength !== credentialHash.byteLength
      || !timingSafeEqual(targetMember.credentialHash, credentialHash)
      || (state === null) !== (targetProof === null)
      || (state !== null && (
        !state.importedIdentity
        || state.hostCredential !== membership.member.credential
        || state.importedIdentity.project.id !== membership.project.id
        || state.importedIdentity.currentMember.id !== membership.member.id
        || state.importedIdentity.currentMember.personalRef !== membership.member.personalRef
        || state.importedIdentity.eventSequence > membership.lastEventSequence
        || targetProof!.caCertificatePem !== membership.authority.hostCaCertificatePem
        || targetProof!.caFingerprint !== membership.authority.hostCaFingerprint
      ))
    ) throw targetError('authority-transfer-target-convergence-incomplete');
    return membership;
  }

   async #completeExpiredTargetCleanup(
    record: AuthorityTransferRecord,
    authority: CollabAuthorityFoundation,
  ): Promise<void> {
    await this.options.persistence.expireClaims(record.projectId, record.transferId);
    await removeDurablePrivateFile(
      path.join(authority.authorityDirectory, AUTHORITY_TARGET_STATE_FILE),
      () => targetError('authority-transfer-target-state-remove-failed'),
    );
    await this.options.persistence.completeTerminalCleanup({
      operationIntentId: record.operationIntentId,
      projectId: record.projectId,
      stagingDirectoryName: record.stagingDirectoryName,
      transferId: record.transferId,
    });
  }

   async #startActiveRoute(
    record: AuthorityTransferRecord,
    state: TargetPrivateState,
  ): Promise<void> {
    if (this.#activeRegistration) return;
    const registration: LanAuthorityTransferRouteRegistration = {
      expectedEndpoint: record.status.targetUrl,
      projectId: record.projectId,
      service: this.#activeService(record),
      state: 'target-active',
      transferId: record.transferId,
    };
    await this.options.foundation.lanHost.startAuthorityTransferRoute(registration);
    this.#activeRegistration = registration;
    if (!state.claimBatch) throw targetError('authority-transfer-target-claims-missing');
  }

  async #activateLocal(
    record: AuthorityTransferRecord,
    proof: CollabAuthorityRelinquishmentProof,
  ): Promise<Readonly<{
    readonly authority: CollabAuthorityFoundation;
    readonly state: TargetPrivateState;
    readonly targetProof: TargetProofEnvelope;
  }>> {
    if (
      proof.projectId !== record.projectId
      || proof.transferId !== record.transferId
      || proof.sourceAuthority.kind !== 'cloud'
      || proof.targetAuthority.kind !== 'lan'
    ) throw targetError('authority-transfer-target-relinquishment-mismatch');
    const { stagingPath } = await this.#prepareState(record);
    let state = await this.#loadTargetState(record, stagingPath);
    if (!state.claimBatch || !state.importedIdentity) {
      throw targetError('authority-transfer-target-stage-incomplete');
    }
    const stagedTargetProof = await this.#validateStateBindings(record, proof, state);
    let authority = await this.options.foundation.inspectAuthority(record.projectId);
    if (!authority) {
      const provisional = await this.options.foundation.openAuthorityTransferTarget(
        record.projectId,
        record.ownerInstallationKey,
      );
      try {
        await this.#assertStagedAuthorityBindings(state, stagedTargetProof, provisional);
      } finally {
        await provisional.database.close();
      }
      authority = await this.options.foundation.activateAuthorityTransferTarget(
        record.projectId,
        record.ownerInstallationKey,
      );
    }
    const authorityStatePath = path.join(authority.authorityDirectory, AUTHORITY_TARGET_STATE_FILE);
    const persistedAuthorityState = await readState(authorityStatePath);
    if (persistedAuthorityState) state = persistedAuthorityState;
    else await writeState(authorityStatePath, state);
    if (!state.claimBatch || !state.importedIdentity) {
      throw targetError('authority-transfer-target-stage-incomplete');
    }
    const targetProof = await this.#assertActiveState(record, proof, state, authority);
    await this.#activateRoute(record, proof, state);
    return { authority, state, targetProof };
  }

   async #assertActiveState(
    record: AuthorityTransferRecord,
    proof: CollabAuthorityRelinquishmentProof,
    state: TargetPrivateState,
    authority: CollabAuthorityFoundation,
  ): Promise<TargetProofEnvelope> {
    const targetProof = await this.#validateStateBindings(record, proof, state);
    const project = await authority.database.read(connection => authority.projects.get(connection));
    if (!project || project.hostMemberId !== targetProof.payload.targetHostMemberId) {
      throw targetError('authority-transfer-target-host-mismatch');
    }
    await authority.database.mutate(connection => {
      const checkpoint = new AuthorityTransferCheckpointRepository();
      checkpoint.repairImportedTargetCredentialEncoding(
        connection,
        this.#credentialRepairInput(
          record,
          state,
          targetProof.payload.targetHostMemberId,
        ),
      );
      checkpoint.activateImportedAuthority(connection, {
        projectId: record.projectId,
        targetAuthorityGeneration: record.status.targetAuthority.generation,
      });
    });
    return targetProof;
  }

  #credentialRepairInput(
    record: AuthorityTransferRecord,
    state: TargetPrivateState,
    targetHostMemberId: CollabMemberId,
  ) {
    return {
      canonicalCredentialHash: createHash('sha256')
        .update(state.hostCredential, 'utf8')
        .digest(),
      decodedCredentialHash: createHash('sha256')
        .update(Buffer.from(state.hostCredential, 'base64url'))
        .digest(),
      projectId: record.projectId,
      targetAuthorityGeneration: record.status.targetAuthority.generation,
      targetHostMemberId,
    };
  }

  async #validateStateBindings(
    record: AuthorityTransferRecord,
    proof: CollabAuthorityRelinquishmentProof,
    state: TargetPrivateState,
  ): Promise<TargetProofEnvelope> {
    await verifyAuthorityRelinquishmentProof(proof, record);
    const targetProof = await this.#validatePreparedStateBindings(record, state);
    let claimBatch: CollabTransferredMembershipClaimBatch;
    try {
      claimBatch = decodeCollabTransferredMembershipClaimBatch(state.claimBatch);
    } catch {
      throw targetError('authority-transfer-target-state-owner-mismatch');
    }
    const batchSha256 = sha256(
      encodeCollabTransferredMembershipClaimBatchDigestInput(claimBatch),
    );
    if (
      proof.projectId !== record.projectId
      || proof.transferId !== record.transferId
      || proof.sourceAuthority.kind !== 'cloud'
      || proof.targetAuthority.kind !== 'lan'
      || state.transferId !== record.transferId
      || !state.claimBatch
      || !state.importedIdentity
      || claimBatch.batchRevision !== record.status.batchRevision
      || claimBatch.batchSha256 !== record.status.batchSha256
      || claimBatch.batchSha256 !== batchSha256
      || state.claimBatch.projectId !== record.projectId
      || state.claimBatch.transferId !== record.transferId
      || state.claimBatch.targetAuthorityGeneration
        !== record.status.targetAuthority.generation
      || state.claimBatch.checkpointSha256 !== record.status.checkpointSha256
      || state.importedIdentity.project.id !== record.projectId
      || state.importedIdentity.authorityGeneration !== record.status.targetAuthority.generation
      || state.importedIdentity.currentMember.id !== targetProof.payload.targetHostMemberId
    ) throw targetError('authority-transfer-target-state-owner-mismatch');
    return targetProof;
  }

   async #assertStagedAuthorityBindings(
    state: TargetPrivateState,
    targetProof: TargetProofEnvelope,
    authority: CollabAuthorityFoundation,
  ): Promise<void> {
    const facts = await authority.database.read(connection => ({
      members: new PendingMembershipRepository().listCredentialRecords(
        connection,
        ['active'],
      ),
      project: authority.projects.get(connection),
    }));
    const targetMembers = facts.members.filter(
      candidate => candidate.member.id === targetProof.payload.targetHostMemberId,
    );
    const canonicalCredentialHash = createHash('sha256')
      .update(state.hostCredential, 'utf8')
      .digest();
    const decodedCredentialHash = createHash('sha256')
      .update(Buffer.from(state.hostCredential, 'base64url'))
      .digest();
    const actualCredentialHash = targetMembers[0]?.credentialHash;
    if (
      !facts.project
      || facts.project.hostMemberId !== targetProof.payload.targetHostMemberId
      || targetMembers.length !== 1
      || targetMembers[0]?.accessState !== 'bound'
      || !actualCredentialHash
      || actualCredentialHash.byteLength !== canonicalCredentialHash.byteLength
      || (!timingSafeEqual(actualCredentialHash, canonicalCredentialHash)
        && !timingSafeEqual(actualCredentialHash, decodedCredentialHash))
    ) throw targetError('authority-transfer-target-state-owner-mismatch');
  }

   async #validatePreparedStateBindings(
    record: AuthorityTransferRecord,
    state: TargetPrivateState,
  ): Promise<TargetProofEnvelope> {
    const targetProof = await this.#validateProof(state);
    let receiptPublicKey: string | undefined;
    try {
      receiptPublicKey = createPublicKey(createPrivateKey({
        format: 'der',
        key: Buffer.from(state.receiptKey.privateKey, 'base64url'),
        type: 'pkcs8',
      })).export({ format: 'jwk' }).x;
    } catch {
      throw targetError('authority-transfer-target-state-owner-mismatch');
    }
    if (
      state.transferId !== record.transferId
      || targetProof.payload.projectId !== record.projectId
      || targetProof.payload.transferId !== record.transferId
      || targetProof.payload.targetAuthorityGeneration
        !== record.status.targetAuthority.generation
      || targetProof.payload.targetUrl !== record.status.targetUrl
      || targetProof.payload.receiptKeyId !== state.receiptKey.receiptKeyId
      || targetProof.payload.receiptPublicKey !== state.receiptKey.publicKey
      || targetProof.payload.transferCredential !== state.transferCredential
      || receiptPublicKey !== state.receiptKey.publicKey
      || state.receiptKey.receiptKeyId !== `lan-${sha256(receiptPublicKey).slice(0, 32)}`
    ) throw targetError('authority-transfer-target-state-owner-mismatch');
    return targetProof;
  }

   async #bindClaim(
    record: AuthorityTransferRecord,
    request: LanClaimRequest,
  ): Promise<CollabTransferredMembershipRedemptionReceipt> {
    return this.queue.run(async () => {
      const authority = await this.options.foundation.openAuthority(record.projectId);
      const statePath = path.join(authority.authorityDirectory, AUTHORITY_TARGET_STATE_FILE);
      let state = await readState(statePath);
      if (!state?.claimBatch) throw targetError('authority-transfer-target-claims-missing');
      if (this.now().getTime() >= Date.parse(state.claimBatch.expiresAt)) {
        throw new CollabError({ code: 'membership-claim-expired' });
      }
      const claimDigest = sha256(request.claim);
      const item = state.claimBatch.claims.find(candidate => {
        const expected = Buffer.from(sha256(candidate.claim), 'hex');
        const actual = Buffer.from(claimDigest, 'hex');
        return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
      });
      if (!item) throw new CollabError({ code: 'membership-claim-invalid' });
      const receiptKeyId = `${item.memberId}:${request.idempotencyKey}`;
      const existing = state.receipts[receiptKeyId];
      if (existing) {
        if (existing.claimSha256 !== claimDigest) {
          throw new CollabError({ code: 'authority-transfer-stale' });
        }
        return existing;
      }
      const credentialHash = Buffer.from(request.credentialHash, 'hex');
      if (credentialHash.byteLength !== 32) {
        throw new CollabError({ code: 'membership-claim-invalid' });
      }
      await authority.database.mutate(connection => (
        new PendingMembershipRepository().bindImportedActive(
          connection,
          item.memberId,
          credentialHash,
        )
      ));
      const payload = {
        checkpointSha256: state.claimBatch.checkpointSha256,
        claimSha256: claimDigest,
        memberId: item.memberId,
        operationIntentId: request.idempotencyKey,
        projectId: record.projectId,
        receiptId: `receipt-${sha256(`${record.transferId}:${receiptKeyId}`).slice(0, 40)}`,
        receiptKeyId: state.receiptKey.receiptKeyId,
        redeemedAt: this.now().toISOString(),
        signatureAlgorithm: 'ed25519' as const,
        targetAuthorityGeneration: record.status.targetAuthority.generation,
        transferId: record.transferId,
      };
      const receipt = decodeCollabTransferredMembershipRedemptionReceipt({
        ...payload,
        signature: sign(
          null,
          Buffer.from(
            encodeCollabTransferredMembershipRedemptionReceiptSigningInput(payload),
            'utf8',
          ),
          createPrivateKey({
            format: 'der',
            key: Buffer.from(state.receiptKey.privateKey, 'base64url'),
            type: 'pkcs8',
          }),
        ).toString('base64url'),
      });
      state = { ...state, receipts: { ...state.receipts, [receiptKeyId]: receipt } };
      await writeState(statePath, state);
      return receipt;
    });
  }

   async #ensureStagedRoute(
    record: AuthorityTransferRecord,
    state: TargetPrivateState,
  ): Promise<void> {
    if (this.#stagedRegistration || this.#activeRegistration) return;
    const service: LanAuthorityTransferTargetStagedService = {
      acceptCloudToLanTransferTarget: request => this.#stagedStatus(record, request),
      confirmCloudToLanTargetActive: request => this.#stagedStatus(record, request),
      getProjectAuthorityTransfer: request => this.#stagedStatus(record, request),
      reportCloudToLanTargetStaged: async request => {
        await this.#stagedStatus(record, request);
        throw targetError('authority-transfer-target-custody-pending');
      },
    };
    const registration: LanAuthorityTransferRouteRegistration = {
      credentialHash: sha256(Buffer.from(state.transferCredential, 'base64url')),
      expectedEndpoint: record.status.targetUrl,
      projectId: record.projectId,
      service,
      state: 'target-only-staged',
      transferId: record.transferId,
    };
    await this.options.foundation.lanHost.startAuthorityTransferRoute(registration);
    this.#stagedRegistration = registration;
    const preparation = this.#preparation;
    this.#preparation = null;
    await preparation?.dispose();
  }

   async #stagedStatus(
    record: AuthorityTransferRecord,
    request: Readonly<{ readonly projectId: string; readonly transferId: string }>,
  ) {
    const current = await this.options.persistence.load(record.projectId);
    if (
      request.projectId !== record.projectId
      || request.transferId !== record.transferId
      || !current
      || current.transferId !== record.transferId
      || current.localRole !== 'target'
    ) throw new CollabError({ code: 'authority-transfer-not-found' });
    return current.status;
  }

   async #prepareState(record: AuthorityTransferRecord): Promise<{
    readonly memberId: string;
    readonly stagingPath: string;
    readonly state: TargetPrivateState;
  }> {
    if (record.projectId !== this.options.projectId) {
      throw targetError('authority-transfer-project-mismatch');
    }
    const cloudSession = this.#requireCloudSession();
    const membership = await this.options.foundation.local.projects.loadMembership(record.projectId);
    if (
      !membership
      || !isCollabLocalCloudMembership(membership)
      || membership.authority.serverUrl !== cloudSession.serverUrl
    ) throw targetError('authority-transfer-target-membership-invalid');
    const staging = await this.options.foundation.local.workspace.reserveProjectsFolderChild(
      projectsFolder(membership.project.workspacePath),
      {
        childName: record.stagingDirectoryName,
        operationId: record.transferId,
        projectId: record.projectId,
        purpose: 'authority-transfer-staging',
      },
    );
    await mkdir(staging.absolutePath, { mode: 0o700 }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    const statePath = path.join(staging.absolutePath, TARGET_STATE_FILE);
    let state = await readState(statePath);
    if (!state) {
      state = initialState();
      await writeState(statePath, state);
    }
    return { memberId: membership.member.id, stagingPath: staging.absolutePath, state };
  }

   async #loadTargetState(
    record: AuthorityTransferRecord,
    stagingPath: string,
  ): Promise<TargetPrivateState> {
    const staged = await readState(path.join(stagingPath, TARGET_STATE_FILE));
    const authority = staged
      ? null
      : await this.options.foundation.inspectAuthority(record.projectId);
    const active = authority
      ? await readState(path.join(authority.authorityDirectory, AUTHORITY_TARGET_STATE_FILE))
      : null;
    const state = staged ?? active;
    if (!state || state.transferId !== record.transferId) {
      throw targetError('authority-transfer-target-state-owner-mismatch');
    }
    return state;
  }

  private signActivation(
    record: AuthorityTransferRecord,
    proof: CollabAuthorityRelinquishmentProof,
    state: TargetPrivateState,
  ): string {
    const payload = JSON.stringify({
      checkpointSha256: state.claimBatch?.checkpointSha256,
      projectId: record.projectId,
      relinquishmentCertificate: proof.certificate,
      targetAuthorityGeneration: record.status.targetAuthority.generation,
      transferId: record.transferId,
    });
    return sign(
      null,
      Buffer.from(payload, 'utf8'),
      createPrivateKey({
        format: 'der',
        key: Buffer.from(state.receiptKey.privateKey, 'base64url'),
        type: 'pkcs8',
      }),
    ).toString('base64url');
  }

   async #validateProof(state: TargetPrivateState): Promise<TargetProofEnvelope> {
    if (!state.targetProof) throw targetError('authority-transfer-target-proof-missing');
    const proof = decodeTargetProof(state.targetProof);
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(proof.caCertificatePem);
    } catch {
      throw targetError('authority-transfer-target-proof-invalid');
    }
    const signer = await this.options.foundation.lanHost.hostCaSigner();
    if (
      !certificate.ca
      || !certificate.verify(certificate.publicKey)
      || fingerprintCertificatePem(proof.caCertificatePem) !== proof.caFingerprint
      || proof.caCertificatePem !== signer.caCertificatePem
      || proof.caFingerprint !== signer.caFingerprint
      || !verify(
        'sha256',
        Buffer.from(encodeTargetProofPayload(proof.payload), 'utf8'),
        {
          key: certificate.publicKey,
          padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
          saltLength: 32,
        },
        Buffer.from(proof.certificate, 'base64url'),
      )
    ) throw targetError('authority-transfer-target-proof-invalid');
    return proof;
  }

   async #cleanupStaging(record: AuthorityTransferRecord): Promise<void> {
    const membership = await this.options.foundation.local.projects.loadMembership(record.projectId);
    if (!membership) throw targetError('authority-transfer-membership-missing');
    await this.options.foundation.local.workspace.removeReservedProjectsFolderChild(
      projectsFolder(membership.project.workspacePath),
      {
        childName: record.stagingDirectoryName,
        operationId: record.transferId,
        projectId: record.projectId,
        purpose: 'authority-transfer-staging',
      },
    );
  }

   #requireCloudSession(): Readonly<{ readonly serverUrl: string }> {
    if (!this.options.cloudSession) {
      throw targetError('authority-transfer-cloud-session-missing');
    }
    return this.options.cloudSession;
  }

  async #convergeLocal(
    record: AuthorityTransferRecord,
    proof: CollabAuthorityRelinquishmentProof,
  ): Promise<void> {
    const { authority, state, targetProof } = await this.#activateLocal(record, proof);
    await this.#convergePersistedState(record, state, targetProof, authority);
  }

   async #convergePersistedState(
    record: AuthorityTransferRecord,
    state: TargetPrivateState,
    targetProof: TargetProofEnvelope,
    authority: CollabAuthorityFoundation,
  ): Promise<void> {
    if (!state.importedIdentity) throw targetError('authority-transfer-target-stage-incomplete');
    const preparation = this.#preparation;
    this.#preparation = null;
    await preparation?.dispose();
    await this.options.convergence.cloudToLanHost({
      endpoint: record.status.targetUrl,
      hostCaCertificatePem: targetProof.caCertificatePem,
      hostCaFingerprint: targetProof.caFingerprint,
      memberCredential: state.hostCredential,
      identity: state.importedIdentity,
      status: record.status,
    });
    await this.#assertCompletedTargetMembership(record, authority, state, targetProof);
    await this.#startConfiguredHost(record);
    await this.#cleanupStaging(record);
  }

   async #startConfiguredHost(record: AuthorityTransferRecord): Promise<void> {
    const projectId = record.projectId;
    const membership = await this.options.foundation.local.projects.loadMembership(projectId);
    if (
      !membership
      || !isCollabLocalLanMembership(membership)
      || !membership.hostOwnership.ownsAuthority
      || typeof membership.hostOwnership.autoStart !== 'boolean'
    ) throw targetError('authority-transfer-target-convergence-incomplete');
    if (membership.hostOwnership.autoStart === false) return;
    if (this.options.foundation.lanHost.isProjectRunning(projectId)) return;
    await this.options.foundation.lanHost.startProjectAfterCloudToLanTargetRecovery({
      expectedEndpoint: record.status.targetUrl,
      operationIntentId: record.operationIntentId,
      projectId,
      transferId: record.transferId,
    });
    if (!this.options.foundation.lanHost.isProjectRunning(projectId)) {
      throw targetError('authority-transfer-target-convergence-incomplete');
    }
  }
}
