import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  type AcceptLanToCloudTransferTargetRequest,
  COLLAB_MAIN_REF,
  COLLAB_MEMBER_REF_PREFIX,
  type CollabAuthorityRelinquishmentProof,
  type CollabCheckpointArtifactFact,
  type CollabCheckpointGitRef,
  type CollabProjectCheckpointManifest,
  encodeCollabAuthorityRelinquishmentProofSigningInput,
  encodeCollabProjectCheckpointManifestCanonicalJson,
  isCollabGitOid,
  isCollabOpaqueId,
} from '@claudian-collab/protocol';

import type { AuthorityTransferLocalConvergence } from '@/app/collab/authority-transfer/AuthorityTransferLocalConvergence';
import {
  type AuthorityTransferRecord,
  isAuthorityTransferTerminalResponderExpired,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import {
  AuthorityTransferAdmissionSettlement,
} from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferAdmissionSettlement';
import {
  AuthorityTransferCheckpointGit,
} from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferCheckpointGit';
import {
  createAuthorityTransferCheckpointManifest,
  verifyAuthorityTransferCheckpointManifest,
} from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferCheckpointManifest';
import {
  AuthorityTransferCheckpointRepository,
} from '@/app/collab/authority-transfer/checkpoint/AuthorityTransferCheckpointRepository';
import type {
  LanToCloudCapturedCheckpoint,
  LanToCloudSourceEffects,
} from '@/app/collab/authority-transfer/lan-to-cloud/LanToCloudSourceCoordinator';
import type { AuthorityTransferPersistence } from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import type {
  ClaudianCollabService,
  CollabAuthorityFoundation,
  CollabGitFoundation,
} from '@/app/collab/ClaudianCollabService';
import { isCollabLocalLanMembership } from '@/app/collab/CollabLocalProjectRepository';
import {
  PersistentLanAuthorityTransferTerminalSourceService,
} from '@/app/collab/lan/authority-transfer/PersistentLanAuthorityTransferServices';
import {
  AuthorityMemberCredentialAuthenticator,
} from '@/app/collab/lan/AuthorityMemberCredentialAuthenticator';
import type {
  CloudAuthorityLifecycleSession,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import type { CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const MANIFEST_FILE = 'checkpoint.json';
const COORDINATION_FILE = 'coordination.ndjson';
const BUNDLE_FILE = 'repository.bundle';
const SOURCE_PROOF_FILE = 'source-proof.json';
const SOURCE_KEY_FILE = 'source-proof-key.json';
const RELINQUISHMENT_FILE = 'relinquishment-proof.json';

interface SourceProofKey {
  readonly privateKey: string;
  readonly publicKey: string;
  readonly receiptKeyId: string;
  readonly schemaVersion: 1;
}

interface SourceProofEnvelope {
  readonly caCertificatePem: string;
  readonly certificate: string;
  readonly payload: Readonly<{
    readonly checkpointManifestSha256: string;
    readonly projectId: string;
    readonly sourceAuthorityGeneration: number;
    readonly sourceHostMemberId: string;
    readonly targetAuthorityGeneration: number;
    readonly targetUrl: string;
    readonly transferId: string;
  }>;
  readonly receiptKeyId: string;
  readonly receiptPublicKey: string;
  readonly schemaVersion: 1;
}

export interface ProductionLanToCloudSourceEffectsOptions {
  readonly cloudSession: CloudAuthorityLifecycleSession | null;
  readonly convergence: AuthorityTransferLocalConvergence;
  readonly foundation: ClaudianCollabService;
  readonly persistence: AuthorityTransferPersistence;
  readonly projectId: string;
}

function effectsError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function projectsFolder(workspacePath: string): string {
  const separator = workspacePath.lastIndexOf('/');
  if (separator <= 0) throw effectsError('authority-transfer-workspace-path-invalid');
  return workspacePath.slice(0, separator);
}

function artifactFact(name: 'coordination.ndjson', bytes: Buffer): CollabCheckpointArtifactFact {
  return {
    byteCount: bytes.byteLength,
    name,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function parseRefs(stdout: Buffer): readonly CollabCheckpointGitRef[] {
  const refs = stdout.toString('utf8').trim().split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf(' ');
    const oid = line.slice(0, separator);
    const name = line.slice(separator + 1);
    if (
      separator < 1
      || !isCollabGitOid(oid)
      || (name !== COLLAB_MAIN_REF && !name.startsWith(COLLAB_MEMBER_REF_PREFIX))
    ) throw effectsError('authority-transfer-ref-inventory-invalid');
    return { name, oid };
  });
  refs.sort((left, right) => (
    left.name === COLLAB_MAIN_REF
      ? -1
      : right.name === COLLAB_MAIN_REF
        ? 1
        : left.name.localeCompare(right.name, 'en-US')
  ));
  if (refs[0]?.name !== COLLAB_MAIN_REF) {
    throw effectsError('authority-transfer-main-ref-missing');
  }
  return refs;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw effectsError('authority-transfer-staging-file-invalid');
    }
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof CollabError) throw error;
    throw effectsError('authority-transfer-staging-file-invalid');
  }
}

