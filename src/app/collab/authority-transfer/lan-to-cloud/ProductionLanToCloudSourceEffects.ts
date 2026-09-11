import {
  constants,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  sign,
  timingSafeEqual,
  verify,
  X509Certificate,
} from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import {
  COLLAB_MAIN_REF,
  COLLAB_MEMBER_REF_PREFIX,
  type CollabAuthorityRelinquishmentProof,
  type CollabCheckpointArtifactFact,
  type CollabCheckpointGitRef,
  type CollabProjectCheckpointManifest,
  encodeCollabAuthorityRelinquishmentProofSigningInput,
  encodeCollabProjectCheckpointManifestCanonicalJson,
  isCollabGitOid,
  isCollabMemberId,
  isCollabOpaqueId,
} from '@claudian-collab/protocol';

import { PendingMembershipRepository } from '@/app/collab/authority/PendingMembershipRepository';
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
import { writeDurablePrivateFile } from '@/app/collab/authority-transfer/DurablePrivateFile';
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
import type {
  CloudAuthorityConnection,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import type { CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const MANIFEST_FILE = 'checkpoint.json';
const COORDINATION_FILE = 'coordination.ndjson';
const BUNDLE_FILE = 'repository.bundle';
const SOURCE_PROOF_FILE = 'source-proof.json';
const SOURCE_KEY_FILE = 'source-proof-key.json';
const RELINQUISHMENT_FILE = 'relinquishment-proof.json';
const SOURCE_MEMBERS_FILE = 'source-members.json';

interface SourceMemberCredentials {
  readonly schemaVersion: 1;
  readonly projectId: string;
  readonly transferId: string;
  readonly sourceAuthorityGeneration: number;
  readonly members: readonly { readonly memberId: string; readonly credentialHash: string }[];
}

function decodeSourceMemberCredentials(value: unknown, record: AuthorityTransferRecord): SourceMemberCredentials {
  const input = exactRecord(value, new Set(['schemaVersion', 'projectId', 'transferId', 'sourceAuthorityGeneration', 'members']));
  if (!input || input.schemaVersion !== 1 || input.projectId !== record.projectId
    || input.transferId !== record.transferId || input.sourceAuthorityGeneration !== record.status.sourceAuthority.generation
    || !Array.isArray(input.members)) {
    throw effectsError('authority-transfer-source-credentials-invalid');
  }
  const memberIds = new Set<string>();
  const credentialHashes = new Set<string>();
  const members = input.members.map(value => {
    const member = exactRecord(value, new Set(['memberId', 'credentialHash']));
    if (!member || typeof member.memberId !== 'string' || !isCollabMemberId(member.memberId)
      || typeof member.credentialHash !== 'string' || !/^[0-9a-f]{64}$/.test(member.credentialHash)
      || memberIds.has(member.memberId) || credentialHashes.has(member.credentialHash)) {
      throw effectsError('authority-transfer-source-credentials-invalid');
    }
    memberIds.add(member.memberId);
    credentialHashes.add(member.credentialHash);
    return { memberId: member.memberId, credentialHash: member.credentialHash };
  });
  return { schemaVersion: 1, projectId: record.projectId, transferId: record.transferId,
    sourceAuthorityGeneration: record.status.sourceAuthority.generation, members };
}

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
    readonly sourcePrincipalId: string;
    readonly targetAuthorityGeneration: number;
    readonly targetUrl: string;
    readonly transferId: string;
  }>;
  readonly receiptKeyId: string;
  readonly receiptPublicKey: string;
  readonly schemaVersion: 2;
}

const SOURCE_PROOF_KEYS = new Set([
  'caCertificatePem',
  'certificate',
  'payload',
  'receiptKeyId',
  'receiptPublicKey',
  'schemaVersion',
]);
const SOURCE_PROOF_PAYLOAD_KEYS = new Set([
  'checkpointManifestSha256',
  'projectId',
  'sourceAuthorityGeneration',
  'sourceHostMemberId',
  'sourcePrincipalId',
  'targetAuthorityGeneration',
  'targetUrl',
  'transferId',
]);

export interface ProductionLanToCloudSourceEffectsOptions {
  readonly cloudSession: CloudAuthorityConnection | null;
  readonly convergence: AuthorityTransferLocalConvergence;
  readonly foundation: ClaudianCollabService;
  readonly persistence: AuthorityTransferPersistence;
  readonly projectId: string;
  readonly retainCommittedTargetRedemptions?: (
    target: AuthorityTransferRecord,
    source: AuthorityTransferRecord,
    members: SourceMemberCredentials['members'],
  ) => Promise<void>;
}

function effectsError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function exactRecord(value: unknown, keys: ReadonlySet<string>): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  return actual.length === keys.size && actual.every(key => keys.has(key))
    ? record
    : null;
}

