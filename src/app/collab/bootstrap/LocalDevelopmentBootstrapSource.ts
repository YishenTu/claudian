import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, open, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import {
  COLLAB_CLOUD_BINDING_LIMITS,
  COLLAB_MAIN_REF,
  COLLAB_PROTOCOL_VERSION,
  decodeDevelopmentBootstrapManifest,
  DEVELOPMENT_BOOTSTRAP_MANIFEST_SCHEMA_VERSION,
  type DevelopmentBootstrapManifest,
  type DevelopmentBootstrapSourceEligibility,
  isCollabOpaqueId,
  isCollabProjectId,
} from '@claudian/collab-protocol';

import type {
  AuthorityDatabaseConnection,
  AuthoritySqlRow,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import type { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import {
  createCollabFileExclusively,
  ensureCollabVaultDirectory,
  resolveCollabVaultPath,
  writeCollabFileAtomically,
} from '@/app/collab/CollabFilesystemBoundary';
import { isCollabLocalLanMembership } from '@/app/collab/CollabLocalProjectRepository';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const ARTIFACT_DIRECTORY = '.claudian/collab/cloud-bootstrap-artifacts';
const BUNDLE_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_ARTIFACT_INTENT_BYTES = 128 * 1024;

interface BootstrapArtifactIntent {
  readonly attemptId: string;
  readonly manifest: DevelopmentBootstrapManifest | null;
  readonly projectId: string;
  readonly schemaVersion: 1;
}

export interface LocalDevelopmentBootstrapSourceOptions {
  readonly createAttemptId?: () => string;
  readonly foundation: Pick<
    ClaudianCollabService,
    'local' | 'openAuthority' | 'requireGitFoundation'
  >;
  readonly now?: () => Date;
  readonly vaultRoot: string;
}

function sourceError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function sourceOperationError(reason: string): CollabError {
  return new CollabError({
    code: 'operation-failed',
    recoveryActions: ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new CollabError({
    code: 'cancelled',
    recoveryActions: ['retry'],
    safeContext: { reason: 'cloud-bootstrap-source-cancelled' },
  });
}

function newAttemptId(): string {
  return `bootstrap-${randomUUID().replaceAll('-', '')}`;
}

function count(
  connection: AuthorityDatabaseConnection,
  sql: string,
  params?: string[],
): number {
  const value = connection.get(sql, params)?.count;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw sourceError('cloud-bootstrap-authority-count-invalid');
  }
  return value as number;
}

function text(row: AuthoritySqlRow, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw sourceError('cloud-bootstrap-authority-row-invalid');
  return value;
}

function normalizeFingerprint(value: string): string {
  const normalized = value.replaceAll(':', '').toLocaleLowerCase('en-US');
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    throw sourceError('cloud-bootstrap-source-ca-fingerprint-invalid');
  }
  return normalized;
}

function artifactRelativePath(attemptId: string): string {
  return `${ARTIFACT_DIRECTORY}/${attemptId}.bundle`;
}

function intentRelativePath(projectId: string): string {
  if (!isCollabProjectId(projectId)) {
    throw sourceError('cloud-bootstrap-source-project-id-invalid');
  }
  return `${ARTIFACT_DIRECTORY}/${projectId}.json`;
}

function serializeIntent(intent: BootstrapArtifactIntent): string {
  const contents = `${JSON.stringify(intent, null, 2)}\n`;
  if (Buffer.byteLength(contents, 'utf8') > MAX_ARTIFACT_INTENT_BYTES) {
    throw sourceError('cloud-bootstrap-source-artifact-intent-too-large');
  }
  return contents;
}

function decodeIntent(value: unknown): BootstrapArtifactIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw sourceError('cloud-bootstrap-source-artifact-intent-corrupt');
  }
  const source = value as Readonly<Record<string, unknown>>;
  if (
    Object.keys(source).length !== 4
    || !['attemptId', 'manifest', 'projectId', 'schemaVersion']
      .every(key => Object.hasOwn(source, key))
    || source.schemaVersion !== 1
    || typeof source.projectId !== 'string'
    || !isCollabProjectId(source.projectId)
    || typeof source.attemptId !== 'string'
    || !isCollabOpaqueId(source.attemptId)
  ) {
    throw sourceError('cloud-bootstrap-source-artifact-intent-corrupt');
  }
  const manifest = source.manifest === null
    ? null
    : decodeDevelopmentBootstrapManifest(source.manifest);
  if (
    manifest !== null
    && (
      manifest.attemptId !== source.attemptId
      || manifest.comparison.projectId !== source.projectId
    )
  ) {
    throw sourceError('cloud-bootstrap-source-artifact-intent-corrupt');
  }
  return Object.freeze({
    attemptId: source.attemptId,
    manifest,
    projectId: source.projectId,
    schemaVersion: 1,
  });
}