async function writePrivateJson(filePath: string, value: unknown): Promise<void> {
  await writePrivateFileAtomically(filePath, `${JSON.stringify(value)}\n`);
}

async function writePrivateFileAtomically(
  filePath: string,
  contents: string | Uint8Array,
): Promise<void> {
  const partialPath = `${filePath}.partial`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    await rm(partialPath, { force: true });
    handle = await open(partialPath, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(partialPath, filePath);
    const promoted = await lstat(filePath);
    if (!promoted.isFile() || promoted.isSymbolicLink()) {
      throw effectsError('authority-transfer-staging-file-invalid');
    }
    const directory = await open(path.dirname(filePath), 'r').catch(() => null);
    await directory?.sync().catch(() => undefined);
    await directory?.close().catch(() => undefined);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(partialPath, { force: true }).catch(() => undefined);
    if (error instanceof CollabError) throw error;
    throw effectsError('authority-transfer-staging-write-failed');
  }
}

async function stagedArtifactsMatch(
  stagingPath: string,
  manifest: CollabProjectCheckpointManifest,
): Promise<boolean> {
  for (const fact of manifest.artifacts) {
    const filePath = path.join(stagingPath, fact.name);
    const info = await lstat(filePath).catch(() => null);
    if (!info || !info.isFile() || info.isSymbolicLink() || info.size !== fact.byteCount) {
      return false;
    }
    const digest = createHash('sha256');
    try {
      for await (const chunk of createReadStream(filePath)) digest.update(chunk as Buffer);
    } catch {
      return false;
    }
    if (digest.digest('hex') !== fact.sha256) return false;
  }
  return true;
}

async function sourceProofKey(stagingPath: string): Promise<SourceProofKey> {
  const filePath = path.join(stagingPath, SOURCE_KEY_FILE);
  const existing = await readJsonFile<SourceProofKey>(filePath);
  if (existing) {
    if (
      existing.schemaVersion !== 1
      || !/^[A-Za-z0-9_-]+$/.test(existing.privateKey)
      || !/^[A-Za-z0-9_-]{43}$/.test(existing.publicKey)
      || !isCollabOpaqueId(existing.receiptKeyId)
    ) throw effectsError('authority-transfer-source-key-invalid');
    return existing;
  }
  const generated = generateKeyPairSync('ed25519');
  const publicKey = generated.publicKey.export({ format: 'jwk' }).x;
  if (!publicKey) throw effectsError('authority-transfer-source-key-invalid');
  const key: SourceProofKey = {
    privateKey: generated.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    publicKey,
    receiptKeyId: `lan-${createHash('sha256').update(publicKey).digest('hex').slice(0, 32)}`,
    schemaVersion: 1,
  };
  await writePrivateJson(filePath, key);
  return (await readJsonFile<SourceProofKey>(filePath)) ?? key;
}

