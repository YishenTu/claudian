import { createHash } from 'node:crypto';
import {
  lstat,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';

import { COLLAB_MAIN_REF, type CollabOperationId, type CollabProjectId, isCollabGitOid } from '@claudian-collab/protocol';

import { NodeSqlJsSnapshotStore } from '@/app/collab/authority/SqlJsSnapshotStore';
import { COLLAB_AUTHORITY_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import type { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import type { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import type { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import { HostTransferAuthoritySnapshot } from '@/app/collab/host-transfer/HostTransferAuthoritySnapshot';
import type { IncomingHostTransferPackagePort } from '@/app/collab/host-transfer/HostTransferCoordinatorPorts';
import {
  digestHostTransferPackageManifest,
  HOST_TRANSFER_MANIFEST_FILE,
  HOST_TRANSFER_MAX_AUTHORITY_SNAPSHOT_BYTES,
  HOST_TRANSFER_MAX_GIT_BUNDLE_BYTES,
  HostTransferArtifactStore,
  type HostTransferPackageManifest,
  inspectHostTransferArtifact,
  parseHostTransferRecoveryPackageManifest,
  serializeHostTransferPackageManifest,
} from '@/app/collab/host-transfer/HostTransferPackage';
import type { HostTransferRecoveryRecord } from '@/app/collab/host-transfer/HostTransferRecoveryRecord';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const INSTALL_OWNER_FILE = '.host-transfer-install-owner.json';
const INSTALL_COMPLETE_FILE = '.host-transfer-installed.json';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INSTALL_OWNER_KEYS = [
  'activatedSnapshotDigest',
  'manifestDigest',
  'owner',
  'projectId',
  'schemaVersion',
  'transferId',
] as const;

interface InstallOwner {
  readonly activatedSnapshotDigest: string;
  readonly manifestDigest: string;
  readonly owner: 'claudian-host-transfer-install';
  readonly projectId: CollabProjectId;
  readonly schemaVersion: 1;
  readonly transferId: CollabOperationId;
}

export interface IncomingHostTransferPackageOptions {
  readonly ensureAuthorityDirectory: (projectId: CollabProjectId) => Promise<string>;
  readonly projectsFolder: string;
  readonly readPinnedSourceCa: (projectId: CollabProjectId) => Promise<string>;
  readonly repositories: Pick<
    GitRepositoryService,
    'assertHealthy' | 'configureHostedRepository' | 'resolveRef'
  >;
  readonly resolveWorkingRepository: (projectId: CollabProjectId) => Promise<string>;
  readonly runner: Pick<GitCommandRunner, 'run'>;
  readonly snapshots?: HostTransferAuthoritySnapshot;
  readonly workspace: Pick<CollabWorkspaceService, 'reserveProjectsFolderChild'>;
}

function packageError(reason: string): CollabError {
  return new CollabError({
    code: 'authority-integrity-error',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertArtifactBytes(
  bytes: Uint8Array,
  expected: HostTransferPackageManifest['authoritySnapshot'],
): void {
  if (bytes.byteLength !== expected.byteCount || sha256(bytes) !== expected.sha256) {
    throw packageError('host-transfer-target-artifact-drift');
  }
}

function validReceiverCredential(value: string): boolean {
  if (!CREDENTIAL_PATTERN.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === 32 && decoded.toString('base64url') === value;
}

async function writeExclusive(filePath: string, contents: Uint8Array | string): Promise<void> {
  const handle = await open(filePath, 'wx', 0o600).catch(() => null);
  if (!handle) throw packageError('host-transfer-target-file-collision');
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writeOrValidate(filePath: string, contents: string): Promise<void> {
  const info = await lstat(filePath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw packageError('host-transfer-target-metadata-read-failed');
  });
  if (info && (!info.isFile() || info.isSymbolicLink())) {
    throw packageError('host-transfer-target-metadata-boundary-invalid');
  }
  const existing = await readFile(filePath, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw packageError('host-transfer-target-metadata-read-failed');
  });
  if (existing === null) {
    await writeExclusive(filePath, contents);
    return;
  }
  if (existing !== contents) throw packageError('host-transfer-target-metadata-replay-mismatch');
}

function decodeInstallOwner(serialized: string): InstallOwner {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw packageError('host-transfer-target-install-owner-invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw packageError('host-transfer-target-install-owner-invalid');
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(record).length !== INSTALL_OWNER_KEYS.length
    || Object.keys(record).some(key => !INSTALL_OWNER_KEYS.includes(
      key as typeof INSTALL_OWNER_KEYS[number],
    ))
    || record.owner !== 'claudian-host-transfer-install'
    || record.schemaVersion !== 1
    || typeof record.projectId !== 'string'
    || typeof record.transferId !== 'string'
    || typeof record.manifestDigest !== 'string'
    || !DIGEST_PATTERN.test(record.manifestDigest)
    || typeof record.activatedSnapshotDigest !== 'string'
    || !DIGEST_PATTERN.test(record.activatedSnapshotDigest)
  ) throw packageError('host-transfer-target-install-owner-invalid');
  return record as unknown as InstallOwner;
}

async function readInstallOwner(filePath: string): Promise<InstallOwner | null> {
  const info = await lstat(filePath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw packageError('host-transfer-target-metadata-read-failed');
  });
  if (info === null) return null;
  if (!info.isFile() || info.isSymbolicLink()) {
    throw packageError('host-transfer-target-metadata-boundary-invalid');
  }
  const serialized = await readFile(filePath, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw packageError('host-transfer-target-metadata-read-failed');
  });
  return serialized === null ? null : decodeInstallOwner(serialized);
}

async function replacePrivateFile(filePath: string, contents: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof CollabError) throw error;
    throw packageError('host-transfer-target-metadata-write-failed');
  }
}

export class IncomingHostTransferPackage implements IncomingHostTransferPackagePort {
  private readonly operationQueue = new SerialTaskQueue();
  private readonly snapshots: HostTransferAuthoritySnapshot;

  constructor(private readonly options: IncomingHostTransferPackageOptions) {
    this.snapshots = options.snapshots ?? new HostTransferAuthoritySnapshot();
  }

  stageAndValidate(
    input: Parameters<IncomingHostTransferPackagePort['stageAndValidate']>[0],
  ): Promise<{ readonly manifestDigest: string }> {
    return this.operationQueue.run(() => this.stageUnlocked(input));
  }

  installAndActivate(
    input: Parameters<IncomingHostTransferPackagePort['installAndActivate']>[0],
  ): Promise<{ readonly eventSequence: number }> {
    return this.operationQueue.run(() => this.installUnlocked(input));
  }

  private async stageUnlocked(
    input: Parameters<IncomingHostTransferPackagePort['stageAndValidate']>[0],
  ): Promise<{ readonly manifestDigest: string }> {
    this.assertStageRecordManifest(input.record, input.manifest);
    const directory = await this.requireStaging(input.record);
    const store = new HostTransferArtifactStore(directory);
    const gitBundlePath = await store.receive(
      'git-bundle',
      input.gitBundle,
      input.manifest.gitBundle,
      input.signal,
    );
    const authoritySnapshotPath = await store.receive(
      'authority-snapshot',
      input.authoritySnapshot,
      input.manifest.authoritySnapshot,
      input.signal,
    );
    const pinnedSourceCaCertificatePem = await this.options.readPinnedSourceCa(
      input.record.projectId,
    );
    const authorityBytes = await readFile(authoritySnapshotPath);
    assertArtifactBytes(authorityBytes, input.manifest.authoritySnapshot);
    const inspected = await this.snapshots.inspectInert({
      bytes: authorityBytes,
      manifest: input.manifest,
      pinnedSourceCaCertificatePem,
      sourceHostMemberId: input.record.sourceHostMemberId,
    });
    const workingRepository = await this.options.resolveWorkingRepository(input.record.projectId);
    await this.options.runner.run({
      args: ['bundle', 'verify', gitBundlePath],
      cwd: workingRepository,
      maxStdoutBytes: 4 * 1024 * 1024,
      signal: input.signal,
      suppressHooks: true,
    });
    await this.assertBundleRefs(
      gitBundlePath,
      workingRepository,
      inspected.expectedRefs,
      input.manifest,
      input.signal,
    );
    const [finalBundleIdentity, finalSnapshotIdentity] = await Promise.all([
      inspectHostTransferArtifact(
        gitBundlePath,
        HOST_TRANSFER_MAX_GIT_BUNDLE_BYTES,
        input.signal,
      ),
      inspectHostTransferArtifact(
        authoritySnapshotPath,
        HOST_TRANSFER_MAX_AUTHORITY_SNAPSHOT_BYTES,
        input.signal,
      ),
    ]);
    if (
      finalBundleIdentity.byteCount !== input.manifest.gitBundle.byteCount
      || finalBundleIdentity.sha256 !== input.manifest.gitBundle.sha256
      || finalSnapshotIdentity.byteCount !== input.manifest.authoritySnapshot.byteCount
      || finalSnapshotIdentity.sha256 !== input.manifest.authoritySnapshot.sha256
    ) throw packageError('host-transfer-target-artifact-drift');
    if (input.manifest.authoritySchemaVersion !== COLLAB_AUTHORITY_SCHEMA_VERSION) {
      await this.snapshots.validateRecoveryMigration({
        bytes: authorityBytes,
        manifest: input.manifest,
        pinnedSourceCaCertificatePem,
        sourceHostMemberId: input.record.sourceHostMemberId,
      });
    }
    await writeOrValidate(
      path.join(directory, HOST_TRANSFER_MANIFEST_FILE),
      serializeHostTransferPackageManifest(input.manifest),
    );
    return Object.freeze({
      manifestDigest: digestHostTransferPackageManifest(input.manifest),
    });
  }

  private async installUnlocked(
    input: Parameters<IncomingHostTransferPackagePort['installAndActivate']>[0],
  ): Promise<{ readonly eventSequence: number }> {
    const directory = await this.requireStaging(input.record);
    const manifest = await this.loadManifest(directory);
    this.assertInstallRecordManifest(input.record, manifest, input.manifestDigest);
    if (
      !DIGEST_PATTERN.test(input.manifestDigest)
      || digestHostTransferPackageManifest(manifest) !== input.manifestDigest
    ) throw packageError('host-transfer-target-manifest-digest-mismatch');
    const bundlePath = path.join(directory, 'authority.bundle');
    const snapshotPath = path.join(directory, 'authority.db');
    const [bundleIdentity, snapshotIdentity, pinnedSourceCaCertificatePem] = await Promise.all([
      inspectHostTransferArtifact(
        bundlePath,
        HOST_TRANSFER_MAX_GIT_BUNDLE_BYTES,
        input.signal,
      ),
      inspectHostTransferArtifact(
        snapshotPath,
        HOST_TRANSFER_MAX_AUTHORITY_SNAPSHOT_BYTES,
        input.signal,
      ),
      this.options.readPinnedSourceCa(input.record.projectId),
    ]);
    if (
      bundleIdentity.sha256 !== manifest.gitBundle.sha256
      || bundleIdentity.byteCount !== manifest.gitBundle.byteCount
      || snapshotIdentity.sha256 !== manifest.authoritySnapshot.sha256
      || snapshotIdentity.byteCount !== manifest.authoritySnapshot.byteCount
    ) throw packageError('host-transfer-target-artifact-drift');
    const snapshotBytes = await readFile(snapshotPath);
    assertArtifactBytes(snapshotBytes, manifest.authoritySnapshot);
    const inspected = await this.snapshots.inspectInert({
      bytes: snapshotBytes,
      manifest,
      pinnedSourceCaCertificatePem,
      sourceHostMemberId: input.record.sourceHostMemberId,
    });
    const workingRepository = await this.options.resolveWorkingRepository(input.record.projectId);
    await this.options.runner.run({
      args: ['bundle', 'verify', bundlePath],
      cwd: workingRepository,
      maxStdoutBytes: 4 * 1024 * 1024,
      signal: input.signal,
      suppressHooks: true,
    });
    await this.assertBundleRefs(
      bundlePath,
      workingRepository,
      inspected.expectedRefs,
      manifest,
      input.signal,
    );
    const [finalBundleIdentity, finalSnapshotIdentity] = await Promise.all([
      inspectHostTransferArtifact(
        bundlePath,
        HOST_TRANSFER_MAX_GIT_BUNDLE_BYTES,
        input.signal,
      ),
      inspectHostTransferArtifact(
        snapshotPath,
        HOST_TRANSFER_MAX_AUTHORITY_SNAPSHOT_BYTES,
        input.signal,
      ),
    ]);
    if (
      finalBundleIdentity.byteCount !== manifest.gitBundle.byteCount
      || finalBundleIdentity.sha256 !== manifest.gitBundle.sha256
      || finalSnapshotIdentity.byteCount !== manifest.authoritySnapshot.byteCount
      || finalSnapshotIdentity.sha256 !== manifest.authoritySnapshot.sha256
    ) throw packageError('host-transfer-target-artifact-drift');
    if (manifest.authoritySchemaVersion !== COLLAB_AUTHORITY_SCHEMA_VERSION) {
      await this.snapshots.validateRecoveryMigration({
        bytes: snapshotBytes,
        manifest,
        pinnedSourceCaCertificatePem,
        sourceHostMemberId: input.record.sourceHostMemberId,
      });
    }
    const activated = await this.snapshots.activate({
      activationCertificate: input.activationCertificate,
      bytes: snapshotBytes,
      manifest,
      pinnedSourceCaCertificatePem,
      sourceHostMemberId: input.record.sourceHostMemberId,
    });
    const authorityDirectory = await this.options.ensureAuthorityDirectory(input.record.projectId);
    await this.requireDirectory(authorityDirectory, 'host-transfer-target-authority-directory-invalid');
    const owner: InstallOwner = Object.freeze({
      activatedSnapshotDigest: sha256(activated.bytes),
      manifestDigest: input.manifestDigest,
      owner: 'claudian-host-transfer-install',
      projectId: input.record.projectId,
      schemaVersion: 1,
      transferId: input.record.transferId,
    });
    await this.installDatabase(authorityDirectory, activated, owner);
    await this.installRepository({
      authorityDirectory,
      bundlePath,
      expectedRefs: inspected.expectedRefs,
      manifest,
      signal: input.signal,
      transferId: input.record.transferId,
    });
    await writeOrValidate(
      path.join(authorityDirectory, INSTALL_COMPLETE_FILE),
      JSON.stringify(owner),
    );
    return Object.freeze({ eventSequence: activated.eventSequence });
  }

  private async installDatabase(
    authorityDirectory: string,
    activated: {
      readonly bytes: Uint8Array;
      readonly legacyActivatedBytes?: Uint8Array;
    },
    owner: InstallOwner,
  ): Promise<void> {
    const store = new NodeSqlJsSnapshotStore(authorityDirectory);
    const ownerPath = path.join(authorityDirectory, INSTALL_OWNER_FILE);
    const completePath = path.join(authorityDirectory, INSTALL_COMPLETE_FILE);
    const [persistedOwner, persistedComplete, existing] = await Promise.all([
      readInstallOwner(ownerPath),
      readInstallOwner(completePath),
      store.readCandidate('primary'),
    ]);
    const legacyDigest = activated.legacyActivatedBytes
      ? sha256(activated.legacyActivatedBytes)
      : null;
    for (const persisted of [persistedOwner, persistedComplete]) {
      if (!persisted) continue;
      if (
        persisted.projectId !== owner.projectId
        || persisted.transferId !== owner.transferId
        || persisted.manifestDigest !== owner.manifestDigest
        || (
          persisted.activatedSnapshotDigest !== owner.activatedSnapshotDigest
          && persisted.activatedSnapshotDigest !== legacyDigest
        )
      ) throw packageError('host-transfer-target-authority-collision');
    }
    const existingDigest = existing ? sha256(existing) : null;
    if (
      existingDigest !== null
      && existingDigest !== owner.activatedSnapshotDigest
      && existingDigest !== legacyDigest
    ) throw packageError('host-transfer-target-authority-collision');
    if (
      persistedOwner === null
      && (persistedComplete !== null || existingDigest !== null)
    ) {
      throw packageError('host-transfer-target-authority-collision');
    }
    if (persistedComplete !== null && existingDigest === null) {
      throw packageError('host-transfer-target-authority-collision');
    }
    let ownerIsCurrent = persistedOwner?.activatedSnapshotDigest
      === owner.activatedSnapshotDigest;
    if (persistedOwner === null) {
      await writeOrValidate(ownerPath, JSON.stringify(owner));
      ownerIsCurrent = true;
    }
    if (existingDigest !== owner.activatedSnapshotDigest) {
      await store.writeTemporary(activated.bytes);
      await store.removePrimary();
      await store.promoteTemporary();
      await store.syncDirectory();
    }
    if (!ownerIsCurrent) {
      await replacePrivateFile(ownerPath, JSON.stringify(owner));
    }
    if (
      persistedComplete
      && persistedComplete.activatedSnapshotDigest !== owner.activatedSnapshotDigest
    ) {
      await replacePrivateFile(completePath, JSON.stringify(owner));
    }
    await store.syncDirectory();
  }

  private async installRepository(input: {
    readonly authorityDirectory: string;
    readonly bundlePath: string;
    readonly expectedRefs: readonly string[];
    readonly manifest: HostTransferPackageManifest;
    readonly signal?: AbortSignal;
    readonly transferId: string;
  }): Promise<void> {
    const repositoryPath = path.join(input.authorityDirectory, 'repository.git');
    const existing = await lstat(repositoryPath).catch(() => null);
    if (!existing) {
      const temporaryPath = path.join(
        input.authorityDirectory,
        `.repository-${input.transferId}.tmp`,
      );
      await rm(temporaryPath, { force: true, recursive: true });
      await this.options.runner.run({
        args: ['clone', '--bare', '--no-local', input.bundlePath, temporaryPath],
        cwd: input.authorityDirectory,
        maxStdoutBytes: 1024 * 1024,
        signal: input.signal,
        suppressHooks: true,
      });
      await rename(temporaryPath, repositoryPath).catch(async error => {
        await rm(temporaryPath, { force: true, recursive: true }).catch(() => undefined);
        if (!await lstat(repositoryPath).catch(() => null)) throw error;
      });
    } else if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw packageError('host-transfer-target-repository-collision');
    }
    await this.options.repositories.configureHostedRepository(repositoryPath);
    await this.options.repositories.assertHealthy(repositoryPath);
    await this.assertInstalledRefs(repositoryPath, input.expectedRefs, input.manifest, input.signal);
  }

  private async assertBundleRefs(
    bundlePath: string,
    cwd: string,
    expectedRefs: readonly string[],
    manifest: HostTransferPackageManifest,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.options.runner.run({
      args: ['bundle', 'list-heads', bundlePath],
      cwd,
      maxStdoutBytes: 4 * 1024 * 1024,
      signal,
      suppressHooks: true,
    });
    const refs = this.parseRefLines(result.stdout.toString('utf8'), true);
    this.assertExactRefs(refs, expectedRefs, manifest);
  }

  private async assertInstalledRefs(
    repositoryPath: string,
    expectedRefs: readonly string[],
    manifest: HostTransferPackageManifest,
    signal?: AbortSignal,
  ): Promise<void> {
    const [formatResult, refsResult, mainOid] = await Promise.all([
      this.options.runner.run({
        args: ['rev-parse', '--show-object-format'], cwd: repositoryPath,
        maxStdoutBytes: 128, signal, suppressHooks: true,
      }),
      this.options.runner.run({
        args: ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads'],
        cwd: repositoryPath, maxStdoutBytes: 4 * 1024 * 1024,
        signal, suppressHooks: true,
      }),
      this.options.repositories.resolveRef(repositoryPath, COLLAB_MAIN_REF),
    ]);
    if (
      formatResult.stdout.toString('utf8').trim() !== manifest.gitObjectFormat
      || mainOid !== manifest.authorityMainOid
    ) throw packageError('host-transfer-target-git-identity-mismatch');
    this.assertExactRefs(
      this.parseRefLines(refsResult.stdout.toString('utf8'), false),
      expectedRefs,
      manifest,
    );
  }

  private parseRefLines(output: string, allowHead: boolean): ReadonlyMap<string, string> {
    const refs = new Map<string, string>();
    for (const line of output.trim().split(/\r?\n/).filter(Boolean)) {
      const match = /^(\S+) (HEAD|refs\/heads\/[A-Za-z0-9._/-]+)$/.exec(line);
      if (!match || !isCollabGitOid(match[1]) || (!allowHead && match[2] === 'HEAD')) {
        throw packageError('host-transfer-target-git-ref-output-invalid');
      }
      if (match[2] !== 'HEAD') refs.set(match[2], match[1]);
    }
    return refs;
  }

  private assertExactRefs(
    refs: ReadonlyMap<string, string>,
    expectedRefs: readonly string[],
    manifest: HostTransferPackageManifest,
  ): void {
    if (
      refs.size !== expectedRefs.length
      || expectedRefs.some(ref => !refs.has(ref))
      || refs.get(COLLAB_MAIN_REF) !== manifest.authorityMainOid
    ) throw packageError('host-transfer-target-git-refs-mismatch');
    const expectedOidLength = manifest.gitObjectFormat === 'sha1' ? 40 : 64;
    if ([...refs.values()].some(oid => oid.length !== expectedOidLength)) {
      throw packageError('host-transfer-target-git-object-format-mismatch');
    }
  }

  private async requireStaging(record: HostTransferRecoveryRecord): Promise<string> {
    const expectedName = `.claudian-host-transfer-${record.transferId}`;
    if (record.stagingDirectoryName !== expectedName) {
      throw packageError('host-transfer-target-staging-name-invalid');
    }
    const reserved = await this.options.workspace.reserveProjectsFolderChild(
      this.options.projectsFolder,
      {
        childName: expectedName,
        operationId: record.transferId,
        projectId: record.projectId,
        purpose: 'host-transfer-staging',
      },
    );
    await this.requireDirectory(reserved.absolutePath, 'host-transfer-target-staging-invalid');
    return reserved.absolutePath;
  }

  private async requireDirectory(directory: string, reason: string): Promise<void> {
    const info = await lstat(directory).catch(() => null);
    if (!path.isAbsolute(directory) || !info?.isDirectory() || info.isSymbolicLink()) {
      throw packageError(reason);
    }
  }

  private async loadManifest(directory: string): Promise<HostTransferPackageManifest> {
    try {
      return parseHostTransferRecoveryPackageManifest(await readFile(
        path.join(directory, HOST_TRANSFER_MANIFEST_FILE),
        'utf8',
      ));
    } catch (error) {
      if (error instanceof CollabError) throw error;
      throw packageError('host-transfer-target-manifest-missing');
    }
  }

  private assertRecordManifestIdentity(
    record: HostTransferRecoveryRecord,
    manifest: HostTransferPackageManifest,
  ): void {
    if (
      record.projectId !== manifest.projectId
      || record.transferId !== manifest.transferId
      || record.targetHostMemberId !== manifest.targetHostMemberId
      || record.targetCaFingerprint !== manifest.targetCaFingerprint
    ) throw packageError('host-transfer-target-manifest-binding-invalid');
  }

  private assertStageRecordManifest(
    record: HostTransferRecoveryRecord,
    manifest: HostTransferPackageManifest,
  ): void {
    this.assertRecordManifestIdentity(record, manifest);
    if (
      record.direction !== 'incoming'
      || (record.phase !== 'accepted' && record.phase !== 'quiescing')
      || record.manifestDigest !== null
      || record.receiverCredential === null
      || record.receiverCredentialHash !== null
      || !validReceiverCredential(record.receiverCredential)
    ) throw packageError('host-transfer-target-recovery-record-invalid');
  }

  private assertInstallRecordManifest(
    record: HostTransferRecoveryRecord,
    manifest: HostTransferPackageManifest,
    manifestDigest: string,
  ): void {
    this.assertRecordManifestIdentity(record, manifest);
    if (
      record.direction !== 'incoming'
      || ![
        'staged',
        'authority-relinquished',
        'target-active',
        'completed',
      ].includes(record.phase)
      || record.manifestDigest !== manifestDigest
      || digestHostTransferPackageManifest(manifest) !== manifestDigest
      || record.receiverCredential === null
      || record.receiverCredentialHash !== null
      || !validReceiverCredential(record.receiverCredential)
    ) throw packageError('host-transfer-target-recovery-record-invalid');
  }
}
