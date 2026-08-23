import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { type CollabGitOid, type CollabIsoTimestamp, type CollabMemberId, type CollabOperationId, type CollabProjectId, isCollabGitOid, isCollabMemberId, isCollabOpaqueId, isCollabProjectId } from '@claudian-collab/protocol';

import { COLLAB_AUTHORITY_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import type { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { COLLAB_HOST_TRANSFER_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';
import type { CollabHostTrustTransitionProof } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export const HOST_TRANSFER_MANIFEST_SCHEMA_VERSION = 1 as const;
export const HOST_TRANSFER_MANIFEST_FILE = 'host-transfer-metadata.json' as const;
export const HOST_TRANSFER_MAX_GIT_BUNDLE_BYTES = 1024 * 1024 * 1024;
export const HOST_TRANSFER_MAX_AUTHORITY_SNAPSHOT_BYTES = 256 * 1024 * 1024;
export const HOST_TRANSFER_MAX_MANIFEST_BYTES = 64 * 1024;

export interface HostTransferArtifactIdentity {
  readonly byteCount: number;
  readonly sha256: string;
}

export interface HostTransferPackageManifest {
  readonly schemaVersion: typeof HOST_TRANSFER_MANIFEST_SCHEMA_VERSION;
  readonly protocolVersion: typeof COLLAB_HOST_TRANSFER_PROTOCOL_VERSION;
  readonly authoritySchemaVersion: 8 | 9 | 10 | typeof COLLAB_AUTHORITY_SCHEMA_VERSION;
  readonly projectId: CollabProjectId;
  readonly transferId: CollabOperationId;
  readonly sourceAuthorityGeneration: number;
  readonly targetHostMemberId: CollabMemberId;
  readonly targetCaFingerprint: string;
  readonly gitObjectFormat: 'sha1' | 'sha256';
  readonly authorityMainOid: CollabGitOid;
  readonly gitBundle: HostTransferArtifactIdentity;
  readonly authoritySnapshot: HostTransferArtifactIdentity;
  readonly proofChainDigest: string;
  readonly createdAt: CollabIsoTimestamp;
}

export interface CreateHostTransferPackageManifestInput {
  readonly projectId: CollabProjectId;
  readonly transferId: CollabOperationId;
  readonly sourceAuthorityGeneration: number;
  readonly targetHostMemberId: CollabMemberId;
  readonly targetCaFingerprint: string;
  readonly gitObjectFormat: 'sha1' | 'sha256';
  readonly authorityMainOid: CollabGitOid;
  readonly gitBundle: HostTransferArtifactIdentity;
  readonly authoritySnapshot: HostTransferArtifactIdentity;
  readonly proofChainDigest: string;
  readonly createdAt: CollabIsoTimestamp;
}

export type HostTransferArtifactKind = 'git-bundle' | 'authority-snapshot';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MANIFEST_KEYS = [
  'schemaVersion',
  'protocolVersion',
  'authoritySchemaVersion',
  'projectId',
  'transferId',
  'sourceAuthorityGeneration',
  'targetHostMemberId',
  'targetCaFingerprint',
  'gitObjectFormat',
  'authorityMainOid',
  'gitBundle',
  'authoritySnapshot',
  'proofChainDigest',
  'createdAt',
] as const;
const ARTIFACT_KEYS = ['byteCount', 'sha256'] as const;

function packageError(
  reason: string,
  code: 'authority-integrity-error' | 'cancelled' | 'quota-exceeded' | 'operation-failed'
    = 'authority-integrity-error',
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'cancelled' ? ['retry'] : ['open-diagnostics'],
    safeContext: { reason },
  });
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every(key => keys.includes(key));
}

function assertTimestamp(value: string): void {
  if (Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw packageError('host-transfer-manifest-time-invalid');
  }
}

function assertArtifact(
  value: HostTransferArtifactIdentity,
  maxBytes: number,
  reason: string,
): void {
  if (
    !Number.isSafeInteger(value.byteCount)
    || value.byteCount < 1
    || value.byteCount > maxBytes
    || !DIGEST_PATTERN.test(value.sha256)
  ) {
    throw packageError(reason);
  }
}

function assertManifest(
  manifest: HostTransferPackageManifest,
  allowLegacyAuthority: boolean,
): void {
  if (
    manifest.schemaVersion !== HOST_TRANSFER_MANIFEST_SCHEMA_VERSION
    || manifest.protocolVersion !== COLLAB_HOST_TRANSFER_PROTOCOL_VERSION
    || (
      manifest.authoritySchemaVersion !== COLLAB_AUTHORITY_SCHEMA_VERSION
      && (
        !allowLegacyAuthority
        || (
          manifest.authoritySchemaVersion !== 8
          && manifest.authoritySchemaVersion !== 9
          && manifest.authoritySchemaVersion !== 10
        )
      )
    )
  ) {
    throw packageError('host-transfer-manifest-version-invalid');
  }
  if (!isCollabProjectId(manifest.projectId)) {
    throw packageError('host-transfer-manifest-project-invalid');
  }
  if (!isCollabOpaqueId(manifest.transferId)) {
    throw packageError('host-transfer-manifest-transfer-invalid');
  }
  if (!isCollabMemberId(manifest.targetHostMemberId)) {
    throw packageError('host-transfer-manifest-target-invalid');
  }
  if (!Number.isSafeInteger(manifest.sourceAuthorityGeneration) || manifest.sourceAuthorityGeneration < 0) {
    throw packageError('host-transfer-manifest-generation-invalid');
  }
  if (!DIGEST_PATTERN.test(manifest.targetCaFingerprint)) {
    throw packageError('host-transfer-manifest-ca-invalid');
  }
  if (manifest.gitObjectFormat !== 'sha1' && manifest.gitObjectFormat !== 'sha256') {
    throw packageError('host-transfer-manifest-object-format-invalid');
  }
  const expectedOidLength = manifest.gitObjectFormat === 'sha1' ? 40 : 64;
  if (
    !isCollabGitOid(manifest.authorityMainOid)
    || manifest.authorityMainOid.length !== expectedOidLength
  ) {
    throw packageError('host-transfer-manifest-main-oid-invalid');
  }
  assertArtifact(
    manifest.gitBundle,
    HOST_TRANSFER_MAX_GIT_BUNDLE_BYTES,
    'host-transfer-manifest-git-invalid',
  );
  assertArtifact(
    manifest.authoritySnapshot,
    HOST_TRANSFER_MAX_AUTHORITY_SNAPSHOT_BYTES,
    'host-transfer-manifest-authority-invalid',
  );
  if (!DIGEST_PATTERN.test(manifest.proofChainDigest)) {
    throw packageError('host-transfer-manifest-proof-digest-invalid');
  }
  assertTimestamp(manifest.createdAt);
}

function canonicalManifest(
  manifest: HostTransferPackageManifest,
): HostTransferPackageManifest {
  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    protocolVersion: manifest.protocolVersion,
    authoritySchemaVersion: manifest.authoritySchemaVersion,
    projectId: manifest.projectId,
    transferId: manifest.transferId,
    sourceAuthorityGeneration: manifest.sourceAuthorityGeneration,
    targetHostMemberId: manifest.targetHostMemberId,
    targetCaFingerprint: manifest.targetCaFingerprint,
    gitObjectFormat: manifest.gitObjectFormat,
    authorityMainOid: manifest.authorityMainOid,
    gitBundle: Object.freeze({ ...manifest.gitBundle }),
    authoritySnapshot: Object.freeze({ ...manifest.authoritySnapshot }),
    proofChainDigest: manifest.proofChainDigest,
    createdAt: manifest.createdAt,
  });
}