function signEd25519(key: SourceProofKey, payload: string): string {
  return sign(null, Buffer.from(payload, 'utf8'), createPrivateKey({
    format: 'der',
    key: Buffer.from(key.privateKey, 'base64url'),
    type: 'pkcs8',
  })).toString('base64url');
}

export class ProductionLanToCloudSourceEffects implements LanToCloudSourceEffects {
  constructor(private readonly options: ProductionLanToCloudSourceEffectsOptions) {}

  async sourceEndpoint(record: AuthorityTransferRecord): Promise<string> {
    const endpoint = await this.options.foundation.lanHost
      .pinAuthorityTransferSourceEndpoint(record.projectId);
    try {
      const membership = await this.requireLanMembership(record.projectId);
      if (!membership.authority.endpoint || membership.authority.endpoint !== endpoint) {
        throw effectsError('authority-transfer-source-endpoint-missing');
      }
      return endpoint;
    } catch (error) {
      await this.options.foundation.lanHost.unpinAuthorityTransferSourceEndpoint(
        record.projectId,
        endpoint,
      ).catch(() => undefined);
      throw error;
    }
  }

  releaseSourceEndpoint(record: AuthorityTransferRecord, endpoint: string): Promise<void> {
    return this.options.foundation.lanHost.unpinAuthorityTransferSourceEndpoint(
      record.projectId,
      endpoint,
    );
  }

  acceptanceRequest(record: AuthorityTransferRecord): Promise<AcceptLanToCloudTransferTargetRequest> {
    return Promise.resolve({
      expectedAuthorityGeneration: record.status.sourceAuthority.generation,
      idempotencyKey: `${record.operationIntentId}-accept`,
      projectId: record.projectId,
      targetUrl: record.status.targetUrl,
      transferId: record.transferId,
    });
  }

  acceptProposal(
    request: AcceptLanToCloudTransferTargetRequest,
    options: CollabOperationOptions = {},
  ) {
    return this.requireCloudSession().lifecycle.authorityTransfer(
      'acceptLanToCloudTransferTarget',
      request,
      options,
    );
  }

  async activateTerminal(
    record: AuthorityTransferRecord,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    const proof = record.status.relinquishmentProof;
    if (!proof) throw effectsError('authority-transfer-relinquishment-proof-missing');
    const service = await this.terminalService(record);
    await this.options.foundation.lanHost.relinquishProjectForAuthorityTransfer(record.projectId);
    await this.options.foundation.lanHost.activateAuthorityTransferTerminalSource({
      expectedEndpoint: this.requireSourceEndpoint(record),
      projectId: record.projectId,
      relinquishmentProof: proof,
      service,
      transferId: record.transferId,
    });
    await this.convergeHost(record, options);
  }

  async restoreCompleted(
    record: AuthorityTransferRecord,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    if (!record.status.relinquishmentProof) {
      throw effectsError('authority-transfer-relinquishment-proof-missing');
    }
    const service = await this.terminalService(record);
    if (isAuthorityTransferTerminalResponderExpired(record, new Date())) {
      await service.expire();
      return;
    }
    await this.options.foundation.lanHost.startAuthorityTransferRoute({
      expectedEndpoint: this.requireSourceEndpoint(record),
      projectId: record.projectId,
      service,
      state: 'terminal-source',
      transferId: record.transferId,
    });
    await this.convergeHost(record, options);
  }

  private async terminalService(
    record: AuthorityTransferRecord,
  ): Promise<PersistentLanAuthorityTransferTerminalSourceService> {
    const authority = await this.options.foundation.inspectAuthority(record.projectId);
    if (!authority) throw effectsError('authority-transfer-source-authority-missing');
    const authenticator = new AuthorityMemberCredentialAuthenticator(authority.database);
    return new PersistentLanAuthorityTransferTerminalSourceService({
      authenticate: async credential => ({
        memberId: (await authenticator.authenticate(credential, ['active'])).member.id,
      }),
      cleanupStaging: current => this.cleanupStaging(current),
      expiresAt: record.status.expiresAt,
      persistence: this.options.persistence,
      projectId: record.projectId,
      transferId: record.transferId,
    });
  }