export class LocalDevelopmentBootstrapSource {
  readonly #createAttemptId: () => string;
  readonly #foundation: LocalDevelopmentBootstrapSourceOptions['foundation'];
  readonly #now: () => Date;
  readonly #queue = new SerialTaskQueue();
  readonly #vaultRoot: string;

  constructor(options: LocalDevelopmentBootstrapSourceOptions) {
    this.#createAttemptId = options.createAttemptId ?? newAttemptId;
    this.#foundation = options.foundation;
    this.#now = options.now ?? (() => new Date());
    this.#vaultRoot = options.vaultRoot;
  }

  async captureManifest(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<DevelopmentBootstrapManifest> {
    return this.#queue.run(() => this.#captureManifest(projectId, signal));
  }

  async #captureManifest(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<DevelopmentBootstrapManifest> {
    throwIfCancelled(signal);
    await ensureCollabVaultDirectory(this.#vaultRoot, ARTIFACT_DIRECTORY, {
      mode: 0o700,
      preserveExistingMode: true,
    });
    throwIfCancelled(signal);
    const existing = await this.#loadIntent(projectId);
    if (existing?.manifest) {
      const bundle = await this.#inspectBundle(await resolveCollabVaultPath(
        this.#vaultRoot,
        artifactRelativePath(existing.attemptId),
        { mustExist: true },
      ), signal);
      if (
        bundle.byteCount !== existing.manifest.git.bundle.byteCount
        || bundle.sha256 !== existing.manifest.git.bundle.sha256
      ) {
        throw sourceError('cloud-bootstrap-source-bundle-changed');
      }
      await this.assertManifestCurrent(existing.manifest, signal);
      return existing.manifest;
    }
    if (existing) await this.#discardIntent(existing);

    const createdAt = this.#now().toISOString();
    const attemptId = this.#createAttemptId();
    if (!isCollabOpaqueId(attemptId)) {
      throw sourceError('cloud-bootstrap-source-attempt-id-invalid');
    }
    const intent: BootstrapArtifactIntent = Object.freeze({
      attemptId,
      manifest: null,
      projectId,
      schemaVersion: 1,
    });
    const bundlePath = await resolveCollabVaultPath(
      this.#vaultRoot,
      artifactRelativePath(attemptId),
    );
    if (await lstat(bundlePath).catch(() => null)) {
      throw sourceError('cloud-bootstrap-source-artifact-conflict');
    }
    const created = await createCollabFileExclusively(
      this.#vaultRoot,
      intentRelativePath(projectId),
      serializeIntent(intent),
      { mode: 0o600 },
    );
    if (!created) throw sourceError('cloud-bootstrap-source-artifact-conflict');
    try {
      const observation = await this.#observeSource(projectId, createdAt, signal);
      throwIfCancelled(signal);
      await observation.runner.run({
        args: ['bundle', 'create', bundlePath, ...observation.expectedRefNames],
        cwd: observation.repositoryPath,
        maxStdoutBytes: 1_024,
        signal,
        timeoutMs: BUNDLE_TIMEOUT_MS,
      });
      throwIfCancelled(signal);
      await chmod(bundlePath, 0o600);
      throwIfCancelled(signal);
      const bundle = await this.#inspectBundle(bundlePath, signal);
      if (
        bundle.byteCount < 1
        || bundle.byteCount > COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapGitBundleBytes
      ) {
        throw sourceError('cloud-bootstrap-source-bundle-too-large');
      }
      const manifest = decodeDevelopmentBootstrapManifest({
        attemptId,
        comparison: observation.comparison,
        createdAt,
        git: {
          bundle,
          objectFormat: observation.objectFormat,
          refs: observation.refs,
        },
        manifestSchemaVersion: DEVELOPMENT_BOOTSTRAP_MANIFEST_SCHEMA_VERSION,
        protocolVersion: COLLAB_PROTOCOL_VERSION,
        sourceEligibility: observation.sourceEligibility,
      });
      await writeCollabFileAtomically(
        this.#vaultRoot,
        intentRelativePath(projectId),
        serializeIntent(Object.freeze({ ...intent, manifest })),
        { mode: 0o600 },
      );
      return manifest;
    } catch (error: unknown) {
      await this.#discardIntent(intent);
      throwIfCancelled(signal);
      throw error;
    }
  }

  async assertManifestCurrent(
    manifest: DevelopmentBootstrapManifest,
    signal?: AbortSignal,
  ): Promise<void> {
    const decoded = decodeDevelopmentBootstrapManifest(manifest);
    const observation = await this.#observeSource(
      decoded.comparison.projectId,
      decoded.createdAt,
      signal,
    );
    throwIfCancelled(signal);
    if (
      JSON.stringify(observation.comparison) !== JSON.stringify(decoded.comparison)
      || observation.objectFormat !== decoded.git.objectFormat
      || JSON.stringify(observation.refs) !== JSON.stringify(decoded.git.refs)
      || JSON.stringify(observation.sourceEligibility)
        !== JSON.stringify(decoded.sourceEligibility)
    ) {
      throw sourceError('cloud-bootstrap-source-manifest-authority-changed');
    }
  }

  async discardBundle(manifest: DevelopmentBootstrapManifest): Promise<void> {
    const decoded = decodeDevelopmentBootstrapManifest(manifest);
    await this.#queue.run(async () => {
      const intent = await this.#loadIntent(decoded.comparison.projectId);
      if (!intent) {
        const path = await resolveCollabVaultPath(
          this.#vaultRoot,
          artifactRelativePath(decoded.attemptId),
        );
        if (await lstat(path).catch(() => null)) {
          throw sourceError('cloud-bootstrap-source-artifact-intent-missing');
        }
        return;
      }
      if (
        intent.attemptId !== decoded.attemptId
        || intent.projectId !== decoded.comparison.projectId
        || (intent.manifest !== null
          && JSON.stringify(intent.manifest) !== JSON.stringify(decoded))
      ) {
        throw sourceError('cloud-bootstrap-source-artifact-conflict');
      }
      await this.#discardIntent(intent);
    });
  }

  recoverArtifacts(
    isOwned: (manifest: DevelopmentBootstrapManifest) => Promise<boolean>,
  ): Promise<void> {
    return this.#queue.run(async () => {
      const directory = await resolveCollabVaultPath(this.#vaultRoot, ARTIFACT_DIRECTORY);
      const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw sourceOperationError('cloud-bootstrap-source-artifact-list-failed');
      });
      for (const entry of entries.sort((left, right) => (
        left.name.localeCompare(right.name, 'en-US')
      ))) {
        if (/^\..+\.tmp$/u.test(entry.name) || entry.name.endsWith('.bundle')) continue;
        const match = /^(.+)\.json$/u.exec(entry.name);
        if (!match || !entry.isFile() || entry.isSymbolicLink() || !isCollabProjectId(match[1])) {
          throw sourceError('cloud-bootstrap-source-artifact-directory-invalid');
        }
        const intent = await this.#loadIntent(match[1]);
        if (!intent) continue;
        if (intent.manifest && await isOwned(intent.manifest)) continue;
        await this.#discardIntent(intent);
      }
    });
  }

  async #loadIntent(projectId: string): Promise<BootstrapArtifactIntent | null> {
    const relativePath = intentRelativePath(projectId);
    const path = await resolveCollabVaultPath(this.#vaultRoot, relativePath);
    const contents = await readFile(path, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw sourceOperationError('cloud-bootstrap-source-artifact-intent-read-failed');
    });
    if (contents === null) return null;
    if (Buffer.byteLength(contents, 'utf8') > MAX_ARTIFACT_INTENT_BYTES) {
      throw sourceError('cloud-bootstrap-source-artifact-intent-too-large');
    }
    try {
      const intent = decodeIntent(JSON.parse(contents));
      if (intent.projectId !== projectId) throw new TypeError();
      return intent;
    } catch (error) {
      if (error instanceof CollabError) throw error;
      throw sourceError('cloud-bootstrap-source-artifact-intent-corrupt');
    }
  }

  async #discardIntent(intent: BootstrapArtifactIntent): Promise<void> {
    const bundlePath = await resolveCollabVaultPath(
      this.#vaultRoot,
      artifactRelativePath(intent.attemptId),
    );
    const entry = await lstat(bundlePath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw sourceOperationError('cloud-bootstrap-source-artifact-inspection-failed');
    });
    if (entry !== null) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw sourceError('cloud-bootstrap-source-artifact-conflict');
      }
      await rm(bundlePath).catch(() => {
        throw sourceOperationError('cloud-bootstrap-source-artifact-cleanup-failed');
      });
    }
    const markerPath = await resolveCollabVaultPath(
      this.#vaultRoot,
      intentRelativePath(intent.projectId),
    );
    await rm(markerPath).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw sourceOperationError('cloud-bootstrap-source-artifact-cleanup-failed');
    });
  }

  async #observeSource(
    projectId: string,
    eligibilityAt: string,
    signal?: AbortSignal,
  ) {
    throwIfCancelled(signal);
    const membership = await this.#foundation.local.projects.loadMembership(projectId);
    throwIfCancelled(signal);
    if (
      !membership
      || !isCollabLocalLanMembership(membership)
      || membership.project.id !== projectId
      || membership.lifecycle !== 'active'
      || !membership.hostOwnership.ownsAuthority
      || !membership.authority.endpoint
      || !membership.authority.gitRemoteUrl
      || !membership.authority.hostCaFingerprint
    ) {
      throw sourceError('cloud-bootstrap-source-membership-ineligible');
    }
    const authority = await this.#foundation.openAuthority(projectId);
    throwIfCancelled(signal);
    const source = await authority.database.read(connection => {
      const project = authority.projects.get(connection);
      if (
        !project
        || project.projectId !== projectId
        || project.state !== 'active'
        || project.hostMemberId !== membership.member.id
        || project.mainRef !== COLLAB_MAIN_REF
      ) {
        throw sourceError('cloud-bootstrap-source-project-ineligible');
      }
      const memberRows = connection.all(`
        SELECT member_id, display_name, personal_ref, role, status,
               created_at, activated_at
        FROM members
        ORDER BY CASE role WHEN 'manager' THEN 0 ELSE 1 END, created_at, member_id
      `);
      const members = memberRows.map(row => {
        const status = text(row, 'status');
        const activatedAt = text(row, 'activated_at');
        if (status !== 'active') {
          throw sourceError('cloud-bootstrap-source-membership-history-ineligible');
        }
        return {
          activatedAt,
          createdAt: text(row, 'created_at'),
          displayName: text(row, 'display_name'),
          memberId: text(row, 'member_id'),
          personalRef: text(row, 'personal_ref'),
          role: text(row, 'role'),
          status: 'active' as const,
        };
      }).sort((left, right) => left.memberId.localeCompare(right.memberId, 'en-US'));
      if (members.length !== 2) {
        throw sourceError('cloud-bootstrap-source-member-count-ineligible');
      }
      const eligibility: DevelopmentBootstrapSourceEligibility = {
        liveInvitations: count(connection, `
          SELECT COUNT(*) AS count FROM invitations
          WHERE revoked_at IS NULL AND expires_at > ?
        `, [eligibilityAt]) as 0,
        nonActiveMemberships: count(connection, `
          SELECT COUNT(*) AS count FROM members WHERE status != 'active'
        `) as 0,
        nonterminalAcceptOperations: count(connection, `
          SELECT COUNT(*) AS count FROM accept_operations WHERE state != 'completed'
        `) as 0,
        nonterminalHostTransfers: count(connection, `
          SELECT COUNT(*) AS count FROM host_transfer_operations
          WHERE phase IN (
            'offered', 'accepted', 'quiescing', 'staged',
            'authority-relinquished', 'target-active'
          )
        `) as 0,
        nonterminalManagerOffers: count(connection, `
          SELECT COUNT(*) AS count FROM manager_responsibility_offers
          WHERE status IN ('offered', 'acknowledged')
        `) as 0,
        requestComments: count(connection, 'SELECT COUNT(*) AS count FROM comments') as 0,
        requests: count(connection, 'SELECT COUNT(*) AS count FROM change_requests') as 0,
        terminalProjectTransitions: count(
          connection,
          'SELECT COUNT(*) AS count FROM project_terminal_transitions',
        ) as 0,
        ticketComments: count(connection, 'SELECT COUNT(*) AS count FROM ticket_comments') as 0,
        ticketMentions: count(connection, 'SELECT COUNT(*) AS count FROM ticket_mentions') as 0,
        ticketRelations: count(
          connection,
          'SELECT COUNT(*) AS count FROM request_ticket_relations',
        ) as 0,
        tickets: count(connection, 'SELECT COUNT(*) AS count FROM tickets') as 0,
      };
      if (Object.values(eligibility).some(value => value !== 0)) {
        throw sourceError('cloud-bootstrap-source-history-ineligible');
      }
      const sourceEventSequence = count(
        connection,
        'SELECT COALESCE(MAX(sequence), 0) AS count FROM events',
      );
      return { eligibility, members, project, sourceEventSequence };
    });
    throwIfCancelled(signal);

    const git = await this.#foundation.requireGitFoundation();
    throwIfCancelled(signal);
    const repositoryPath = path.join(authority.authorityDirectory, 'repository.git');
    const [formatResult, refsResult] = await Promise.all([
      git.runner.run({
        args: ['rev-parse', '--show-object-format'],
        cwd: repositoryPath,
        maxStdoutBytes: 64,
        signal,
      }),
      git.runner.run({
        args: ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads'],
        cwd: repositoryPath,
        maxStdoutBytes: 16 * 1024,
        signal,
      }),
    ]);
    throwIfCancelled(signal);
    const objectFormat = formatResult.stdout.toString('utf8').trim();
    if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
      throw sourceError('cloud-bootstrap-source-object-format-invalid');
    }
    const observedRefs = refsResult.stdout.toString('utf8').trim().split(/\r?\n/u)
      .filter(Boolean)
      .map(line => {
        const separator = line.indexOf(' ');
        if (separator <= 0) throw sourceError('cloud-bootstrap-source-ref-invalid');
        return { name: line.slice(separator + 1), oid: line.slice(0, separator) };
      });
    const expectedRefNames = [
      COLLAB_MAIN_REF,
      ...source.members.map(member => member.personalRef),
    ].sort((left, right) => left.localeCompare(right, 'en-US'));
    if (
      observedRefs.length !== expectedRefNames.length
      || expectedRefNames.some(name => !observedRefs.some(ref => ref.name === name))
    ) {
      throw sourceError('cloud-bootstrap-source-ref-set-ineligible');
    }
    const refs = expectedRefNames.map(name => {
      const ref = observedRefs.find(candidate => candidate.name === name);
      if (!ref) throw sourceError('cloud-bootstrap-source-ref-missing');
      return ref;
    });

    const mainOid = refs.find(ref => ref.name === COLLAB_MAIN_REF)?.oid;
    if (!mainOid) throw sourceError('cloud-bootstrap-source-main-ref-missing');

    return {
      comparison: {
        mainOid,
        mainRef: COLLAB_MAIN_REF,
        managerSetGeneration: source.project.managerSetGeneration,
        members: source.members,
        projectCreatedAt: source.project.createdAt,
        projectId,
        projectName: source.project.name,
        sourceCaFingerprint: normalizeFingerprint(membership.authority.hostCaFingerprint),
        sourceEventSequence: source.sourceEventSequence,
        sourceHostMemberId: source.project.hostMemberId,
      },
      expectedRefNames,
      objectFormat,
      refs,
      repositoryPath,
      runner: git.runner,
      sourceEligibility: source.eligibility,
    };
  }

  async *openBundle(
    manifest: DevelopmentBootstrapManifest,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
    const decoded = decodeDevelopmentBootstrapManifest(manifest);
    const bundlePath = await resolveCollabVaultPath(
      this.#vaultRoot,
      artifactRelativePath(decoded.attemptId),
      { mustExist: true },
    );
    const handle = await open(bundlePath, 'r');
    let byteCount = 0;
    const digest = createHash('sha256');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== decoded.git.bundle.byteCount) {
        throw sourceError('cloud-bootstrap-source-bundle-changed');
      }
      for await (const chunk of handle.createReadStream({
        autoClose: false,
        signal,
      })) {
        const bytes = Buffer.from(chunk);
        byteCount += bytes.byteLength;
        digest.update(bytes);
        yield bytes;
      }
    } finally {
      await handle.close();
    }
    if (
      byteCount !== decoded.git.bundle.byteCount
      || digest.digest('hex') !== decoded.git.bundle.sha256
    ) {
      throw sourceError('cloud-bootstrap-source-bundle-changed');
    }
  }

  async #inspectBundle(bundlePath: string, signal?: AbortSignal): Promise<{
    readonly byteCount: number;
    readonly sha256: string;
  }> {
    const handle = await open(bundlePath, 'r');
    const digest = createHash('sha256');
    let byteCount = 0;
    try {
      for await (const chunk of handle.createReadStream({ autoClose: false, signal })) {
        throwIfCancelled(signal);
        const bytes = Buffer.from(chunk);
        byteCount += bytes.byteLength;
        if (byteCount > COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapGitBundleBytes) {
          throw sourceError('cloud-bootstrap-source-bundle-too-large');
        }
        digest.update(bytes);
      }
    } finally {
      await handle.close();
    }
    throwIfCancelled(signal);
    return { byteCount, sha256: digest.digest('hex') };
  }
}