export function createHostTransferPackageManifest(
  input: CreateHostTransferPackageManifestInput,
): HostTransferPackageManifest {
  const manifest: HostTransferPackageManifest = {
    schemaVersion: HOST_TRANSFER_MANIFEST_SCHEMA_VERSION,
    protocolVersion: COLLAB_HOST_TRANSFER_PROTOCOL_VERSION,
    authoritySchemaVersion: COLLAB_AUTHORITY_SCHEMA_VERSION,
    projectId: input.projectId,
    transferId: input.transferId,
    sourceAuthorityGeneration: input.sourceAuthorityGeneration,
    targetHostMemberId: input.targetHostMemberId,
    targetCaFingerprint: input.targetCaFingerprint,
    gitObjectFormat: input.gitObjectFormat,
    authorityMainOid: input.authorityMainOid,
    gitBundle: Object.freeze({ ...input.gitBundle }),
    authoritySnapshot: Object.freeze({ ...input.authoritySnapshot }),
    proofChainDigest: input.proofChainDigest,
    createdAt: input.createdAt,
  };
  assertManifest(manifest, false);
  return canonicalManifest(manifest);
}

export function serializeHostTransferPackageManifest(
  manifest: HostTransferPackageManifest,
): string {
  assertManifest(manifest, true);
  return JSON.stringify(canonicalManifest(manifest));
}