  private async convergeHost(
    record: AuthorityTransferRecord,
    options: CollabOperationOptions,
  ): Promise<void> {
    const cloudSession = this.requireCloudSession();
    const snapshot = await cloudSession.readSnapshot(record.projectId, options);
    await this.options.convergence.lanToCloudHost({
      developmentActorId: cloudSession.developmentActorId,
      snapshot,
      status: record.status,
    });
  }

  private requireSourceEndpoint(record: AuthorityTransferRecord): string {
    if (!record.sourceLanEndpoint) {
      throw effectsError('authority-transfer-source-endpoint-missing');
    }
    return record.sourceLanEndpoint;
  }

  async capture(
    record: AuthorityTransferRecord,
    options: CollabOperationOptions = {},
  ): Promise<LanToCloudCapturedCheckpoint> {
    const { authority, git, membership, stagingPath } = await this.prepare(record);
    if (this.options.foundation.lanHost.isProjectRunning(record.projectId)) {
      await this.options.foundation.lanHost.quiesceProjectForAuthorityTransfer(
        record.projectId,
        options.signal,
      );
    } else if (record.restartFence !== 'temporary') {
      throw effectsError('authority-transfer-source-capture-fence-invalid');
    }
    const existing = await readJsonFile<CollabProjectCheckpointManifest>(
      path.join(stagingPath, MANIFEST_FILE),
    );
    let manifest: CollabProjectCheckpointManifest;
    const verifiedExisting = existing
      ? verifyAuthorityTransferCheckpointManifest(existing)
      : null;
    if (verifiedExisting && await stagedArtifactsMatch(stagingPath, verifiedExisting)) {
      manifest = verifiedExisting;
    } else {
      await Promise.all([
        MANIFEST_FILE,
        COORDINATION_FILE,
        BUNDLE_FILE,
        SOURCE_PROOF_FILE,
        RELINQUISHMENT_FILE,
      ].map(fileName => rm(path.join(stagingPath, fileName), { force: true })));
      const repositoryPath = path.join(authority.authorityDirectory, 'repository.git');
      await new AuthorityTransferAdmissionSettlement({
        database: authority.database,
        runner: git.runner,
      }).settle({
        repositoryPath,
        settledAt: record.status.updatedAt,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const refs = parseRefs((await git.runner.run({
        args: [
          'for-each-ref',
          '--format=%(objectname) %(refname)',
          COLLAB_MAIN_REF,
          COLLAB_MEMBER_REF_PREFIX,
        ],
        cwd: repositoryPath,
        maxStdoutBytes: 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
        suppressHooks: true,
      })).stdout);
      const objectFormatResult = await git.runner.run({
        args: ['rev-parse', '--show-object-format'],
        cwd: repositoryPath,
        maxStdoutBytes: 64 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
        suppressHooks: true,
      });
      const objectFormat = objectFormatResult.stdout.toString('utf8').trim();
      if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
        throw effectsError('authority-transfer-object-format-invalid');
      }
      const expectedMainOid = refs[0].oid;
      const coordination = await authority.database.read(connection => (
        new AuthorityTransferCheckpointRepository().exportCoordination(connection, {
          expectedMainOid,
        })
      ));
      const coordinationBytes = Buffer.from(coordination, 'utf8');
      await writeFile(path.join(stagingPath, COORDINATION_FILE), coordinationBytes, {
        flag: 'wx',
        mode: 0o600,
      });
      const bundleFact = await new AuthorityTransferCheckpointGit(git.runner).createBundle({
        bundlePath: path.join(stagingPath, BUNDLE_FILE),
        refs,
        repositoryPath,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      manifest = createAuthorityTransferCheckpointManifest({
        artifacts: [artifactFact('coordination.ndjson', coordinationBytes), bundleFact],
        createdAt: record.status.createdAt,
        expectedMainOid,
        gitObjectFormat: objectFormat,
        operationId: record.transferId,
        projectId: record.projectId,
        refs,
        sourceAuthority: record.status.sourceAuthority,
        targetAuthority: record.status.targetAuthority,
      });
      await writePrivateFileAtomically(
        path.join(stagingPath, MANIFEST_FILE),
        encodeCollabProjectCheckpointManifestCanonicalJson(manifest),
      );
    }
    if (manifest.projectId !== record.projectId || manifest.operationId !== record.transferId) {
      throw effectsError('authority-transfer-checkpoint-owner-mismatch');
    }
    const sourceProof = await this.createSourceProof(record, manifest, stagingPath);
    return {
      artifacts: [
        { artifact: MANIFEST_FILE, body: createReadStream(path.join(stagingPath, MANIFEST_FILE)), byteCount: (await lstat(path.join(stagingPath, MANIFEST_FILE))).size },
        { artifact: COORDINATION_FILE, body: createReadStream(path.join(stagingPath, COORDINATION_FILE)), byteCount: (await lstat(path.join(stagingPath, COORDINATION_FILE))).size },
        { artifact: BUNDLE_FILE, body: createReadStream(path.join(stagingPath, BUNDLE_FILE)), byteCount: (await lstat(path.join(stagingPath, BUNDLE_FILE))).size },
      ],
      checkpointManifestSha256: manifest.manifestSha256,
      sourceHostMemberId: membership.member.id,
      sourceProof,
    };
  }

  async commitRelinquishmentFence(
    record: AuthorityTransferRecord,
  ): Promise<CollabAuthorityRelinquishmentProof> {
    const { stagingPath } = await this.prepare(record);
    const existing = await readJsonFile<CollabAuthorityRelinquishmentProof>(
      path.join(stagingPath, RELINQUISHMENT_FILE),
    );
    let proof = existing;
    if (!proof) {
      const status = record.status;
      if (
        status.batchRevision === null
        || status.batchSha256 === null
        || status.checkpointSha256 === null
        || status.sourceAuthority.kind !== 'lan'
        || status.targetAuthority.kind !== 'cloud'
      ) throw effectsError('authority-transfer-relinquishment-facts-missing');
      const membership = await this.requireLanMembership(record.projectId);
      const sourceAuthority = status.sourceAuthority as typeof status.sourceAuthority & {
        readonly kind: 'lan';
      };
      const targetAuthority = status.targetAuthority as typeof status.targetAuthority & {
        readonly kind: 'cloud';
      };
      const payload = {
        batchRevision: status.batchRevision,
        batchSha256: status.batchSha256,
        certificateAlgorithm: 'ed25519' as const,
        checkpointSha256: status.checkpointSha256,
        committedAt: status.updatedAt,
        operationIntentId: record.operationIntentId,
        projectId: record.projectId,
        sourceAuthority,
        sourceHostMemberId: membership.member.id,
        targetAuthority,
        transferId: record.transferId,
      };
      const key = await sourceProofKey(stagingPath);
      proof = {
        ...payload,
        certificate: signEd25519(
          key,
          encodeCollabAuthorityRelinquishmentProofSigningInput(payload),
        ),
      };
      await writePrivateJson(path.join(stagingPath, RELINQUISHMENT_FILE), proof);
    }
    if (!proof) throw effectsError('authority-transfer-relinquishment-proof-missing');
    await this.options.foundation.lanHost.relinquishProjectForAuthorityTransfer(record.projectId);
    return proof;
  }

  async reopenAfterCancellation(record: AuthorityTransferRecord): Promise<void> {
    if (this.options.foundation.lanHost.isProjectRunning(record.projectId)) {
      await this.options.foundation.lanHost.reopenProjectAfterAuthorityTransferCancellation(
        record.projectId,
      );
    } else {
      await this.options.foundation.lanHost.startProject(record.projectId);
    }
    if (record.sourceLanEndpoint) {
      await this.options.foundation.lanHost.unpinAuthorityTransferSourceEndpoint(
        record.projectId,
        record.sourceLanEndpoint,
      );
    }
    await this.cleanupStaging(record);
  }

  requestProposal(
    request: Parameters<LanToCloudSourceEffects['requestProposal']>[0],
    options: CollabOperationOptions = {},
  ) {
    return this.requireCloudSession().lifecycle.authorityTransfer(
      'requestLanToCloudTransfer',
      request,
      options,
    );
  }

  private requireCloudSession(): CloudAuthorityLifecycleSession {
    if (!this.options.cloudSession) {
      throw effectsError('authority-transfer-cloud-session-unavailable');
    }
    return this.options.cloudSession;
  }

  private async cleanupStaging(record: AuthorityTransferRecord): Promise<void> {
    const membership = await this.options.foundation.local.projects.loadMembership(record.projectId);
    if (!membership) throw effectsError('authority-transfer-membership-missing');
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

  private async createSourceProof(
    record: AuthorityTransferRecord,
    manifest: CollabProjectCheckpointManifest,
    stagingPath: string,
  ): Promise<string> {
    const filePath = path.join(stagingPath, SOURCE_PROOF_FILE);
    const existing = await readJsonFile<{ readonly proof: string }>(filePath);
    if (existing) return existing.proof;
    const membership = await this.requireLanMembership(record.projectId);
    const key = await sourceProofKey(stagingPath);
    const payload = {
      checkpointManifestSha256: manifest.manifestSha256,
      projectId: record.projectId,
      sourceAuthorityGeneration: record.status.sourceAuthority.generation,
      sourceHostMemberId: membership.member.id,
      targetAuthorityGeneration: record.status.targetAuthority.generation,
      targetUrl: record.status.targetUrl,
      transferId: record.transferId,
    };
    const signer = await this.options.foundation.lanHost.hostCaSigner();
    const envelope: SourceProofEnvelope = {
      caCertificatePem: signer.caCertificatePem,
      certificate: await signer.signRsaPssSha256(Buffer.from(JSON.stringify({
        payload,
        receiptKeyId: key.receiptKeyId,
        receiptPublicKey: key.publicKey,
        schemaVersion: 1,
      }), 'utf8')),
      payload,
      receiptKeyId: key.receiptKeyId,
      receiptPublicKey: key.publicKey,
      schemaVersion: 1,
    };
    const proof = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
    await writePrivateJson(filePath, { proof });
    return (await readJsonFile<{ readonly proof: string }>(filePath))?.proof ?? proof;
  }

  private async prepare(record: AuthorityTransferRecord): Promise<{
    readonly authority: CollabAuthorityFoundation;
    readonly git: CollabGitFoundation;
    readonly membership: Awaited<ReturnType<ProductionLanToCloudSourceEffects['requireLanMembership']>>;
    readonly stagingPath: string;
  }> {
    if (record.projectId !== this.options.projectId) {
      throw effectsError('authority-transfer-project-mismatch');
    }
    const membership = await this.requireLanMembership(record.projectId);
    const [authority, git, staging] = await Promise.all([
      this.options.foundation.openAuthority(record.projectId),
      this.options.foundation.requireGitFoundation(),
      this.options.foundation.local.workspace.reserveProjectsFolderChild(
        projectsFolder(membership.project.workspacePath),
        {
          childName: record.stagingDirectoryName,
          operationId: record.transferId,
          projectId: record.projectId,
          purpose: 'authority-transfer-staging',
        },
      ),
    ]);
    await mkdir(staging.absolutePath, { mode: 0o700 }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw effectsError('authority-transfer-staging-create-failed');
      }
    });
    return { authority, git, membership, stagingPath: staging.absolutePath };
  }

  private async requireLanMembership(projectId: string) {
    const membership = await this.options.foundation.local.projects.loadMembership(projectId);
    if (
      !membership
      || !isCollabLocalLanMembership(membership)
      || !membership.hostOwnership.ownsAuthority
    ) throw effectsError('authority-transfer-source-membership-invalid');
    return membership;
  }
}
