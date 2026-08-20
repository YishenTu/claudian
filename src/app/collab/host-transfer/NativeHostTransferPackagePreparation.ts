import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

import { COLLAB_MAIN_REF, isCollabOpaqueId, isCollabProjectId } from '@claudian/collab-protocol';

import { HostTransferRepository } from '@/app/collab/authority/HostTransferRepository';
import type { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import type { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import type { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { HostTransferAuthoritySnapshot } from '@/app/collab/host-transfer/HostTransferAuthoritySnapshot';
import type {
  HostTransferPackagePreparationPort,
  PreparedHostTransferPackage,
} from '@/app/collab/host-transfer/HostTransferCoordinatorPorts';
import {
  createHostTransferPackageManifest,
  digestHostTransferPackageManifest,
  digestHostTransitionProofChain,
  HOST_TRANSFER_MAX_AUTHORITY_SNAPSHOT_BYTES,
  HOST_TRANSFER_MAX_GIT_BUNDLE_BYTES,
  HostTransferGitBundleBuilder,
  type HostTransferPackageManifest,
  inspectHostTransferArtifact,
  parseHostTransferRecoveryPackageManifest,
  serializeHostTransferPackageManifest,
} from '@/app/collab/host-transfer/HostTransferPackage';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import type { CollabHostTrustTransitionProof } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const OWNER_FILE = 'owner.json';
const MANIFEST_FILE = 'manifest.json';
const PROOF_FILE = 'proof.json';
const BUNDLE_FILE = 'authority.bundle';
const SNAPSHOT_FILE = 'authority.db';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

interface PackageOwner {
  readonly owner: 'claudian-host-transfer-package';
  readonly projectId: string;
  readonly schemaVersion: 1;
  readonly transferId: string;
}

export interface NativeHostTransferPackagePreparationOptions {
  readonly authorityDirectory: string;
  readonly database: Pick<SqlJsProjectDatabase, 'exportSnapshot' | 'generation' | 'read'>;
  readonly now?: () => Date;
  readonly repositoryPath: string;
  readonly repositories: Pick<GitRepositoryService, 'resolveRef'>;
  readonly runner: Pick<GitCommandRunner, 'run'>;
  readonly snapshots?: HostTransferAuthoritySnapshot;
}

function preparationError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function exactJsonObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const present = Object.keys(value);
  return present.length === keys.length && present.every(key => keys.includes(key));
}

async function writePrivateFile(filePath: string, bytes: Uint8Array | string): Promise<void> {
  const handle = await open(filePath, 'wx', 0o600).catch(() => null);
  if (!handle) throw preparationError('host-transfer-package-file-collision');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch {
    throw preparationError('host-transfer-package-write-failed');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function* streamFile(filePath: string, signal?: AbortSignal): AsyncIterable<Uint8Array> {
  try {
    for await (const chunk of createReadStream(filePath)) {
      if (signal?.aborted) {
        throw new CollabError({ code: 'cancelled', recoveryActions: ['retry'] });
      }
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    }
  } catch (error) {
    if (error instanceof CollabError) throw error;
    throw preparationError('host-transfer-package-read-failed');
  }
}

export class NativeHostTransferPackagePreparation implements HostTransferPackagePreparationPort {
  private readonly bundleBuilder: HostTransferGitBundleBuilder;
  private readonly now: () => Date;
  private readonly operationQueue = new SerialTaskQueue();
  private readonly snapshots: HostTransferAuthoritySnapshot;

  constructor(private readonly options: NativeHostTransferPackagePreparationOptions) {
    this.bundleBuilder = new HostTransferGitBundleBuilder(options.runner);
    this.now = options.now ?? (() => new Date());
    this.snapshots = options.snapshots ?? new HostTransferAuthoritySnapshot();
  }

  prepare(
    input: Parameters<HostTransferPackagePreparationPort['prepare']>[0],
  ): Promise<PreparedHostTransferPackage> {
    return this.operationQueue.run(() => this.prepareUnlocked(input));
  }

  restore(
    input: Parameters<HostTransferPackagePreparationPort['restore']>[0],
  ): Promise<PreparedHostTransferPackage> {
    return this.operationQueue.run(() => this.restoreUnlocked(input));
  }

  private async prepareUnlocked(
    input: Parameters<HostTransferPackagePreparationPort['prepare']>[0],
  ): Promise<PreparedHostTransferPackage> {
    if (input.signal?.aborted) throw new CollabError({ code: 'cancelled' });
    this.assertIdentity(input.projectId, input.transferId);
    const directory = await this.ensureOperationDirectory(input.projectId, input.transferId);
    const manifestPath = path.join(directory, MANIFEST_FILE);
    if (await lstat(manifestPath).catch(() => null)) {
      const restored = await this.restoreUnlocked({
        manifestDigest: digestHostTransferPackageManifest(
          parseHostTransferRecoveryPackageManifest(await readFile(manifestPath, 'utf8')),
        ),
        projectId: input.projectId,
        transferId: input.transferId,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (
        restored.manifest.targetHostMemberId !== input.targetHostMemberId
        || restored.manifest.targetCaFingerprint !== input.targetCaFingerprint
        || JSON.stringify(restored.proof) !== JSON.stringify(input.proof)
      ) throw preparationError('host-transfer-package-prepare-replay-mismatch');
      return restored;
    }

    await Promise.all([
      rm(path.join(directory, BUNDLE_FILE), { force: true }),
      rm(path.join(directory, SNAPSHOT_FILE), { force: true }),
      rm(path.join(directory, PROOF_FILE), { force: true }),
    ]);
    const sourceAuthorityGeneration = this.options.database.generation;
    const [mainOid, objectFormatResult, existingProofs, sourceSnapshot] = await Promise.all([
      this.options.repositories.resolveRef(this.options.repositoryPath, COLLAB_MAIN_REF),
      this.options.runner.run({
        args: ['rev-parse', '--show-object-format'],
        cwd: this.options.repositoryPath,
        maxStdoutBytes: 128,
        signal: input.signal,
        suppressHooks: true,
      }),
      this.options.database.read(connection => new HostTransferRepository().listProofs(connection)),
      this.options.database.exportSnapshot(),
    ]);
    if (!mainOid) throw preparationError('host-transfer-package-main-missing');
    const gitObjectFormat = objectFormatResult.stdout.toString('utf8').trim();
    if (gitObjectFormat !== 'sha1' && gitObjectFormat !== 'sha256') {
      throw preparationError('host-transfer-package-object-format-invalid');
    }
    const proofChain = [...existingProofs, input.proof];
    const inertSnapshot = await this.snapshots.createInert({
      bytes: sourceSnapshot,
      createdAt: this.now().toISOString(),
      projectId: input.projectId,
      proof: input.proof,
      targetHostMemberId: input.targetHostMemberId,
      transferId: input.transferId,
    });
    await writePrivateFile(path.join(directory, SNAPSHOT_FILE), inertSnapshot);
    const gitBundle = await this.bundleBuilder.createAllRefsBundle(
      this.options.repositoryPath,
      path.join(directory, BUNDLE_FILE),
      input.signal,
    );
    const authoritySnapshot = await inspectHostTransferArtifact(
      path.join(directory, SNAPSHOT_FILE),
      HOST_TRANSFER_MAX_AUTHORITY_SNAPSHOT_BYTES,
      input.signal,
    );
    const manifest = createHostTransferPackageManifest({
      authorityMainOid: mainOid,
      authoritySnapshot,
      createdAt: this.now().toISOString(),
      gitBundle,
      gitObjectFormat,
      projectId: input.projectId,
      proofChainDigest: digestHostTransitionProofChain(proofChain),
      sourceAuthorityGeneration,
      targetCaFingerprint: input.targetCaFingerprint,
      targetHostMemberId: input.targetHostMemberId,
      transferId: input.transferId,
    });
    await writePrivateFile(path.join(directory, PROOF_FILE), JSON.stringify(input.proof));
    await writePrivateFile(manifestPath, serializeHostTransferPackageManifest(manifest));
    return this.loaded(directory, manifest, input.proof, input.signal);
  }

  private async restoreUnlocked(
    input: Parameters<HostTransferPackagePreparationPort['restore']>[0],
  ): Promise<PreparedHostTransferPackage> {
    this.assertIdentity(input.projectId, input.transferId);
    if (!DIGEST_PATTERN.test(input.manifestDigest)) {
      throw preparationError('host-transfer-package-manifest-digest-invalid');
    }
    const directory = await this.requireOperationDirectory(input.projectId, input.transferId);
    let manifest: HostTransferPackageManifest;
    let proof: CollabHostTrustTransitionProof;
    try {
      manifest = parseHostTransferRecoveryPackageManifest(await readFile(
        path.join(directory, MANIFEST_FILE),
        'utf8',
      ));
      proof = JSON.parse(
        await readFile(path.join(directory, PROOF_FILE), 'utf8'),
      ) as CollabHostTrustTransitionProof;
    } catch (error) {
      if (error instanceof CollabError) throw error;
      throw preparationError('host-transfer-package-metadata-invalid');
    }
    if (
      manifest.projectId !== input.projectId
      || manifest.transferId !== input.transferId
      || digestHostTransferPackageManifest(manifest) !== input.manifestDigest
      || proof.projectId !== input.projectId
      || proof.transferId !== input.transferId
      || proof.nextCaFingerprint !== manifest.targetCaFingerprint
    ) throw preparationError('host-transfer-package-restore-binding-invalid');
    const [bundle, snapshot] = await Promise.all([
      inspectHostTransferArtifact(
        path.join(directory, BUNDLE_FILE),
        HOST_TRANSFER_MAX_GIT_BUNDLE_BYTES,
        input.signal,
      ),
      inspectHostTransferArtifact(
        path.join(directory, SNAPSHOT_FILE),
        HOST_TRANSFER_MAX_AUTHORITY_SNAPSHOT_BYTES,
        input.signal,
      ),
    ]);
    if (
      bundle.byteCount !== manifest.gitBundle.byteCount
      || bundle.sha256 !== manifest.gitBundle.sha256
      || snapshot.byteCount !== manifest.authoritySnapshot.byteCount
      || snapshot.sha256 !== manifest.authoritySnapshot.sha256
    ) throw preparationError('host-transfer-package-artifact-drift');
    return this.loaded(directory, manifest, proof, input.signal);
  }

  private loaded(
    directory: string,
    manifest: HostTransferPackageManifest,
    proof: CollabHostTrustTransitionProof,
    signal?: AbortSignal,
  ): PreparedHostTransferPackage {
    return Object.freeze({
      authoritySnapshot: streamFile(path.join(directory, SNAPSHOT_FILE), signal),
      gitBundle: streamFile(path.join(directory, BUNDLE_FILE), signal),
      manifest,
      manifestDigest: digestHostTransferPackageManifest(manifest),
      proof: Object.freeze({ ...proof }),
    });
  }

  private async ensureOperationDirectory(projectId: string, transferId: string): Promise<string> {
    const root = await this.requireAuthorityDirectory();
    const packages = path.join(root, 'host-transfers');
    await mkdir(packages, { mode: 0o700 }).catch(() => undefined);
    const packagesStat = await lstat(packages).catch(() => null);
    if (!packagesStat?.isDirectory() || packagesStat.isSymbolicLink()) {
      throw preparationError('host-transfer-package-root-invalid');
    }
    const directory = path.join(packages, transferId);
    await mkdir(directory, { mode: 0o700 }).catch(() => undefined);
    const directoryStat = await lstat(directory).catch(() => null);
    if (!directoryStat?.isDirectory() || directoryStat.isSymbolicLink()) {
      throw preparationError('host-transfer-package-directory-invalid');
    }
    const ownerPath = path.join(directory, OWNER_FILE);
    const ownerStat = await lstat(ownerPath).catch(() => null);
    if (!ownerStat) {
      await writePrivateFile(ownerPath, JSON.stringify(this.owner(projectId, transferId)));
    }
    await this.assertOwner(directory, projectId, transferId);
    return directory;
  }

  private async requireOperationDirectory(projectId: string, transferId: string): Promise<string> {
    const root = await this.requireAuthorityDirectory();
    const directory = path.join(root, 'host-transfers', transferId);
    const info = await lstat(directory).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) {
      throw preparationError('host-transfer-package-directory-invalid');
    }
    await this.assertOwner(directory, projectId, transferId);
    return directory;
  }

  private async assertOwner(directory: string, projectId: string, transferId: string): Promise<void> {
    try {
      const value = JSON.parse(await readFile(path.join(directory, OWNER_FILE), 'utf8')) as unknown;
      const expected = this.owner(projectId, transferId);
      if (
        !exactJsonObject(value, ['owner', 'projectId', 'schemaVersion', 'transferId'])
        || value.owner !== expected.owner
        || value.projectId !== expected.projectId
        || value.schemaVersion !== expected.schemaVersion
        || value.transferId !== expected.transferId
      ) throw new Error('Owner mismatch');
    } catch {
      throw preparationError('host-transfer-package-owner-invalid');
    }
  }

  private owner(projectId: string, transferId: string): PackageOwner {
    return { owner: 'claudian-host-transfer-package', projectId, schemaVersion: 1, transferId };
  }

  private async requireAuthorityDirectory(): Promise<string> {
    if (!path.isAbsolute(this.options.authorityDirectory)) {
      throw preparationError('host-transfer-authority-directory-invalid');
    }
    const canonical = await realpath(this.options.authorityDirectory).catch(() => null);
    const info = await lstat(this.options.authorityDirectory).catch(() => null);
    if (!canonical || !info?.isDirectory() || info.isSymbolicLink()) {
      throw preparationError('host-transfer-authority-directory-invalid');
    }
    return canonical;
  }

  private assertIdentity(projectId: string, transferId: string): void {
    if (!isCollabProjectId(projectId) || !isCollabOpaqueId(transferId)) {
      throw preparationError('host-transfer-package-identity-invalid');
    }
  }
}