function decodeManifest(
  value: unknown,
  allowLegacyAuthority: boolean,
): HostTransferPackageManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw packageError('host-transfer-manifest-invalid');
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (!exactKeys(record, MANIFEST_KEYS)) throw packageError('host-transfer-manifest-shape-invalid');
  for (const key of ['gitBundle', 'authoritySnapshot'] as const) {
    const artifact = record[key];
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
      throw packageError('host-transfer-manifest-artifact-invalid');
    }
    if (!exactKeys(artifact as Readonly<Record<string, unknown>>, ARTIFACT_KEYS)) {
      throw packageError('host-transfer-manifest-artifact-shape-invalid');
    }
  }
  const manifest = record as unknown as HostTransferPackageManifest;
  assertManifest(manifest, allowLegacyAuthority);
  return canonicalManifest(manifest);
}

export function decodeHostTransferPackageManifest(value: unknown): HostTransferPackageManifest {
  return decodeManifest(value, false);
}

export function decodeHostTransferRecoveryPackageManifest(
  value: unknown,
): HostTransferPackageManifest {
  return decodeManifest(value, true);
}

export function parseHostTransferPackageManifest(serialized: string): HostTransferPackageManifest {
  return parseManifest(serialized, false);
}

export function parseHostTransferRecoveryPackageManifest(
  serialized: string,
): HostTransferPackageManifest {
  return parseManifest(serialized, true);
}

function parseManifest(
  serialized: string,
  allowLegacyAuthority: boolean,
): HostTransferPackageManifest {
  if (Buffer.byteLength(serialized, 'utf8') > HOST_TRANSFER_MAX_MANIFEST_BYTES) {
    throw packageError('host-transfer-manifest-too-large', 'quota-exceeded');
  }
  try {
    return decodeManifest(JSON.parse(serialized), allowLegacyAuthority);
  } catch (error) {
    if (error instanceof CollabError) throw error;
    throw packageError('host-transfer-manifest-invalid');
  }
}

export function digestHostTransferPackageManifest(
  manifest: HostTransferPackageManifest,
): string {
  return createHash('sha256')
    .update(serializeHostTransferPackageManifest(manifest), 'utf8')
    .digest('hex');
}

