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
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import {
  type AcceptCloudToLanTransferTargetRequest,
  type ClaimTransferredMembershipRequest,
  COLLAB_CHECKPOINT_ARTIFACT_LIMITS,
  type CollabAuthorityRelinquishmentProof,
  type CollabCloudAuthorityTransferArtifact,
  type CollabProjectCheckpointManifest,
  type CollabTransferredMembershipClaimBatch,
  type CollabTransferredMembershipRedemptionReceipt,
  decodeCollabProjectCheckpointCoordinationNdjson,
  decodeCollabTransferredMembershipClaimBatch,
  decodeCollabTransferredMembershipRedemptionReceipt,
  encodeCollabTransferredMembershipClaimBatchDigestInput,
  encodeCollabTransferredMembershipRedemptionReceiptSigningInput,
} from '@claudian-collab/protocol';

import { PendingMembershipRepository } from '@/app/collab/authority/PendingMembershipRepository';
import type { AuthorityTransferLocalConvergence } from '@/app/collab/authority-transfer/AuthorityTransferLocalConvergence';
import type { AuthorityTransferRecord } from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import { AuthorityTransferCheckpointGit } from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferCheckpointGit';
import { verifyAuthorityTransferCheckpointManifest } from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferCheckpointManifest';
import { AuthorityTransferCheckpointRepository } from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferCheckpointRepository';
import type {
  CloudToLanDownloadedArtifact,
  CloudToLanTargetEffects,
  CloudToLanTargetStageResult,
} from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLanTargetCoordinator';
import type { AuthorityTransferPersistence } from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import type {
  ClaudianCollabService,
  CollabAuthorityFoundation,
} from '@/app/collab/ClaudianCollabService';
import {
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
import type { CloudAuthorityLifecycleSession } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import type { CollabCloudProjectSnapshot, CollabOperationOptions } from '@/core/collab';
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
  readonly hostCredential: string;
  readonly receiptKey: TargetReceiptKey;
  readonly receipts: Readonly<Record<string, CollabTransferredMembershipRedemptionReceipt>>;
  readonly schemaVersion: 1;
  readonly snapshot: CollabCloudProjectSnapshot | null;
  readonly targetProof: string | null;
  readonly transferCredential: string;
  readonly transferId: string | null;
}

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
  readonly cloudSession: CloudAuthorityLifecycleSession | null;
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
    hostCredential: credential(),
    receiptKey: receiptKey(),
    receipts: {},
    schemaVersion: 1,
    snapshot: null,
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
  if (
    state.schemaVersion !== 1
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
  return state as TargetPrivateState;
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
  const temporary = `${filePath}.tmp`;
  await rm(temporary, { force: true }).catch(() => undefined);
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temporary, filePath).catch(async error => {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  });
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
  private activeRegistration: LanAuthorityTransferRouteRegistration | null = null;
  private readonly now: () => Date;
  private preparation: LanHostAuthorityTransferPreparation | null = null;
  private readonly queue = new SerialTaskQueue();
  private stagedRegistration: LanAuthorityTransferRouteRegistration | null = null;

  constructor(private readonly options: ProductionCloudToLanTargetEffectsOptions) {
    this.now = options.now ?? (() => new Date());
  }

  dispose(): void {
    const preparation = this.preparation;
    this.preparation = null;
    void preparation?.dispose().catch(() => undefined);
  }

  async prepareTarget(expectedEndpoint?: string): Promise<Readonly<{ readonly targetUrl: string }>> {
    if (!this.preparation) {
      this.preparation = await this.options.foundation.lanHost.prepareAuthorityTransferTarget(
        expectedEndpoint ?? null,
      );
    }
    if (expectedEndpoint && this.preparation.endpoint !== expectedEndpoint) {
      throw targetError('authority-transfer-target-url-mismatch');
    }
    return { targetUrl: this.preparation.endpoint };
  }

  async acceptanceRequest(
    record: AuthorityTransferRecord,
  ): Promise<AcceptCloudToLanTransferTargetRequest> {
    return this.queue.run(async () => {
      const { stagingPath, state: initial } = await this.prepareState(record);
      const cloudSession = this.requireCloudSession();
      const prepared = await this.prepareTarget();
      const preparation = this.preparation;
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
          targetHostMemberId: cloudSession.developmentActorId,
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
      await this.ensureStagedRoute(record, state);
      return {
        idempotencyKey: `${record.operationIntentId}-accept`,
        projectId: record.projectId,
        targetHostMemberId: cloudSession.developmentActorId,
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
      const { stagingPath } = await this.prepareState(record);
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
      if (state.claimBatch === null) {
        const cloudSession = this.requireCloudSession();
        const snapshot = await cloudSession.readSnapshot(record.projectId, options);
        if (snapshot.currentMember.id !== cloudSession.developmentActorId) {
          throw targetError('authority-transfer-target-host-snapshot-mismatch');
        }
        await this.options.foundation.discardProvisionalAuthority(record.projectId);
        const authority = await this.options.foundation.openAuthority(record.projectId);
        const git = await this.options.foundation.requireGitFoundation();
        const checkpoint = new AuthorityTransferCheckpointRepository();
        await authority.database.mutate(connection => checkpoint.importCoordination(connection, {
          coordinationNdjson: coordinationBytes.toString('utf8'),
          manifest,
          targetHostCredentialHash: createHash('sha256')
            .update(Buffer.from(state.hostCredential, 'base64url'))
            .digest(),
          targetHostMemberId: cloudSession.developmentActorId,
        }));
        await new AuthorityTransferCheckpointGit(git.runner).importIntoEmptyBareRepository({
          bundlePath: path.join(stagingPath, BUNDLE_FILE),
          manifest,
          ...(options.signal ? { signal: options.signal } : {}),
          targetRepositoryPath: path.join(authority.authorityDirectory, 'repository.git'),
        });
        state = {
          ...state,
          claimBatch: claimBatch(
            record,
            manifest,
            coordinationBytes.toString('utf8'),
            cloudSession.developmentActorId,
          ),
          snapshot,
        };
        await writeState(path.join(stagingPath, TARGET_STATE_FILE), state);
      }
      if (!state.claimBatch || !state.snapshot || !state.targetProof) {
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
        targetProof: state.targetProof,
      };
    });
  }

  async activate(
    record: AuthorityTransferRecord,
    proof: CollabAuthorityRelinquishmentProof,
  ): Promise<string> {
    return this.queue.run(async () => (
      this.activateLocal(record, proof).then(({ state }) => (
        this.signActivation(record, proof, state)
      ))
    ));
  }

  async converge(
    record: AuthorityTransferRecord,
    proof: CollabAuthorityRelinquishmentProof,
  ): Promise<void> {
    return this.queue.run(() => this.convergeLocal(record, proof));
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
        if (
          expired
          && isCollabLocalLanMembership(membership)
          && membership.authority.endpoint === new URL(record.status.targetUrl).origin
          && membership.hostOwnership.autoStart
          && membership.hostOwnership.ownsAuthority
        ) {
          await this.options.foundation.lanHost.startProject(record.projectId);
          await this.expireActiveRouteUnlocked(record);
          return;
        }
        throw targetError('authority-transfer-target-state-owner-mismatch');
      }
      const targetProof = await this.assertActiveState(record, proof, state, authority);
      if (!expired) await this.startActiveRoute(record, state);
      await this.convergePersistedState(record, state, targetProof);
      if (expired) await this.expireActiveRouteUnlocked(record);
    });
  }

  async cancelStaging(record: AuthorityTransferRecord): Promise<void> {
    await this.options.foundation.lanHost.stopAuthorityTransferRoute(
      record.projectId,
      'target-only-staged',
    );
    this.stagedRegistration = null;
    const preparation = this.preparation;
    this.preparation = null;
    await preparation?.dispose();
    await this.options.foundation.discardProvisionalAuthority(record.projectId);
    await this.cleanupStaging(record);
  }

  private async activateRoute(
    record: AuthorityTransferRecord,
    proof: CollabAuthorityRelinquishmentProof,
    state: TargetPrivateState,
  ): Promise<void> {
    if (this.activeRegistration) return;
    await this.ensureStagedRoute(record, state);
    const expected = this.stagedRegistration;
    if (!expected) throw targetError('authority-transfer-target-route-missing');
    const service = this.activeService(record);
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
    this.activeRegistration = next;
    this.stagedRegistration = null;
  }

  private activeService(record: AuthorityTransferRecord) {
    return new PersistentLanAuthorityTransferTargetActiveService({
      bind: request => this.bindClaim(record, request),
      expire: () => this.expireActiveRoute(record),
      expiresAt: record.status.expiresAt,
      projectId: record.projectId,
      targetAuthorityGeneration: record.status.targetAuthority.generation,
      transferId: record.transferId,
    });
  }

  private async expireActiveRoute(record: AuthorityTransferRecord): Promise<void> {
    return this.queue.run(() => this.expireActiveRouteUnlocked(record));
  }

  private async expireActiveRouteUnlocked(record: AuthorityTransferRecord): Promise<void> {
    if (this.now().getTime() < Date.parse(record.status.expiresAt)) {
      throw targetError('authority-transfer-target-expiry-early');
    }
    const current = await this.options.persistence.load(record.projectId);
    if (
      !current
      || current.transferId !== record.transferId
      || current.localRole !== 'target'
      || current.status.state !== 'completed'
    ) throw targetError('authority-transfer-target-expiry-owner-mismatch');
    await this.options.persistence.expireClaims(record.projectId, record.transferId);
    const authority = await this.options.foundation.inspectAuthority(record.projectId);
    if (!authority) throw targetError('authority-transfer-target-authority-missing');
    await rm(path.join(authority.authorityDirectory, AUTHORITY_TARGET_STATE_FILE), {
      force: true,
    });
    await this.options.persistence.completeTerminalCleanup({
      operationIntentId: record.operationIntentId,
      projectId: record.projectId,
      stagingDirectoryName: record.stagingDirectoryName,
      transferId: record.transferId,
    });
  }

  private async startActiveRoute(
    record: AuthorityTransferRecord,
    state: TargetPrivateState,
  ): Promise<void> {
    if (this.activeRegistration) return;
    const registration: LanAuthorityTransferRouteRegistration = {
      expectedEndpoint: record.status.targetUrl,
      projectId: record.projectId,
      service: this.activeService(record),
      state: 'target-active',
      transferId: record.transferId,
    };
    await this.options.foundation.lanHost.startAuthorityTransferRoute(registration);
    this.activeRegistration = registration;
    if (!state.claimBatch) throw targetError('authority-transfer-target-claims-missing');
  }

  private async activateLocal(
    record: AuthorityTransferRecord,
    proof: CollabAuthorityRelinquishmentProof,
  ): Promise<Readonly<{
    readonly state: TargetPrivateState;
    readonly targetProof: TargetProofEnvelope;
  }>> {
    if (
      proof.projectId !== record.projectId
      || proof.transferId !== record.transferId
      || proof.sourceAuthority.kind !== 'cloud'
      || proof.targetAuthority.kind !== 'lan'
    ) throw targetError('authority-transfer-target-relinquishment-mismatch');
    const { stagingPath } = await this.prepareState(record);
    let state = await this.loadTargetState(record, stagingPath);
    if (!state.claimBatch || !state.snapshot) {
      throw targetError('authority-transfer-target-stage-incomplete');
    }
    const authority = await this.options.foundation.openAuthority(record.projectId);
    const authorityStatePath = path.join(authority.authorityDirectory, AUTHORITY_TARGET_STATE_FILE);
    const persistedAuthorityState = await readState(authorityStatePath);
    if (persistedAuthorityState) state = persistedAuthorityState;
    else await writeState(authorityStatePath, state);
    if (!state.claimBatch || !state.snapshot) {
      throw targetError('authority-transfer-target-stage-incomplete');
    }
    const targetProof = await this.validateProof(state);
    const checkpoint = new AuthorityTransferCheckpointRepository();
    await authority.database.mutate(connection => checkpoint.activateImportedAuthority(
      connection,
      {
        projectId: record.projectId,
        targetAuthorityGeneration: record.status.targetAuthority.generation,
      },
    ));
    await this.activateRoute(record, proof, state);
    return { state, targetProof };
  }

  private async assertActiveState(
    record: AuthorityTransferRecord,
    proof: CollabAuthorityRelinquishmentProof,
    state: TargetPrivateState,
    authority: CollabAuthorityFoundation,
  ): Promise<TargetProofEnvelope> {
    const targetProof = await this.validateProof(state);
    if (
      proof.projectId !== record.projectId
      || proof.transferId !== record.transferId
      || proof.sourceAuthority.kind !== 'cloud'
      || proof.targetAuthority.kind !== 'lan'
      || state.transferId !== record.transferId
      || !state.claimBatch
      || !state.snapshot
      || state.claimBatch.projectId !== record.projectId
      || state.claimBatch.transferId !== record.transferId
      || state.claimBatch.targetAuthorityGeneration
        !== record.status.targetAuthority.generation
      || state.claimBatch.checkpointSha256 !== record.status.checkpointSha256
      || state.snapshot.project.id !== record.projectId
      || state.snapshot.currentMember.id !== targetProof.payload.targetHostMemberId
      || targetProof.payload.projectId !== record.projectId
      || targetProof.payload.transferId !== record.transferId
      || targetProof.payload.targetAuthorityGeneration
        !== record.status.targetAuthority.generation
      || targetProof.payload.targetUrl !== record.status.targetUrl
      || targetProof.payload.receiptKeyId !== state.receiptKey.receiptKeyId
      || targetProof.payload.receiptPublicKey !== state.receiptKey.publicKey
      || targetProof.payload.transferCredential !== state.transferCredential
    ) throw targetError('authority-transfer-target-state-owner-mismatch');
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
      receiptPublicKey !== state.receiptKey.publicKey
      || state.receiptKey.receiptKeyId !== `lan-${sha256(receiptPublicKey).slice(0, 32)}`
    ) throw targetError('authority-transfer-target-state-owner-mismatch');
    const project = await authority.database.read(connection => authority.projects.get(connection));
    if (!project || project.hostMemberId !== targetProof.payload.targetHostMemberId) {
      throw targetError('authority-transfer-target-host-mismatch');
    }
    await authority.database.mutate(connection => (
      new AuthorityTransferCheckpointRepository().activateImportedAuthority(connection, {
        projectId: record.projectId,
        targetAuthorityGeneration: record.status.targetAuthority.generation,
      })
    ));
    return targetProof;
  }

  private async bindClaim(
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

  private async ensureStagedRoute(
    record: AuthorityTransferRecord,
    state: TargetPrivateState,
  ): Promise<void> {
    if (this.stagedRegistration || this.activeRegistration) return;
    const service: LanAuthorityTransferTargetStagedService = {
      acceptCloudToLanTransferTarget: request => this.stagedStatus(record, request),
      confirmCloudToLanTargetActive: request => this.stagedStatus(record, request),
      getProjectAuthorityTransfer: request => this.stagedStatus(record, request),
      reportCloudToLanTargetStaged: async request => {
        await this.stagedStatus(record, request);
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
    this.stagedRegistration = registration;
    const preparation = this.preparation;
    this.preparation = null;
    await preparation?.dispose();
  }

  private async stagedStatus(
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

  private async prepareState(record: AuthorityTransferRecord): Promise<{
    readonly stagingPath: string;
    readonly state: TargetPrivateState;
  }> {
    if (record.projectId !== this.options.projectId) {
      throw targetError('authority-transfer-project-mismatch');
    }
    const cloudSession = this.requireCloudSession();
    const membership = await this.options.foundation.local.projects.loadMembership(record.projectId);
    if (
      !membership
      || !isCollabLocalCloudMembership(membership)
      || membership.member.id !== cloudSession.developmentActorId
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
    return { stagingPath: staging.absolutePath, state };
  }

  private async loadTargetState(
    record: AuthorityTransferRecord,
    stagingPath: string,
  ): Promise<TargetPrivateState> {
    const authority = await this.options.foundation.inspectAuthority(record.projectId);
    const active = authority
      ? await readState(path.join(authority.authorityDirectory, AUTHORITY_TARGET_STATE_FILE))
      : null;
    const staged = await readState(path.join(stagingPath, TARGET_STATE_FILE));
    const state = active ?? staged;
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

  private async validateProof(state: TargetPrivateState): Promise<TargetProofEnvelope> {
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

  private async cleanupStaging(record: AuthorityTransferRecord): Promise<void> {
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

  private requireCloudSession(): CloudAuthorityLifecycleSession {
    if (!this.options.cloudSession) {
      throw targetError('authority-transfer-cloud-session-missing');
    }
    return this.options.cloudSession;
  }

  private async convergeLocal(
    record: AuthorityTransferRecord,
    proof: CollabAuthorityRelinquishmentProof,
  ): Promise<void> {
    const { state, targetProof } = await this.activateLocal(record, proof);
    await this.convergePersistedState(record, state, targetProof);
  }

  private async convergePersistedState(
    record: AuthorityTransferRecord,
    state: TargetPrivateState,
    targetProof: TargetProofEnvelope,
  ): Promise<void> {
    if (!state.snapshot) throw targetError('authority-transfer-target-stage-incomplete');
    const preparation = this.preparation;
    this.preparation = null;
    await preparation?.dispose();
    await this.options.convergence.cloudToLanHost({
      endpoint: record.status.targetUrl,
      hostCaCertificatePem: targetProof.caCertificatePem,
      hostCaFingerprint: targetProof.caFingerprint,
      memberCredential: state.hostCredential,
      snapshot: state.snapshot,
      status: record.status,
    });
    await this.options.foundation.lanHost.startProject(record.projectId);
    await this.cleanupStaging(record);
  }
}