function currentSourceProof(
  proof: unknown,
  expectedPayload: SourceProofEnvelope['payload'],
  expectedKey: SourceProofKey,
): string | null {
  if (typeof proof !== 'string') return null;
  let decoded: Buffer;
  let envelope: Record<string, unknown> | null;
  try {
    decoded = Buffer.from(proof, 'base64url');
    if (decoded.toString('base64url') !== proof) return null;
    envelope = exactRecord(JSON.parse(decoded.toString('utf8')), SOURCE_PROOF_KEYS);
  } catch {
    return null;
  }
  if (!envelope || envelope.schemaVersion !== 2) return null;
  const payload = exactRecord(envelope.payload, SOURCE_PROOF_PAYLOAD_KEYS);
  if (!payload) return null;
  for (const [field, expected] of Object.entries(expectedPayload)) {
    if (payload[field] !== expected) return null;
  }
  if (
    envelope.receiptKeyId !== expectedKey.receiptKeyId
    || envelope.receiptPublicKey !== expectedKey.publicKey
    || typeof envelope.caCertificatePem !== 'string'
    || typeof envelope.certificate !== 'string'
  ) return null;
  const signature = Buffer.from(envelope.certificate, 'base64url');
  if (
    signature.byteLength === 0
    || signature.toString('base64url') !== envelope.certificate
  ) return null;
  try {
    const certificate = new X509Certificate(envelope.caCertificatePem);
    const signed = {
      payload: expectedPayload,
      receiptKeyId: expectedKey.receiptKeyId,
      receiptPublicKey: expectedKey.publicKey,
      schemaVersion: 2,
    };
    return verify(
      'sha256',
      Buffer.from(JSON.stringify(signed), 'utf8'),
      {
        key: certificate.publicKey,
        padding: constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32,
      },
      signature,
    ) ? proof : null;
  } catch {
    return null;
  }
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
  await writeDurablePrivateFile(filePath, contents, {
    invalidFile: () => effectsError('authority-transfer-staging-file-invalid'),
    writeFailed: () => effectsError('authority-transfer-staging-write-failed'),
  });
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
      .authorityTransferSourceEndpoint(record.projectId);
    const membership = await this.requireLanMembership(record.projectId);
    if (!membership.authority.endpoint) {
      throw effectsError('authority-transfer-source-endpoint-missing');
    }
    return endpoint;
  }

  async activateTerminal(
    record: AuthorityTransferRecord,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    const proof = record.status.relinquishmentProof;
    if (!proof) throw effectsError('authority-transfer-relinquishment-proof-missing');
    const service = await this.#terminalService(record);
    await this.options.foundation.lanHost.relinquishProjectForAuthorityTransfer(record.projectId);
    await this.options.foundation.lanHost.activateAuthorityTransferTerminalSource({
      projectId: record.projectId,
      relinquishmentProof: proof,
      service,
      transferId: record.transferId,
    });
    await this.#convergeHost(record, options);
    await this.#settleEmptyClaimBatch(record, service);
  }

  async restoreCompleted(
    record: AuthorityTransferRecord,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    if (!record.status.relinquishmentProof) {
      throw effectsError('authority-transfer-relinquishment-proof-missing');
    }
    const service = await this.#terminalService(record);
    if (isAuthorityTransferTerminalResponderExpired(record, new Date())) {
      await this.options.foundation.lanHost.relinquishProjectForAuthorityTransfer(record.projectId);
      await service.expire();
      await this.options.foundation.lanHost.stopAuthorityTransferRoute(
        record.projectId,
        'terminal-source',
        record.transferId,
      );
      return;
    }
    await this.options.foundation.lanHost.startAuthorityTransferRoute({
      authorityGeneration: record.status.sourceAuthority.generation,
      projectId: record.projectId,
      service,
      state: 'terminal-source',
      transferId: record.transferId,
    });
    await this.#convergeHost(record, options);
    await this.#settleEmptyClaimBatch(record, service);
  }

  async restoreRetained(record: AuthorityTransferRecord): Promise<void> {
    const exact = await this.options.persistence.load(record.projectId, record.transferId);
    if (!exact || exact.localRole !== 'source' || exact.status.state !== 'completed'
      || !exact.status.relinquishmentProof || exact.operationIntentId !== record.operationIntentId) {
      throw effectsError('authority-transfer-terminal-record-mismatch');
    }
    if (exact.terminalCleanupCompleted) return;
    const service = await this.#terminalService(exact);
    if (isAuthorityTransferTerminalResponderExpired(exact, new Date())) {
      await service.expire();
      await this.options.foundation.lanHost.stopAuthorityTransferRoute(exact.projectId, 'terminal-source', exact.transferId);
      return;
    }
    decodeSourceMemberCredentials(await readJsonFile(await this.#sourceMemberCredentialsPath(exact)), exact);
    await this.options.foundation.lanHost.startAuthorityTransferRoute({
      authorityGeneration: exact.status.sourceAuthority.generation,
      projectId: exact.projectId,
      service, state: 'terminal-source', transferId: exact.transferId,
    });
  }

  async #sourceMemberCredentialsPath(record: AuthorityTransferRecord): Promise<string> {
    const membership = await this.options.foundation.local.projects.loadMembership(record.projectId);
    if (!membership) throw effectsError('authority-transfer-membership-missing');
    const staging = await this.options.foundation.local.workspace.reserveProjectsFolderChild(
      projectsFolder(membership.project.workspacePath), {
        childName: record.stagingDirectoryName, operationId: record.transferId,
        projectId: record.projectId, purpose: 'authority-transfer-staging',
      },
    );
    return path.join(staging.absolutePath, SOURCE_MEMBERS_FILE);
  }

  async #retainSourceMemberCredentials(record: AuthorityTransferRecord, stagingPath: string, authority: CollabAuthorityFoundation): Promise<SourceMemberCredentials> {
    const filePath = path.join(stagingPath, SOURCE_MEMBERS_FILE);
    const existing = await readJsonFile(filePath);
    if (existing) {
      return decodeSourceMemberCredentials(existing, record);
    }
    const members = await authority.database.read(connection => {
      const project = authority.projects.get(connection);
      if (!project || project.projectId !== record.projectId
        || project.authorityGeneration !== record.status.sourceAuthority.generation) {
        throw effectsError('authority-transfer-source-generation-mismatch');
      }
      return new PendingMembershipRepository().listCredentialRecords(connection, ['active'])
        .filter(member => member.accessState === 'bound' && member.credentialHash !== null)
        .map(member => ({ memberId: member.member.id, credentialHash: Buffer.from(member.credentialHash!).toString('hex') }));
    });
    const retained = decodeSourceMemberCredentials({ schemaVersion: 1, projectId: record.projectId,
      transferId: record.transferId, sourceAuthorityGeneration: record.status.sourceAuthority.generation,
      members }, record);
    await writePrivateJson(filePath, retained);
    return retained;
  }

  async #settleEmptyClaimBatch(
    record: AuthorityTransferRecord,
    service: PersistentLanAuthorityTransferTerminalSourceService,
  ): Promise<void> {
    const empty = await this.options.persistence.isRetainedClaimBatchEmpty(
      record.projectId,
      record.transferId,
    );
    if (!empty) return;
    await service.expire();
    await this.options.foundation.lanHost.stopAuthorityTransferRoute(
      record.projectId,
      'terminal-source',
      record.transferId,
    );
  }

  async #terminalService(
    record: AuthorityTransferRecord,
  ): Promise<PersistentLanAuthorityTransferTerminalSourceService> {
    return new PersistentLanAuthorityTransferTerminalSourceService({
      authenticate: async credential => {
        if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new CollabError({ code: 'authentication-failed' });
        const memberCredentials = decodeSourceMemberCredentials(
          await readJsonFile(await this.#sourceMemberCredentialsPath(record)), record,
        );
        const actual = createHash('sha256').update(credential, 'utf8').digest();
        const matched = memberCredentials.members.filter(member => timingSafeEqual(actual, Buffer.from(member.credentialHash, 'hex')));
        if (matched.length !== 1) throw new CollabError({ code: 'authentication-failed' });
        return { memberId: matched[0].memberId };
      },
      cleanupStaging: current => this.#cleanupStaging(current),
      expiresAt: record.status.expiresAt,
      persistence: this.options.persistence,
      prepareExpiry: async () => {
        const current = await this.options.persistence.load(record.projectId);
        if (current?.transferId === record.transferId) {
          await this.options.convergence.lanToCloudHostOffline(record.status);
        }
      },
      projectId: record.projectId,
      transferId: record.transferId,
    });
  }

  async #convergeHost(
    record: AuthorityTransferRecord,
    options: CollabOperationOptions,
  ): Promise<void> {
    const cloudSession = this.#requireCloudSession();
    const snapshot = await cloudSession.readSnapshot(record.projectId, options);
    await this.options.convergence.lanToCloudHost({
      snapshot,
      status: record.status,
    });
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
    const sourceMembers = await this.#retainSourceMemberCredentials(record, stagingPath, authority);
    for (const target of await this.options.persistence.listRetained(record.projectId)) {
      if (target.localRole !== 'target' || target.terminalCleanupCompleted
        || target.status.targetAuthority.generation !== record.status.sourceAuthority.generation) continue;
      if (!this.options.retainCommittedTargetRedemptions) {
        throw effectsError('authority-transfer-target-redemption-recovery-unavailable');
      }
      await this.options.retainCommittedTargetRedemptions(target, record, sourceMembers.members);
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
      await this.#assertSourceReplayMutable(record, false);
      await Promise.all([
        MANIFEST_FILE,
        COORDINATION_FILE,
        BUNDLE_FILE,
        SOURCE_PROOF_FILE,
        RELINQUISHMENT_FILE,
      ].map(fileName => rm(path.join(stagingPath, fileName), { force: true })));
      const repositoryPath = path.join(authority.authorityDirectory, 'repository.git');
      const physical = await this.options.foundation.local.projects.withAuthorityDirectory(authority.resource, async () => {
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
        return { refs, objectFormat } as const;
      });
      const { refs, objectFormat } = physical;
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
      const bundleFact = await this.options.foundation.local.projects.withAuthorityDirectory(authority.resource, () => new AuthorityTransferCheckpointGit(git.runner).createBundle({
        bundlePath: path.join(stagingPath, BUNDLE_FILE),
        refs,
        repositoryPath,
        ...(options.signal ? { signal: options.signal } : {}),
      }));
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
    const sourceProof = await this.#createSourceProof(record, manifest, stagingPath);
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
    } else if (record.restartFence === 'open') {
      await this.options.foundation.lanHost.startProject(record.projectId);
    } else {
      await this.options.foundation.lanHost.restartProjectAfterAuthorityTransferCancellation({
        operationIntentId: record.operationIntentId,
        projectId: record.projectId,
        transferId: record.transferId,
      });
    }
    await this.#cleanupStaging(record);
  }

  #requireCloudSession(): CloudAuthorityConnection {
    if (!this.options.cloudSession) {
      throw effectsError('authority-transfer-cloud-session-unavailable');
    }
    return this.options.cloudSession;
  }

  async #cleanupStaging(record: AuthorityTransferRecord): Promise<void> {
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

  async #createSourceProof(
    record: AuthorityTransferRecord,
    manifest: CollabProjectCheckpointManifest,
    stagingPath: string,
  ): Promise<string> {
    const filePath = path.join(stagingPath, SOURCE_PROOF_FILE);
    const existing = await readJsonFile<unknown>(filePath);
    const membership = await this.requireLanMembership(record.projectId);
    const key = await sourceProofKey(stagingPath);
    const payload = {
      checkpointManifestSha256: manifest.manifestSha256,
      projectId: record.projectId,
      sourceAuthorityGeneration: record.status.sourceAuthority.generation,
      sourceHostMemberId: membership.member.id,
      sourcePrincipalId: this.#requireCloudSession().principalId,
      targetAuthorityGeneration: record.status.targetAuthority.generation,
      targetUrl: record.status.targetUrl,
      transferId: record.transferId,
    };
    const existingRecord = exactRecord(existing, new Set(['proof']));
    const reusable = currentSourceProof(existingRecord?.proof, payload, key);
    if (reusable !== null) return reusable;
    await this.#assertSourceReplayMutable(record, existing !== null);
    const signer = await this.options.foundation.lanHost.hostCaSigner();
    const envelope: SourceProofEnvelope = {
      caCertificatePem: signer.caCertificatePem,
      certificate: await signer.signRsaPssSha256(Buffer.from(JSON.stringify({
        payload,
        receiptKeyId: key.receiptKeyId,
        receiptPublicKey: key.publicKey,
        schemaVersion: 2,
      }), 'utf8')),
      payload,
      receiptKeyId: key.receiptKeyId,
      receiptPublicKey: key.publicKey,
      schemaVersion: 2,
    };
    const proof = Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
    await writePrivateJson(filePath, { proof });
    const persisted = await readJsonFile<unknown>(filePath);
    if (exactRecord(persisted, new Set(['proof']))?.proof !== proof) {
      throw effectsError('authority-transfer-source-proof-replay-invalid');
    }
    return proof;
  }

  async #assertSourceReplayMutable(
    record: AuthorityTransferRecord,
    requireEntry: boolean,
  ): Promise<void> {
    const [physicalRecord, sourceEntry] = await Promise.all([
      this.options.persistence.load(record.projectId),
      this.options.persistence.loadSourceEntry(record.projectId),
    ]);
    if (!physicalRecord && !sourceEntry && !requireEntry) return;
    if (
      sourceEntry?.entryRole === 'source'
      && sourceEntry.ownerInstallationKey === this.options.foundation.installationKey
      && sourceEntry.successor?.operationIntentId === record.operationIntentId
      && sourceEntry.successor.transferId === record.transferId
      && sourceEntry.beginSubmission === 'not-sent'
    ) return;
    throw effectsError('authority-transfer-source-proof-replay-invalid');
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