export function digestHostTransitionProofChain(
  proofs: readonly CollabHostTrustTransitionProof[],
): string {
  const canonical = proofs.map(proof => [
    proof.schemaVersion,
    proof.projectId,
    proof.transferId,
    proof.previousCaFingerprint,
    proof.nextCaCertificatePem,
    proof.nextCaFingerprint,
    proof.issuedAt,
    proof.signatureAlgorithm,
    proof.signature,
  ]);
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

async function requireRegularFile(filePath: string, reason: string): Promise<number> {
  const info = await lstat(filePath).catch(() => null);
  if (!info || !info.isFile() || info.isSymbolicLink()) throw packageError(reason);
  return info.size;
}

export async function inspectHostTransferArtifact(
  filePath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<HostTransferArtifactIdentity> {
  const byteCount = await requireRegularFile(filePath, 'host-transfer-artifact-invalid');
  if (byteCount < 1 || byteCount > maxBytes) {
    throw packageError('host-transfer-artifact-size-invalid', 'quota-exceeded');
  }
  const digest = createHash('sha256');
  let observed = 0;
  try {
    for await (const chunk of createReadStream(filePath)) {
      if (signal?.aborted) throw packageError('host-transfer-artifact-cancelled', 'cancelled');
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      observed += bytes.byteLength;
      if (observed > maxBytes) throw packageError('host-transfer-artifact-size-invalid', 'quota-exceeded');
      digest.update(bytes);
    }
  } catch (error) {
    if (error instanceof CollabError) throw error;
    throw packageError('host-transfer-artifact-read-failed', 'operation-failed');
  }
  if (observed !== byteCount) throw packageError('host-transfer-artifact-changed');
  return Object.freeze({ byteCount, sha256: digest.digest('hex') });
}

export class HostTransferArtifactStore {
  constructor(private readonly operationDirectory: string) {}

  pathFor(kind: HostTransferArtifactKind): string {
    return path.join(
      this.operationDirectory,
      kind === 'git-bundle' ? 'authority.bundle' : 'authority.db',
    );
  }

  async receive(
    kind: HostTransferArtifactKind,
    source: AsyncIterable<Uint8Array>,
    expected: HostTransferArtifactIdentity,
    signal?: AbortSignal,
  ): Promise<string> {
    const maxBytes = kind === 'git-bundle'
      ? HOST_TRANSFER_MAX_GIT_BUNDLE_BYTES
      : HOST_TRANSFER_MAX_AUTHORITY_SNAPSHOT_BYTES;
    assertArtifact(expected, maxBytes, 'host-transfer-artifact-expectation-invalid');
    const directory = await lstat(this.operationDirectory).catch(() => null);
    if (!directory || !directory.isDirectory() || directory.isSymbolicLink()) {
      throw packageError('host-transfer-operation-directory-invalid');
    }
    const finalPath = this.pathFor(kind);
    const existing = await lstat(finalPath).catch(() => null);
    if (existing) {
      const identity = await inspectHostTransferArtifact(finalPath, maxBytes, signal);
      if (identity.byteCount === expected.byteCount && identity.sha256 === expected.sha256) {
        return finalPath;
      }
      throw packageError('host-transfer-artifact-replay-mismatch');
    }

    const temporaryPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    const digest = createHash('sha256');
    let observed = 0;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      for await (const chunk of source) {
        if (signal?.aborted) throw packageError('host-transfer-artifact-cancelled', 'cancelled');
        if (!(chunk instanceof Uint8Array)) throw packageError('host-transfer-artifact-chunk-invalid');
        observed += chunk.byteLength;
        if (observed > expected.byteCount || observed > maxBytes) {
          throw packageError('host-transfer-artifact-size-invalid', 'quota-exceeded');
        }
        digest.update(chunk);
        await handle.write(chunk);
      }
      if (signal?.aborted) throw packageError('host-transfer-artifact-cancelled', 'cancelled');
      const actualDigest = digest.digest('hex');
      if (observed !== expected.byteCount || actualDigest !== expected.sha256) {
        throw packageError('host-transfer-artifact-digest-mismatch');
      }
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporaryPath, finalPath);
      return finalPath;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (error instanceof CollabError) throw error;
      throw packageError('host-transfer-artifact-write-failed', 'operation-failed');
    }
  }
}

export class HostTransferGitBundleBuilder {
  constructor(private readonly runner: Pick<GitCommandRunner, 'run'>) {}

  async createAllRefsBundle(
    repositoryPath: string,
    bundlePath: string,
    signal?: AbortSignal,
  ): Promise<HostTransferArtifactIdentity> {
    await rm(bundlePath, { force: true }).catch(() => undefined);
    await this.runner.run({
      args: ['bundle', 'create', bundlePath, '--all'],
      cwd: repositoryPath,
      maxStdoutBytes: 64 * 1024,
      signal,
      suppressHooks: true,
    });
    await this.runner.run({
      args: ['bundle', 'verify', bundlePath],
      cwd: repositoryPath,
      maxStdoutBytes: 1024 * 1024,
      signal,
      suppressHooks: true,
    });
    return inspectHostTransferArtifact(bundlePath, HOST_TRANSFER_MAX_GIT_BUNDLE_BYTES, signal);
  }
}
