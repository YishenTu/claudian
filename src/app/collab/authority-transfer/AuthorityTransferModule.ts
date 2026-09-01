import type {
  AcceptLanToCloudTransferTargetRequest,
  CollabAuthorityTransferStatus,
  CollabProjectId,
  CollabProjectMembershipOperationMap,
  RequestLanToCloudTransferRequest,
} from '@claudian-collab/protocol';
import {
  COLLAB_AUTHORITY_TRANSFER_CANCELLABLE_PHASES,
} from '@claudian-collab/protocol';

import {
  authorityTransferEntryExpiresAt,
} from '@/app/collab/authority-transfer/AuthorityTransferEntryRecord';
import type {
  AuthorityTransferLocalConvergence,
} from '@/app/collab/authority-transfer/AuthorityTransferLocalConvergence';
import {
  authorityTransferChildIdempotencyKey,
} from '@/app/collab/authority-transfer/AuthorityTransferOperationIdentity';
import type {
  AuthorityTransferRecord,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import {
  type AuthorityTransferDirectionRuntime,
  AuthorityTransferRuntimeRegistry,
  type AuthorityTransferRuntimeResolver,
} from '@/app/collab/authority-transfer/AuthorityTransferRuntimeRegistry';
import {
  AuthorityTransferClaimantCoordinator,
  type AuthorityTransferClaimantCoordinatorOptions,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantCoordinator';
import {
  type AuthorityTransferClaimantRecord,
  type ManagerReissuedAuthorityTransferClaimantRecord,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import {
  AuthorityTransferClaimantRecovery,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecovery';
import {
  AuthorityTransferClaimantRuntimeRegistry,
  type AuthorityTransferClaimantRuntimeResolution,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRuntimeRegistry';
import {
  CloudToLanTargetCoordinator,
  type CloudToLanTargetCoordinatorOptions,
} from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLanTargetCoordinator';
import {
  assertCloudToLanTargetHandle,
  type CloudToLanManagerEntryRecord,
  type CloudToLanTargetPreparationDescriptor,
  type CloudToLanTransferHandle,
  cloudToLanTransferHandle,
  createCloudToLanManagerEntry,
  createCloudToLanTargetEntry,
  decodeCloudToLanTargetPreparationDescriptor,
  decodeCloudToLanTransferHandle,
} from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLanTransferEntryRecord';
import { CollabAuthorityTransferOutcomeError } from '@/app/collab/authority-transfer/CollabAuthorityTransferOutcomeError';
import {
  LanToCloudRequesterCoordinator,
} from '@/app/collab/authority-transfer/lan-to-cloud/LanToCloudRequesterCoordinator';
import {
  LanToCloudSourceCoordinator,
  type LanToCloudSourceCoordinatorOptions,
  LanToCloudSourceProposalCoordinator,
} from '@/app/collab/authority-transfer/lan-to-cloud/LanToCloudSourceCoordinator';
import type {
  AuthorityTransferPersistence,
  LanToCloudCancellationIntent,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import {
  AuthorityTransferRecovery,
} from '@/app/collab/authority-transfer/recovery/AuthorityTransferRecovery';
import {
  type CollabLocalMembershipRecord,
  isCollabLocalLanMembership,
} from '@/app/collab/CollabLocalProjectRepository';
import type { LanAuthorityTransferClient } from '@/app/collab/lan/authority-transfer/LanAuthorityTransferClient';
import type {
  LanAuthorityTransferActor,
  LanAuthorityTransferSourceActiveService,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferRouter';
import { PinnedCollabHttpClient } from '@/app/collab/lan/CollabHttpClient';
import type {
  CollabProjectLifecycleSubsystem,
} from '@/app/collab/lifecycle/CollabProjectLifecycleSubsystem';
import type {
  CloudMembershipClaimInvitation,
} from '@/app/collab/project/CloudProjectInvitation';
import { ProjectControlClient } from '@/app/collab/publish/ProjectControlClient';
import type {
  CloudAuthorityConnection,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { CloudAuthorityRejection } from '@/app/collab/remote-authority/CloudAuthorityError';
import type { CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import type { InstallationKey } from '@/core/device/InstallationKey';

export interface AuthorityTransferSourceRouteInput {
  readonly authorityGeneration: number;
  readonly authenticateMemberCredential: (
    credential: string,
  ) => Promise<LanAuthorityTransferActor>;
  readonly hostMemberId: string;
  readonly projectId: CollabProjectId;
}

export interface AuthorityTransferModuleOptions {
  readonly assertLanToCloudSourceOwner: (
    projectId: CollabProjectId,
    expectedAuthorityGeneration: number,
  ) => Promise<void> | void;
  readonly assertRecoveryOwner: (
    ownerInstallationKey: string | undefined,
    projectId: CollabProjectId,
  ) => Promise<void> | void;
  readonly claimantStore: AuthorityTransferClaimantCoordinatorOptions['store'];
  readonly createManagerReissuedClaimConnection?: (
    input: Readonly<{ readonly projectId: CollabProjectId; readonly serverUrl: string }>,
    options: CollabOperationOptions,
  ) => Promise<CloudAuthorityConnection>;
  readonly convergence: AuthorityTransferLocalConvergence;
  readonly createCloudToLanTarget: (
    projectId: CollabProjectId,
    session: Readonly<{ readonly serverUrl: string }>,
  ) => CloudToLanTargetCoordinatorOptions['target'];
  readonly createCloudToLanConnection: (
    projectId: CollabProjectId,
  ) => Promise<CloudToLanEntryConnection>;
  readonly createLanToCloudSource: (
    projectId: CollabProjectId,
    session: CloudAuthorityConnection,
  ) => LanToCloudSourceCoordinatorOptions['source'];
  readonly createLanTargetSnapshotReader?: (
    projectId: CollabProjectId,
    targetHost: BindCloudToLanClaimantInput['targetHost'],
  ) => Pick<ProjectControlClient, 'readSnapshot'>;
  readonly activateLanToCloudSourceRoute?: (
    projectId: CollabProjectId,
    expectedEndpoint?: string,
  ) => Promise<() => Promise<void>>;
  readonly lifecycle: CollabProjectLifecycleSubsystem;
  readonly loadClaimantMembership?: (
    projectId: CollabProjectId,
  ) => Promise<CollabLocalMembershipRecord | null>;
  readonly installationKey: InstallationKey;
  readonly now?: () => Date;
  readonly persistence: AuthorityTransferPersistence;
  readonly recoverCloudSession?: (
    record: AuthorityTransferRecord,
  ) => Promise<CloudAuthorityConnection>;
  readonly recoverClaimant?: (
    record: AuthorityTransferClaimantRecord,
  ) => Promise<RecoveredAuthorityTransferClaimantBinding>;
  readonly terminalResolver?: AuthorityTransferRuntimeResolver;
}

export interface CloudToLanEntryConnection {
  readonly authorityGeneration: number;
  dispose(): void;
  readonly lifecycle: CloudAuthorityConnection['lifecycle'];
  listProjectMembers(
    request: CollabProjectMembershipOperationMap['listProjectMembers']['request'],
    options?: { readonly signal?: AbortSignal },
  ): Promise<CollabProjectMembershipOperationMap['listProjectMembers']['response']>;
  readonly memberId: string;
  readonly personalRef: string;
  readonly projectId: CollabProjectId;
  readSnapshot: CloudAuthorityConnection['readSnapshot'];
  readonly serverUrl: string;
}

export interface BindLanToCloudSourceInput {
  readonly cloudSession: CloudAuthorityConnection;
  readonly expectedSourceEndpoint?: string;
  readonly expectedTargetUrl?: string;
  readonly projectId: CollabProjectId;
}

export interface CreateLanToCloudRequesterInput {
  readonly lanClient: LanAuthorityTransferClient;
  readonly memberCredential: string;
  readonly memberId: LanAuthorityTransferActor['memberId'];
  readonly projectId: CollabProjectId;
}

export interface LanToCloudSourceProposalView {
  readonly proposedByMemberId: LanAuthorityTransferActor['memberId'];
  readonly request: Readonly<RequestLanToCloudTransferRequest>;
  readonly status: CollabAuthorityTransferStatus;
}

export interface BindCloudToLanTargetInput {
  readonly cloudSession: CloudAuthorityConnection;
  readonly expectedTargetUrl?: string;
  readonly projectId: CollabProjectId;
}

export interface PrepareCloudToLanTargetInput {
  readonly operationIntentId: string;
  readonly projectId: CollabProjectId;
}

export interface BeginCloudToLanTransferInput {
  readonly descriptor: CloudToLanTargetPreparationDescriptor;
  readonly operationIntentId: string;
}

export interface AcceptPreparedCloudToLanTransferInput {
  readonly handle: CloudToLanTransferHandle;
}

export interface WithdrawPreparedCloudToLanTargetInput {
  readonly preparationId: string;
  readonly projectId: CollabProjectId;
}

export type BindAuthorityTransferClaimantInput = Omit<
  AuthorityTransferClaimantCoordinatorOptions,
  'store'
> & Readonly<{ readonly projectId: CollabProjectId }>;

export interface BindLanToCloudClaimantInput {
  readonly cloudSession: CloudAuthorityConnection;
  readonly lanClient: LanAuthorityTransferClient;
  readonly memberCredential: string;
  readonly projectId: CollabProjectId;
}

export interface BindCloudToLanClaimantInput {
  readonly cloudSession: CloudAuthorityConnection;
  readonly lanClient: LanAuthorityTransferClient;
  readonly projectId: CollabProjectId;
  readonly targetHost: Readonly<{
    readonly caCertificatePem: string;
    readonly caFingerprint: string;
    readonly endpoint: string;
  }>;
}

export interface BindManagerReissuedClaimantInput {
  readonly cloudSession: CloudAuthorityConnection;
  readonly projectId: CollabProjectId;
}

export type RecoveredAuthorityTransferClaimantBinding =
  | Readonly<{
      readonly cloudSession: CloudAuthorityConnection;
      readonly direction: 'lan-to-cloud';
      readonly lanClient: LanAuthorityTransferClient;
      readonly memberCredential: string;
      readonly mode: 'full';
    }>
  | Readonly<{
      readonly cloudSession: CloudAuthorityConnection;
      readonly direction: 'cloud-to-lan';
      readonly lanClient: LanAuthorityTransferClient;
      readonly mode: 'full';
      readonly targetHost: BindCloudToLanClaimantInput['targetHost'];
    }>
  | Readonly<{
      readonly cloudSession: CloudAuthorityConnection;
      readonly direction: 'lan-to-cloud';
      readonly mode: 'manager-reissued';
    }>
  | Readonly<{
      readonly cloudSession: CloudAuthorityConnection;
      readonly direction: 'lan-to-cloud';
      readonly mode: 'target-only';
    }>
  | Readonly<{
      readonly direction: 'cloud-to-lan';
      readonly mode: 'target-only';
      readonly targetHost: BindCloudToLanClaimantInput['targetHost'];
    }>
  | Readonly<{
      readonly direction: 'cloud-to-lan' | 'lan-to-cloud';
      readonly mode: 'local-only';
    }>;

export interface AuthorityTransferDirectionBinding<Coordinator> {
  readonly coordinator: Coordinator;
  dispose(): Promise<void> | void;
}

export interface CloudToLanAuthorityTransferBinding
  extends AuthorityTransferDirectionBinding<CloudToLanTargetCoordinator> {
  readonly targetUrl: string;
}

interface SourceBinding {
  readonly cleanupRoute: () => Promise<void>;
  readonly coordinator: LanToCloudSourceCoordinator;
  readonly targetUrl: string;
  readonly unregister: () => void;
}

interface TargetBinding {
  readonly coordinator: CloudToLanTargetCoordinator;
  dispose(): Promise<void>;
  readonly unregister: () => void;
}

interface TargetPreparationBinding {
  readonly connection: CloudToLanEntryConnection;
  readonly target: CloudToLanTargetCoordinatorOptions['target'];
}

async function disposeCloudToLanTargetPreparation(
  connection: CloudToLanEntryConnection,
  target: CloudToLanTargetCoordinatorOptions['target'] | null,
): Promise<void> {
  try {
    await target?.dispose?.();
  } finally {
    connection.dispose();
  }
}

function moduleError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function durableOutcome(operationId: string, reason: string): CollabAuthorityTransferOutcomeError {
  return new CollabAuthorityTransferOutcomeError({
    durablePhase: 'committed',
    durableProgress: true,
    error: moduleError(reason),
    operationId,
    status: 'recovery-required',
  });
}

function isDefinitiveCloudToLanBeginRejection(
  error: CloudAuthorityRejection,
  wasPossiblySent: boolean,
): boolean {
  return !wasPossiblySent && (
    error.code === 'authorization-denied' || error.code === 'authority-transfer-stale'
  );
}

function sameCloudToLanTransferHandle(
  left: CloudToLanTransferHandle,
  right: CloudToLanTransferHandle,
): boolean {
  return left.operationIntentId === right.operationIntentId
    && left.preparationId === right.preparationId
    && left.projectId === right.projectId
    && left.schemaVersion === right.schemaVersion
    && left.selectedTargetMemberId === right.selectedTargetMemberId
    && left.sourceAuthorityGeneration === right.sourceAuthorityGeneration
    && left.sourceCloudUrl === right.sourceCloudUrl
    && left.targetUrl === right.targetUrl
    && left.transferId === right.transferId;
}

/**
 * Production construction boundary for Project authority movement. Operation-
 * specific transports and physical effects are bound before invocation or
 * recovery; the durable records remain owned by the existing local repository.
 */
export class AuthorityTransferModule {
  readonly claimants: AuthorityTransferClaimantRuntimeRegistry;
  readonly convergence: AuthorityTransferLocalConvergence;
  readonly runtimes: AuthorityTransferRuntimeRegistry;
  private readonly claimantRecovery: AuthorityTransferClaimantRecovery;
  private readonly recoveredCloudSessions = new Map<CollabProjectId, CloudAuthorityConnection>();
  private readonly sourceProposals: LanToCloudSourceProposalCoordinator;
  private readonly sourceBindings = new Map<CollabProjectId, SourceBinding>();
  private readonly targetBindings = new Map<CollabProjectId, TargetBinding>();
  private readonly targetPreparations = new Map<CollabProjectId, TargetPreparationBinding>();
  private readonly transferRecovery: AuthorityTransferRecovery;
  private readonly now: () => Date;

  constructor(private readonly options: AuthorityTransferModuleOptions) {
    this.now = options.now ?? (() => new Date());
    this.convergence = options.convergence;
    this.runtimes = new AuthorityTransferRuntimeRegistry({
      resolve: record => this.resolveRuntime(record),
    });
    this.claimants = new AuthorityTransferClaimantRuntimeRegistry({
      resolve: record => this.resolveClaimantRuntime(record),
    });
    this.sourceProposals = new LanToCloudSourceProposalCoordinator({
      installationKey: options.installationKey,
      persistence: options.persistence,
    });
    this.transferRecovery = new AuthorityTransferRecovery(
      options.persistence,
      {
        prepare: record => this.runtimes.prepare(record),
        resume: (record, recoveryOptions) => (
          this.resumeAuthorityTransferRecord(record, recoveryOptions)
        ),
        resumeManager: (projectId, recoveryOptions) => (
          this.resumeCloudToLanManagerEntry(projectId, recoveryOptions)
        ),
        resumeTargetPreparation: (entry, recoveryOptions) => (
          this.prepareCloudToLanTargetOwned({
            operationIntentId: entry.operationIntentId,
            projectId: entry.projectId,
          }, recoveryOptions).then(() => undefined)
        ),
      },
      options.assertRecoveryOwner,
    );
    this.claimantRecovery = new AuthorityTransferClaimantRecovery(
      options.claimantStore,
      {
        beforeProject: projectId => this.assertCloudToLanManagerSettled(projectId),
        resume: (record, recoveryOptions) => this.claimants.resume(record, recoveryOptions),
      },
    );
    this.transferRecovery.register(options.lifecycle);
    this.claimantRecovery.register(options.lifecycle);
  }

  async bindLanToCloudSource(
    input: BindLanToCloudSourceInput,
  ): Promise<AuthorityTransferDirectionBinding<LanToCloudSourceCoordinator>> {
    this.assertCloudSession(input.projectId, input.cloudSession);
    const sourceEntry = await this.options.persistence.loadSourceEntry(input.projectId);
    const record = sourceEntry ? null : await this.options.persistence.load(input.projectId);
    const expectedAuthorityGeneration = sourceEntry?.request.expectedAuthorityGeneration
      ?? (record?.localRole === 'source'
        ? record.status.sourceAuthority.generation
        : undefined);
    if (expectedAuthorityGeneration === undefined) {
      throw moduleError('authority-transfer-source-owner-unavailable');
    }
    await this.assertLanToCloudSourceOwner(
      input.projectId,
      expectedAuthorityGeneration,
    );
    const persistedTargetUrl = sourceEntry?.request.targetUrl
      ?? (record?.localRole === 'source' ? record.status.targetUrl : undefined);
    if (
      !persistedTargetUrl
      || (input.expectedTargetUrl !== undefined
        && input.expectedTargetUrl !== persistedTargetUrl)
      || input.cloudSession.serverUrl !== persistedTargetUrl
    ) {
      throw moduleError('authority-transfer-cloud-target-mismatch');
    }
    if (this.sourceBindings.has(input.projectId) || this.targetBindings.has(input.projectId)) {
      throw moduleError('authority-transfer-direction-runtime-conflict');
    }
    const coordinator = new LanToCloudSourceCoordinator({
      cloud: input.cloudSession.lifecycle,
      installationKey: this.options.installationKey,
      persistence: this.options.persistence,
      source: this.options.createLanToCloudSource(input.projectId, input.cloudSession),
    });
    const unregister = this.runtimes.register(input.projectId, 'source', coordinator);
    let cleanupRoute: () => Promise<void> = async () => undefined;
    const binding: SourceBinding = {
      cleanupRoute: () => cleanupRoute(),
      coordinator,
      targetUrl: persistedTargetUrl,
      unregister,
    };
    this.sourceBindings.set(input.projectId, binding);
    try {
      cleanupRoute = await this.options.activateLanToCloudSourceRoute?.(
        input.projectId,
        input.expectedSourceEndpoint,
      ) ?? (async () => undefined);
      return Object.freeze({
        coordinator,
        dispose: async () => {
          if (this.sourceBindings.get(input.projectId) !== binding) return;
          this.sourceBindings.delete(input.projectId);
          unregister();
          await binding.cleanupRoute();
        },
      });
    } catch (error) {
      this.sourceBindings.delete(input.projectId);
      unregister();
      throw error;
    }
  }

  createLanToCloudRequester(
    input: CreateLanToCloudRequesterInput,
  ): LanToCloudRequesterCoordinator {
    return new LanToCloudRequesterCoordinator({
      client: input.lanClient,
      installationKey: this.options.installationKey,
      memberCredential: input.memberCredential,
      memberId: input.memberId,
      persistence: this.options.persistence,
      projectId: input.projectId,
    });
  }

  async readLanToCloudSourceProposal(
    projectId: CollabProjectId,
  ): Promise<LanToCloudSourceProposalView | null> {
    const entry = await this.options.persistence.loadSourceEntry(projectId);
    if (!entry || entry.phase !== 'proposed') return null;
    return Object.freeze({
      proposedByMemberId: entry.proposedByMemberId,
      request: entry.request,
      status: entry.status,
    });
  }

  acceptLanToCloudTransferTarget(
    request: AcceptLanToCloudTransferTargetRequest,
  ): Promise<CollabAuthorityTransferStatus> {
    return this.options.lifecycle.runExclusive(
      request.projectId,
      'authority-transfer',
      'continuation',
      async () => {
        await this.assertLanToCloudSourceOwner(
          request.projectId,
          request.expectedAuthorityGeneration,
        );
        const binding = this.sourceBindings.get(request.projectId);
        if (!binding) throw moduleError('authority-transfer-source-runtime-unavailable');
        if (binding.targetUrl !== request.targetUrl) {
          throw moduleError('authority-transfer-cloud-target-mismatch');
        }
        return binding.coordinator.acceptAndTransfer(request);
      },
    );
  }

  cancelLanToCloudTransfer(
    request: LanToCloudCancellationIntent,
  ): Promise<CollabAuthorityTransferStatus> {
    return this.options.lifecycle.runExclusive(
      request.projectId,
      'authority-transfer',
      'continuation',
      async () => {
        await this.assertLanToCloudSourceOwner(
          request.projectId,
          request.expectedAuthorityGeneration,
        );
        const record = await this.options.persistence.load(request.projectId);
        if (!record) {
          const status = await this.sourceProposals.cancel(request);
          const binding = this.sourceBindings.get(request.projectId);
          if (binding) {
            this.sourceBindings.delete(request.projectId);
            binding.unregister();
            await binding.cleanupRoute();
          }
          return status;
        }
        const binding = this.sourceBindings.get(request.projectId);
        if (binding) return binding.coordinator.cancel(request);
        const prepared = await this.options.persistence.prepareLanToCloudCancellation(request);
        if (prepared.terminalCleanupCompleted) return prepared.status;
        await this.runtimes.resume(prepared, {});
        return (await this.options.persistence.load(request.projectId))?.status ?? prepared.status;
      },
    );
  }

  async bindCloudToLanTarget(
    input: BindCloudToLanTargetInput,
  ): Promise<CloudToLanAuthorityTransferBinding> {
    this.assertCloudSession(input.projectId, input.cloudSession);
    const createTarget = this.options.createCloudToLanTarget;
    if (this.sourceBindings.has(input.projectId) || this.targetBindings.has(input.projectId)) {
      throw moduleError('authority-transfer-direction-runtime-conflict');
    }
    const target = createTarget(input.projectId, input.cloudSession);
    if (!target.prepareTarget) {
      throw moduleError('authority-transfer-target-preparation-unavailable');
    }
    if (!input.expectedTargetUrl) {
      throw moduleError('authority-transfer-target-url-required');
    }
    let prepared: Awaited<ReturnType<NonNullable<typeof target.prepareTarget>>>;
    try {
      prepared = await target.prepareTarget(input.expectedTargetUrl);
    } catch (error) {
      await target.dispose?.();
      throw error;
    }
    if (prepared.targetUrl !== input.expectedTargetUrl) {
      await target.dispose?.();
      throw moduleError('authority-transfer-target-url-mismatch');
    }
    const coordinator = new CloudToLanTargetCoordinator({
      cloud: input.cloudSession.lifecycle,
      installationKey: this.options.installationKey,
      persistence: this.options.persistence,
      target,
    });
    const unregister = this.runtimes.register(input.projectId, 'target', coordinator);
    const binding: TargetBinding = Object.freeze({
      coordinator,
      dispose: async () => {
        unregister();
        await target.dispose?.();
      },
      unregister,
    });
    this.targetBindings.set(input.projectId, binding);
    try {
      return Object.freeze({
        coordinator,
        dispose: async () => {
          if (this.targetBindings.get(input.projectId) !== binding) return;
          this.targetBindings.delete(input.projectId);
          await binding.dispose();
        },
        targetUrl: input.expectedTargetUrl,
      });
    } catch (error) {
      this.targetBindings.delete(input.projectId);
      unregister();
      await target.dispose?.();
      throw error;
    }
  }

  async prepareCloudToLanTarget(
    input: PrepareCloudToLanTargetInput,
    options: CollabOperationOptions = {},
  ): Promise<CloudToLanTargetPreparationDescriptor> {
    return this.options.lifecycle.runExclusive(
      input.projectId,
      'authority-transfer',
      'continuation',
      () => this.prepareCloudToLanTargetOwned(input, options),
    );
  }

  private async prepareCloudToLanTargetOwned(
    input: PrepareCloudToLanTargetInput,
    options: CollabOperationOptions,
  ): Promise<CloudToLanTargetPreparationDescriptor> {
    const createConnection = this.options.createCloudToLanConnection;
    const createTarget = this.options.createCloudToLanTarget;
    let existing = await this.options.persistence.loadCloudToLanTargetEntry(
      input.projectId,
    );
    if (existing?.ownerInstallationKey !== undefined
      && existing.ownerInstallationKey !== this.options.installationKey) {
      throw moduleError('host-installation-recovery-owner-mismatch');
    }
    if (
      existing
      && existing.operationIntentId !== input.operationIntentId
      && existing.phase === 'withdrawn'
    ) {
      existing = null;
    }
    const retainedPreparation = this.targetPreparations.get(input.projectId);
    if (existing?.phase === 'published' && existing.descriptor && retainedPreparation) {
      return existing.descriptor;
    }
    const connection = await createConnection(input.projectId);
    let durableOperationId = existing?.operationIntentId ?? null;
    let keepConnection = false;
    let createdTarget: CloudToLanTargetCoordinatorOptions['target'] | null = null;
    try {
      let entry = existing;
      if (!entry) {
        const snapshot = await connection.readSnapshot(input.projectId, options);
        this.assertCloudToLanConnectionIdentity(connection, snapshot);
        const createdAt = this.now().toISOString();
        entry = await this.options.persistence.prepareCloudToLanTargetEntry(
          createCloudToLanTargetEntry({
            createdAt,
            expiresAt: authorityTransferEntryExpiresAt(createdAt),
            operationIntentId: input.operationIntentId,
            ownerInstallationKey: this.options.installationKey,
            projectId: input.projectId,
            selectedTargetMemberId: snapshot.currentMember.id,
            selectedTargetPersonalRef: snapshot.currentMember.personalRef,
            sourceAuthorityGeneration: snapshot.project.authorityGeneration,
            sourceCloudUrl: connection.serverUrl,
          }),
        );
        durableOperationId = entry.operationIntentId;
      } else {
        this.assertCloudToLanTargetConnection(entry, connection);
      }
      if (entry.descriptor) {
        if (entry.phase !== 'published') {
          throw moduleError('authority-transfer-target-preparation-withdrawn');
        }
        const target = createTarget(input.projectId, connection);
        createdTarget = target;
        const prepared = await target.prepareTarget?.(entry.descriptor.targetUrl);
        if (!prepared || prepared.targetUrl !== entry.descriptor.targetUrl) {
          throw moduleError('authority-transfer-target-url-mismatch');
        }
        this.targetPreparations.set(input.projectId, { connection, target });
        keepConnection = true;
        return entry.descriptor;
      }
      const target = createTarget(input.projectId, connection);
      createdTarget = target;
      if (!target.prepareTarget) {
        throw moduleError('authority-transfer-target-preparation-unavailable');
      }
      const prepared = await target.prepareTarget();
      if (
        !('caCertificatePem' in prepared)
        || !('caFingerprint' in prepared)
        || typeof prepared.caCertificatePem !== 'string'
        || typeof prepared.caFingerprint !== 'string'
      ) throw moduleError('authority-transfer-target-trust-unavailable');
      const publishedAt = this.now().toISOString();
      const published = await this.options.persistence.publishCloudToLanTargetEntry(
        entry,
        {
          caCertificatePem: prepared.caCertificatePem,
          caFingerprint: prepared.caFingerprint,
          publishedAt,
          targetUrl: prepared.targetUrl,
        },
      );
      if (!published.descriptor) {
        throw moduleError('authority-transfer-target-descriptor-missing');
      }
      this.targetPreparations.set(input.projectId, { connection, target });
      keepConnection = true;
      return published.descriptor;
    } catch (error) {
      if (durableOperationId !== null) {
        throw durableOutcome(
          durableOperationId,
          'authority-transfer-target-preparation-incomplete',
        );
      }
      throw error;
    } finally {
      if (!keepConnection) {
        await Promise.allSettled([
          disposeCloudToLanTargetPreparation(connection, createdTarget),
        ]);
      }
    }
  }

  async beginCloudToLanTransfer(
    input: BeginCloudToLanTransferInput,
    options: CollabOperationOptions = {},
  ): Promise<CloudToLanTransferHandle> {
    const descriptor = decodeCloudToLanTargetPreparationDescriptor(input.descriptor);
    return this.options.lifecycle.runExclusive(
      descriptor.projectId,
      'authority-transfer',
      'continuation',
      () => this.beginCloudToLanTransferOwned(
        descriptor,
        input.operationIntentId,
        options,
      ),
    );
  }

  private async beginCloudToLanTransferOwned(
    descriptor: CloudToLanTargetPreparationDescriptor,
    operationIntentId: string,
    options: CollabOperationOptions,
  ): Promise<CloudToLanTransferHandle> {
    const createConnection = this.options.createCloudToLanConnection;
    let entry = await this.options.persistence.loadCloudToLanManagerEntry(
      descriptor.projectId,
    );
    const existingDescriptorMatches = entry !== null
      && JSON.stringify(entry.descriptor) === JSON.stringify(descriptor);
    if (entry?.phase === 'settled') {
      if (existingDescriptorMatches && entry.status) {
        return cloudToLanTransferHandle(entry);
      }
      entry = null;
    } else if (entry?.phase === 'rejected') {
      await this.options.persistence.settleCloudToLanManagerEntry(entry);
      entry = null;
    }
    if (entry && !existingDescriptorMatches) {
      throw moduleError('authority-transfer-manager-entry-conflict');
    }
    if (entry?.status) return cloudToLanTransferHandle(entry);
    const connection = await createConnection(descriptor.projectId);
    try {
      if (!entry) {
        const [snapshot, listed] = await Promise.all([
          connection.readSnapshot(descriptor.projectId, options),
          connection.listProjectMembers({ projectId: descriptor.projectId }, options),
        ]);
        this.assertCloudToLanConnectionIdentity(connection, snapshot);
        const targetMembers = listed.projectId === descriptor.projectId
          ? listed.members.filter(member => member.memberId === descriptor.selectedTargetMemberId)
          : [];
        if (
          snapshot.currentMember.role !== 'manager'
          || descriptor.sourceCloudUrl !== connection.serverUrl
          || descriptor.sourceAuthorityGeneration !== connection.authorityGeneration
          || targetMembers.length !== 1
          || targetMembers[0]?.bindingState !== 'bound'
        ) throw moduleError('authority-transfer-manager-selection-stale');
        const createdAt = this.now().toISOString();
        entry = await this.options.persistence.prepareCloudToLanManagerEntry(
          createCloudToLanManagerEntry({
            createdAt,
            descriptor,
            expiresAt: authorityTransferEntryExpiresAt(createdAt),
            initiatingMemberId: snapshot.currentMember.id,
            initiatingPersonalRef: snapshot.currentMember.personalRef,
            operationIntentId,
          }),
        );
      }
      if (
        JSON.stringify(entry.descriptor) !== JSON.stringify(descriptor)
      ) throw moduleError('authority-transfer-manager-entry-conflict');
      this.assertCloudToLanManagerConnection(entry, connection);
      const wasPossiblySent = entry.phase === 'submitted';
      try {
        entry = await this.options.persistence.markCloudToLanManagerBeginPossiblySent(entry);
      } catch {
        throw durableOutcome(
          entry.operationIntentId,
          'authority-transfer-manager-begin-incomplete',
        );
      }
      let status: CollabAuthorityTransferStatus;
      try {
        status = await connection.lifecycle.authorityTransfer(
          'beginCloudToLanTransfer',
          entry.request,
          options,
        );
      } catch (error) {
        if (
          error instanceof CloudAuthorityRejection
          && isDefinitiveCloudToLanBeginRejection(error, wasPossiblySent)
        ) {
          try {
            await this.settleRejectedCloudToLanManagerEntry(entry, connection, options);
          } catch {
            throw durableOutcome(
              entry.operationIntentId,
              'authority-transfer-manager-rejection-settlement-incomplete',
            );
          }
          throw error;
        }
        throw durableOutcome(
          entry.operationIntentId,
          'authority-transfer-manager-begin-ambiguous',
        );
      }
      try {
        entry = await this.options.persistence.recordCloudToLanManagerStatus(entry, status);
      } catch {
        throw durableOutcome(
          entry.operationIntentId,
          'authority-transfer-manager-status-incomplete',
        );
      }
      return cloudToLanTransferHandle(entry);
    } finally {
      connection.dispose();
    }
  }

  async acceptCloudToLanTransfer(
    input: AcceptPreparedCloudToLanTransferInput,
    options: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus> {
    const handle = decodeCloudToLanTransferHandle(input.handle);
    return this.options.lifecycle.runExclusive(
      handle.projectId,
      'authority-transfer',
      'continuation',
      async () => {
        const entry = await this.options.persistence.loadCloudToLanTargetEntry(
          handle.projectId,
        );
        if (!entry || entry.ownerInstallationKey !== this.options.installationKey) {
          throw moduleError('host-installation-recovery-owner-mismatch');
        }
        if (entry.phase !== 'published' && entry.phase !== 'handed-off') {
          throw moduleError('authority-transfer-target-handle-mismatch');
        }
        try {
          assertCloudToLanTargetHandle(entry, handle);
        } catch {
          throw moduleError('authority-transfer-target-handle-mismatch');
        }
        let binding = this.targetBindings.get(handle.projectId);
        if (!binding) {
          const createConnection = this.options.createCloudToLanConnection;
          const createTarget = this.options.createCloudToLanTarget;
          let preparation = this.targetPreparations.get(handle.projectId);
          if (!preparation) {
            const connection = await createConnection(handle.projectId);
            try {
              this.assertCloudToLanTargetConnection(entry, connection);
              preparation = {
                connection,
                target: createTarget(
                  handle.projectId,
                  connection,
                ),
              };
            } catch (error) {
              connection.dispose();
              throw error;
            }
            this.targetPreparations.set(handle.projectId, preparation);
          }
          if (this.sourceBindings.has(handle.projectId)) {
            throw moduleError('authority-transfer-direction-runtime-conflict');
          }
          const coordinator = new CloudToLanTargetCoordinator({
            cloud: preparation.connection.lifecycle,
            installationKey: this.options.installationKey,
            persistence: this.options.persistence,
            target: preparation.target,
          });
          const unregister = this.runtimes.register(handle.projectId, 'target', coordinator);
          binding = {
            coordinator,
            dispose: async () => {
              unregister();
              await disposeCloudToLanTargetPreparation(
                preparation.connection,
                preparation.target,
              );
            },
            unregister,
          };
          this.targetBindings.set(handle.projectId, binding);
          this.targetPreparations.delete(handle.projectId);
        }
        let status: CollabAuthorityTransferStatus;
        try {
          status = await binding.coordinator.acceptPreparedTransfer(handle, options);
        } catch (error) {
          const physical = await this.options.persistence.load(handle.projectId);
          if (
            physical
            && physical.localRole === 'target'
            && physical.status.direction === 'cloud-to-lan'
            && physical.operationIntentId === handle.operationIntentId
            && physical.transferId === handle.transferId
          ) throw durableOutcome(
            handle.operationIntentId,
            'authority-transfer-target-acceptance-incomplete',
          );
          throw error;
        }
        let managerSettlementFailed = false;
        try {
          await this.settleMatchingCloudToLanManager(handle, status);
        } catch {
          managerSettlementFailed = true;
        }
        let targetCleanupFailed = false;
        if (status.state === 'cancelled') {
          if (this.targetBindings.get(handle.projectId) === binding) {
            this.targetBindings.delete(handle.projectId);
            try {
              await binding.dispose();
            } catch {
              targetCleanupFailed = true;
            }
          }
        }
        if (managerSettlementFailed || targetCleanupFailed) {
          throw durableOutcome(
            handle.operationIntentId,
            targetCleanupFailed
              ? 'authority-transfer-target-cancellation-cleanup-incomplete'
              : 'authority-transfer-manager-status-incomplete',
          );
        }
        return status;
      },
    );
  }

  async withdrawCloudToLanTarget(
    input: WithdrawPreparedCloudToLanTargetInput,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    return this.options.lifecycle.runExclusive(
      input.projectId,
      'authority-transfer',
      'continuation',
      async () => {
        if (options.signal?.aborted) throw new CollabError({ code: 'cancelled' });
        const entry = await this.options.persistence.loadCloudToLanTargetEntry(input.projectId);
        if (
          !entry
          || entry.ownerInstallationKey !== this.options.installationKey
        ) throw moduleError('host-installation-recovery-owner-mismatch');
        if (entry.operationIntentId !== input.preparationId) {
          throw moduleError('authority-transfer-target-preparation-mismatch');
        }
        if (entry.phase !== 'withdrawn') {
          await this.options.persistence.withdrawCloudToLanTargetEntry(entry);
        }
        const binding = this.targetBindings.get(input.projectId);
        const preparation = this.targetPreparations.get(input.projectId);
        this.targetBindings.delete(input.projectId);
        this.targetPreparations.delete(input.projectId);
        const cleanup = await Promise.allSettled([
          ...(binding ? [binding.dispose()] : []),
          ...(preparation ? [disposeCloudToLanTargetPreparation(
            preparation.connection,
            preparation.target,
          )] : []),
        ]);
        const failed = cleanup.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected',
        );
        if (failed) throw failed.reason;
      },
    );
  }

  async observeCloudToLanTransfer(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus> {
    const entry = await this.requireCloudToLanManagerStatus(projectId);
    const connection = await this.requireCloudToLanManagerConnection(entry);
    try {
      const status = await connection.lifecycle.authorityTransfer(
        'getProjectAuthorityTransfer',
        { projectId, transferId: entry.status!.transferId },
        options,
      );
      const observed = await this.options.persistence.recordCloudToLanManagerStatus(entry, status);
      if (observed.phase === 'settled') {
        await this.options.persistence.settleCloudToLanManagerEntry(observed);
      }
      return status;
    } finally {
      connection.dispose();
    }
  }

  async cancelCloudToLanTransfer(
    input: CloudToLanTransferHandle,
    options: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus> {
    const handle = decodeCloudToLanTransferHandle(input);
    const projectId = handle.projectId;
    let entry = await this.requireCloudToLanManagerStatus(projectId);
    if (!sameCloudToLanTransferHandle(cloudToLanTransferHandle(entry), handle)) {
      throw moduleError('authority-transfer-manager-handle-mismatch');
    }
    const connection = await this.requireCloudToLanManagerConnection(entry);
    try {
      if (entry.cancellation === null) {
        const current = await connection.lifecycle.authorityTransfer(
          'getProjectAuthorityTransfer',
          { projectId, transferId: entry.status!.transferId },
          options,
        );
        entry = await this.options.persistence.recordCloudToLanManagerStatus(entry, current);
        if (entry.phase === 'settled') {
          await this.options.persistence.settleCloudToLanManagerEntry(entry);
          return current;
        }
        if (!COLLAB_AUTHORITY_TRANSFER_CANCELLABLE_PHASES.includes(current.phase as never)) {
          throw new CollabError({ code: 'authority-transfer-cancellation-forbidden' });
        }
        entry = await this.options.persistence.prepareCloudToLanManagerCancellation(entry, {
          expectedPhase: current.phase as typeof COLLAB_AUTHORITY_TRANSFER_CANCELLABLE_PHASES[number],
          idempotencyKey: authorityTransferChildIdempotencyKey(
            entry.operationIntentId,
            'cancel',
          ),
          projectId,
          transferId: current.transferId,
        });
      }
      try {
        entry = await this.options.persistence
          .markCloudToLanManagerCancellationPossiblySent(entry);
      } catch {
        throw durableOutcome(
          entry.operationIntentId,
          'authority-transfer-manager-cancellation-incomplete',
        );
      }
      try {
        const cancelled = await connection.lifecycle.authorityTransfer(
          'cancelProjectAuthorityTransfer',
          entry.cancellation!.request,
          options,
        );
        let observed: CloudToLanManagerEntryRecord;
        try {
          observed = await this.options.persistence.recordCloudToLanManagerStatus(
            entry,
            cancelled,
          );
        } catch {
          throw durableOutcome(
            entry.operationIntentId,
            'authority-transfer-manager-cancellation-status-incomplete',
          );
        }
        if (observed.phase === 'settled') {
          await this.options.persistence.settleCloudToLanManagerEntry(observed);
        }
        return cancelled;
      } catch (error) {
        if (error instanceof CollabAuthorityTransferOutcomeError) throw error;
        if (!(error instanceof CloudAuthorityRejection)) {
          throw durableOutcome(
            entry.operationIntentId,
            'authority-transfer-manager-cancellation-ambiguous',
          );
        }
        let observed: CollabAuthorityTransferStatus;
        try {
          observed = await connection.lifecycle.authorityTransfer(
            'getProjectAuthorityTransfer',
            { projectId, transferId: entry.status!.transferId },
            options,
          );
        } catch {
          throw durableOutcome(
            entry.operationIntentId,
            'authority-transfer-manager-cancellation-observation-incomplete',
          );
        }
        if (observed.phase === entry.status!.phase) throw error;
        let advanced: CloudToLanManagerEntryRecord;
        try {
          advanced = await this.options.persistence.recordCloudToLanManagerStatus(
            entry,
            observed,
          );
        } catch {
          throw durableOutcome(
            entry.operationIntentId,
            'authority-transfer-manager-cancellation-status-incomplete',
          );
        }
        if (advanced.phase === 'settled') {
          await this.options.persistence.settleCloudToLanManagerEntry(advanced);
        }
        return observed;
      }
    } finally {
      connection.dispose();
    }
  }

  private async resumeCloudToLanManagerEntry(
    projectId: CollabProjectId,
    options: CollabOperationOptions,
  ): Promise<void> {
    let entry = await this.options.persistence.loadCloudToLanManagerEntry(projectId);
    if (!entry) return;
    if (entry.phase === 'settled' || entry.phase === 'rejected') {
      await this.options.persistence.settleCloudToLanManagerEntry(entry);
      return;
    }
    const physical = await this.options.persistence.load(projectId);
    if (physical && physical.ownerInstallationKey === undefined) {
      throw moduleError('host-installation-recovery-owner-mismatch');
    }
    if (physical?.ownerInstallationKey === this.options.installationKey) {
      if (!this.cloudToLanManagerMatchesPhysical(entry, physical)) {
        throw moduleError('authority-transfer-manager-physical-mismatch');
      }
      return;
    }
    const connection = await this.requireCloudToLanManagerConnection(entry);
    try {
      let status: CollabAuthorityTransferStatus;
      if (!entry.status) {
        const wasPossiblySent = entry.phase === 'submitted';
        entry = await this.options.persistence.markCloudToLanManagerBeginPossiblySent(entry);
        try {
          status = await connection.lifecycle.authorityTransfer(
            'beginCloudToLanTransfer',
            entry.request,
            options,
          );
        } catch (error) {
          if (
            !(error instanceof CloudAuthorityRejection)
            || !isDefinitiveCloudToLanBeginRejection(error, wasPossiblySent)
          ) throw error;
          await this.settleRejectedCloudToLanManagerEntry(entry, connection, options);
          return;
        }
      } else if (entry.cancellation) {
        const priorStatus = entry.status;
        entry = await this.options.persistence
          .markCloudToLanManagerCancellationPossiblySent(entry);
        try {
          status = await connection.lifecycle.authorityTransfer(
            'cancelProjectAuthorityTransfer',
            entry.cancellation!.request,
            options,
          );
        } catch (error) {
          if (!(error instanceof CloudAuthorityRejection)) throw error;
          status = await connection.lifecycle.authorityTransfer(
            'getProjectAuthorityTransfer',
            { projectId, transferId: priorStatus.transferId },
            options,
          );
          if (status.phase === priorStatus.phase) throw error;
        }
      } else {
        status = await connection.lifecycle.authorityTransfer(
          'getProjectAuthorityTransfer',
          { projectId, transferId: entry.status.transferId },
          options,
        );
      }
      const observed = await this.options.persistence.recordCloudToLanManagerStatus(entry, status);
      if (observed.phase === 'settled') {
        await this.options.persistence.settleCloudToLanManagerEntry(observed);
      }
    } finally {
      connection.dispose();
    }
  }

  private async resumeAuthorityTransferRecord(
    record: AuthorityTransferRecord,
    options: CollabOperationOptions,
  ): Promise<void> {
    if (record.terminalCleanupCompleted) {
      await this.options.persistence.completeTerminalCleanup({
        operationIntentId: record.operationIntentId,
        projectId: record.projectId,
        stagingDirectoryName: record.stagingDirectoryName,
        transferId: record.transferId,
      });
    } else {
      await this.runtimes.resume(record, options);
    }
    const current = await this.options.persistence.load(record.projectId);
    if (
      current
      && current.localRole === 'target'
      && current.status.direction === 'cloud-to-lan'
      && (current.status.state === 'cancelled' || current.status.state === 'completed')
    ) await this.settleRecoveredCloudToLanManager(current);
  }

  private async settleRecoveredCloudToLanManager(
    record: AuthorityTransferRecord,
  ): Promise<void> {
    const entry = await this.options.persistence.loadCloudToLanManagerEntry(record.projectId);
    if (!entry?.status) return;
    if (!this.cloudToLanManagerMatchesPhysical(entry, record)) {
      throw moduleError('authority-transfer-manager-physical-mismatch');
    }
    await this.settleMatchingCloudToLanManager(
      cloudToLanTransferHandle(entry),
      record.status,
    );
  }

  private cloudToLanManagerMatchesPhysical(
    entry: CloudToLanManagerEntryRecord,
    record: AuthorityTransferRecord,
  ): boolean {
    return entry.status !== null
      && record.localRole === 'target'
      && record.status.direction === 'cloud-to-lan'
      && entry.operationIntentId === record.operationIntentId
      && entry.projectId === record.projectId
      && entry.status.transferId === record.transferId
      && entry.status.createdAt === record.status.createdAt
      && entry.status.expiresAt === record.status.expiresAt
      && entry.descriptor.sourceAuthorityGeneration
        === record.status.sourceAuthority.generation
      && entry.descriptor.targetUrl === record.status.targetUrl;
  }

  private async assertCloudToLanManagerSettled(projectId: CollabProjectId): Promise<void> {
    const entry = await this.options.persistence.loadCloudToLanManagerEntry(projectId);
    if (entry && entry.phase !== 'settled') {
      throw moduleError('authority-transfer-manager-observer-pending');
    }
  }

  private async settleMatchingCloudToLanManager(
    handle: CloudToLanTransferHandle,
    status: CollabAuthorityTransferStatus,
  ): Promise<void> {
    const entry = await this.options.persistence.loadCloudToLanManagerEntry(
      handle.projectId,
    );
    if (
      !entry?.status
      || !sameCloudToLanTransferHandle(cloudToLanTransferHandle(entry), handle)
    ) return;
    if (entry.phase === 'settled') {
      await this.options.persistence.settleCloudToLanManagerEntry(entry);
      return;
    }
    if (entry.phase !== 'submitted' && entry.phase !== 'observing') return;
    const observed = await this.options.persistence.recordCloudToLanManagerStatus(entry, status);
    if (observed.phase === 'settled') {
      await this.options.persistence.settleCloudToLanManagerEntry(observed);
    }
  }

  private async requireCloudToLanManagerConnection(
    entry: NonNullable<Awaited<ReturnType<AuthorityTransferPersistence['loadCloudToLanManagerEntry']>>>,
  ): Promise<CloudToLanEntryConnection> {
    const createConnection = this.options.createCloudToLanConnection;
    const connection = await createConnection(entry.projectId);
    try {
      this.assertCloudToLanManagerConnection(entry, connection);
      return connection;
    } catch (error) {
      connection.dispose();
      throw error;
    }
  }

  private async settleRejectedCloudToLanManagerEntry(
    entry: CloudToLanManagerEntryRecord,
    connection: CloudToLanEntryConnection,
    options: CollabOperationOptions,
  ): Promise<void> {
    const [snapshot, listed] = await Promise.all([
      connection.readSnapshot(entry.projectId, options),
      connection.listProjectMembers({ projectId: entry.projectId }, options),
    ]);
    this.assertCloudToLanConnectionIdentity(connection, snapshot);
    const initiatingMembers = listed.projectId === entry.projectId
      ? listed.members.filter(member => member.memberId === entry.initiatingMemberId)
      : [];
    if (
      snapshot.project.authorityGeneration !== entry.descriptor.sourceAuthorityGeneration
      || snapshot.currentMember.id !== entry.initiatingMemberId
      || snapshot.currentMember.personalRef !== entry.initiatingPersonalRef
      || initiatingMembers.length !== 1
      || initiatingMembers[0]?.bindingState !== (
        snapshot.currentMember.role === 'manager' ? 'bound' : 'hidden'
      )
      || initiatingMembers[0].role !== snapshot.currentMember.role
    ) throw moduleError('authority-transfer-manager-rejection-barrier-mismatch');
    const rejected = await this.options.persistence.rejectCloudToLanManagerEntry(entry);
    await this.options.persistence.settleCloudToLanManagerEntry(rejected);
  }

  private assertCloudToLanManagerConnection(
    entry: NonNullable<Awaited<ReturnType<AuthorityTransferPersistence['loadCloudToLanManagerEntry']>>>,
    connection: CloudToLanEntryConnection,
  ): void {
    if (
      connection.projectId !== entry.projectId
      || connection.memberId !== entry.initiatingMemberId
      || connection.personalRef !== entry.initiatingPersonalRef
      || connection.serverUrl !== entry.descriptor.sourceCloudUrl
      || connection.authorityGeneration !== entry.descriptor.sourceAuthorityGeneration
    ) {
      throw moduleError('authority-transfer-cloud-binding-mismatch');
    }
  }

  private assertCloudToLanTargetConnection(
    entry: NonNullable<Awaited<ReturnType<AuthorityTransferPersistence['loadCloudToLanTargetEntry']>>>,
    connection: CloudToLanEntryConnection,
  ): void {
    if (
      connection.projectId !== entry.projectId
      || connection.memberId !== entry.selectedTargetMemberId
      || connection.personalRef !== entry.selectedTargetPersonalRef
      || connection.serverUrl !== entry.sourceCloudUrl
      || connection.authorityGeneration !== entry.sourceAuthorityGeneration
    ) {
      throw moduleError('authority-transfer-cloud-binding-mismatch');
    }
  }

  private async requireCloudToLanManagerStatus(
    projectId: CollabProjectId,
  ) {
    const entry = await this.options.persistence.loadCloudToLanManagerEntry(projectId);
    if (!entry?.status || entry.phase === 'settled') {
      throw moduleError('authority-transfer-manager-status-missing');
    }
    return entry;
  }

  private assertCloudToLanConnectionIdentity(
    connection: CloudToLanEntryConnection,
    snapshot: Awaited<ReturnType<CloudToLanEntryConnection['readSnapshot']>>,
  ): void {
    if (
      connection.projectId !== snapshot.project.id
      || connection.authorityGeneration !== snapshot.project.authorityGeneration
      || connection.memberId !== snapshot.currentMember.id
      || connection.personalRef !== snapshot.currentMember.personalRef
    ) throw moduleError('authority-transfer-cloud-binding-mismatch');
  }

  async close(): Promise<void> {
    const sourceBindings = [...this.sourceBindings.values()];
    const targetBindings = [...this.targetBindings.values()];
    const targetPreparations = [...this.targetPreparations.values()];
    const recoveredCloudSessions = [...this.recoveredCloudSessions.values()];
    this.sourceBindings.clear();
    this.targetBindings.clear();
    this.targetPreparations.clear();
    this.recoveredCloudSessions.clear();
    await Promise.all([
      ...sourceBindings.map(async binding => {
        binding.unregister();
        await binding.cleanupRoute();
      }),
      ...targetBindings.map(binding => binding.dispose()),
      ...targetPreparations.map(preparation => disposeCloudToLanTargetPreparation(
        preparation.connection,
        preparation.target,
      )),
      ...recoveredCloudSessions.map(async session => { session.dispose(); }),
    ]);
  }

  bindLanToCloudClaimant(
    input: BindLanToCloudClaimantInput,
  ): AuthorityTransferDirectionBinding<AuthorityTransferClaimantCoordinator> {
    this.assertCloudSession(input.projectId, input.cloudSession);
    return this.bindClaimant({
      convergence: {
        converge: async (record, options) => {
          if (record.variant !== 'source-issued') {
            throw moduleError('authority-transfer-claimant-variant-invalid');
          }
          const snapshot = await input.cloudSession.readSnapshot(record.projectId, options);
          await this.convergence.lanToCloudMember({
            snapshot,
            status: record.status,
          });
        },
      },
      projectId: input.projectId,
      lanTarget: null,
      source: {
        acknowledgeRedemption: async (record, options) => {
          if (!record.redemptionReceipt) {
            throw moduleError('authority-transfer-claimant-receipt-missing');
          }
          await input.lanClient.requestWithMember(
            'acknowledgeTransferredMembershipClaimRedemption',
            {
              idempotencyKey: `${record.operationIntentId}-source-ack`,
              projectId: record.projectId,
              receipt: record.redemptionReceipt,
              transferId: record.transferId,
            },
            input.memberCredential,
            options,
          );
        },
        getClaim: (record, options) => input.lanClient.requestWithMember(
          'getTransferredMembershipClaim',
          { projectId: record.projectId, transferId: record.transferId },
          input.memberCredential,
          options,
        ),
      },
      target: {
        claimTransferredMembership: (record, request, options) => {
          if ('credentialHash' in request && request.credentialHash !== undefined) {
            throw moduleError('authority-transfer-cloud-claim-credential-unexpected');
          }
          return input.cloudSession.lifecycle.authorityTransfer(
            'claimTransferredMembership',
            request,
            options,
          );
        },
      },
    });
  }

  bindManagerReissuedClaimant(
    input: BindManagerReissuedClaimantInput,
  ): AuthorityTransferDirectionBinding<AuthorityTransferClaimantCoordinator> {
    this.assertCloudSession(input.projectId, input.cloudSession);
    return this.bindClaimant({
      convergence: {
        converge: async (record, options) => {
          if (record.variant !== 'manager-reissued' || !record.targetStatus) {
            throw moduleError('authority-transfer-claimant-variant-invalid');
          }
          if (record.serverUrl !== input.cloudSession.serverUrl) {
            throw moduleError('authority-transfer-cloud-binding-mismatch');
          }
          const snapshot = await input.cloudSession.readSnapshot(record.projectId, options);
          this.assertManagerReissuedTarget(record, record.targetStatus, snapshot);
          await this.convergence.lanToCloudMember({
            snapshot,
            status: record.targetStatus,
          });
        },
      },
      projectId: input.projectId,
      lanTarget: null,
      target: {
        claimTransferredMembership: (record, request, options) => {
          if (record.variant !== 'manager-reissued') {
            throw moduleError('authority-transfer-claimant-variant-invalid');
          }
          if (record.serverUrl !== input.cloudSession.serverUrl) {
            throw moduleError('authority-transfer-cloud-binding-mismatch');
          }
          if ('credentialHash' in request && request.credentialHash !== undefined) {
            throw moduleError('authority-transfer-cloud-claim-credential-unexpected');
          }
          return input.cloudSession.lifecycle.authorityTransfer(
            'claimTransferredMembership',
            request,
            options,
          );
        },
        confirmTargetBinding: async (record, _proof, options) => {
          if (record.serverUrl !== input.cloudSession.serverUrl) {
            throw moduleError('authority-transfer-cloud-binding-mismatch');
          }
          const status = await input.cloudSession.lifecycle.authorityTransfer(
            'getProjectAuthorityTransfer',
            { projectId: record.projectId, transferId: record.transferId },
            options,
          );
          const snapshot = await input.cloudSession.readSnapshot(record.projectId, options);
          this.assertManagerReissuedTarget(record, status, snapshot);
          return status;
        },
      },
    });
  }

  redeemManagerReissuedClaim(
    invitation: CloudMembershipClaimInvitation,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    return this.options.lifecycle.runExclusive(
      invitation.claim.projectId,
      this.claimantRecovery.durableOwner.name,
      'continuation',
      () => this.redeemManagerReissuedClaimOwned(invitation, options),
    );
  }

  private async redeemManagerReissuedClaimOwned(
    invitation: CloudMembershipClaimInvitation,
    options: CollabOperationOptions,
  ): Promise<void> {
    const loadMembership = this.options.loadClaimantMembership;
    const createConnection = this.options.createManagerReissuedClaimConnection;
    if (!loadMembership || !createConnection) {
      throw moduleError('authority-transfer-claimant-entry-unavailable');
    }
    const membership = await loadMembership(invitation.claim.projectId);
    if (
      !membership
      || !isCollabLocalLanMembership(membership)
      || membership.hostOwnership.ownsAuthority
      || membership.member.id !== invitation.claim.memberId
    ) throw moduleError('authority-transfer-claimant-membership-invalid');
    const cloudSession = await createConnection({
      projectId: invitation.claim.projectId,
      serverUrl: invitation.serverUrl,
    }, options);
    try {
      await this.assertCloudToLanManagerSettled(invitation.claim.projectId);
      const binding = this.bindManagerReissuedClaimant({
        cloudSession,
        projectId: invitation.claim.projectId,
      });
      try {
        await binding.coordinator.startManagerReissued({
          descriptor: invitation.claim,
          memberPersonalRef: membership.member.personalRef,
          serverUrl: invitation.serverUrl,
        }, options);
      } finally {
        await binding.dispose();
      }
    } finally {
      cloudSession.dispose();
    }
  }

  bindCloudToLanClaimant(
    input: BindCloudToLanClaimantInput,
  ): AuthorityTransferDirectionBinding<AuthorityTransferClaimantCoordinator> {
    this.assertCloudSession(input.projectId, input.cloudSession);
    const control = this.lanTargetSnapshotReader(input.projectId, input.targetHost);
    return this.bindClaimant({
      convergence: {
        converge: async (record, options) => {
          if (record.variant !== 'source-issued') {
            throw moduleError('authority-transfer-claimant-variant-invalid');
          }
          const targetCredential = this.requireTargetCredential(record);
          const snapshot = await control.readSnapshot(
            record.projectId,
            targetCredential,
            options,
          );
          await this.convergence.cloudToLanMember({
            endpoint: input.targetHost.endpoint,
            hostCaCertificatePem: input.targetHost.caCertificatePem,
            hostCaFingerprint: input.targetHost.caFingerprint,
            identity: {
              authorityGeneration: record.status.targetAuthority.generation,
              currentMember: snapshot.currentMember,
              eventSequence: snapshot.eventSequence,
              project: snapshot.project,
            },
            memberCredential: targetCredential,
            status: record.status,
          });
        },
      },
      projectId: input.projectId,
      lanTarget: input.targetHost,
      source: {
        acknowledgeRedemption: async (record, options) => {
          if (!record.redemptionReceipt) {
            throw moduleError('authority-transfer-claimant-receipt-missing');
          }
          await input.cloudSession.lifecycle.authorityTransfer(
            'acknowledgeTransferredMembershipClaimRedemption',
            {
              idempotencyKey: `${record.operationIntentId}-source-ack`,
              projectId: record.projectId,
              receipt: record.redemptionReceipt,
              transferId: record.transferId,
            },
            options,
          );
        },
        getClaim: (record, options) => input.cloudSession.lifecycle.authorityTransfer(
          'getTransferredMembershipClaim',
          { projectId: record.projectId, transferId: record.transferId },
          options,
        ),
      },
      target: {
        claimTransferredMembership: (_record, request, options) => {
          if (!('credentialHash' in request) || request.credentialHash === undefined) {
            throw moduleError('authority-transfer-lan-claim-credential-missing');
          }
          return input.lanClient.claimTransferredMembership(request, options);
        },
      },
    });
  }

  private bindLanToCloudTargetOnlyClaimant(input: Readonly<{
    readonly cloudSession: CloudAuthorityConnection;
    readonly projectId: CollabProjectId;
  }>): AuthorityTransferDirectionBinding<AuthorityTransferClaimantCoordinator> {
    this.assertCloudSession(input.projectId, input.cloudSession);
    return this.bindClaimant({
      convergence: {
        converge: async (record, options) => {
          if (record.variant !== 'source-issued') {
            throw moduleError('authority-transfer-claimant-variant-invalid');
          }
          const snapshot = await input.cloudSession.readSnapshot(record.projectId, options);
          await this.convergence.lanToCloudMember({
            snapshot,
            status: record.status,
          });
        },
      },
      projectId: input.projectId,
      lanTarget: null,
      source: {
        acknowledgeRedemption: () => {
          throw moduleError('authority-transfer-claimant-source-unavailable');
        },
        getClaim: () => {
          throw moduleError('authority-transfer-claimant-source-unavailable');
        },
      },
      target: {
        claimTransferredMembership: () => {
          throw moduleError('authority-transfer-claimant-target-replay-invalid');
        },
      },
    });
  }

  private bindCloudToLanTargetOnlyClaimant(input: Readonly<{
    readonly projectId: CollabProjectId;
    readonly targetHost: BindCloudToLanClaimantInput['targetHost'];
  }>): AuthorityTransferDirectionBinding<AuthorityTransferClaimantCoordinator> {
    const control = this.lanTargetSnapshotReader(input.projectId, input.targetHost);
    return this.bindClaimant({
      convergence: {
        converge: async (record, options) => {
          if (record.variant !== 'source-issued') {
            throw moduleError('authority-transfer-claimant-variant-invalid');
          }
          const targetCredential = this.requireTargetCredential(record);
          const snapshot = await control.readSnapshot(
            record.projectId,
            targetCredential,
            options,
          );
          await this.convergence.cloudToLanMember({
            endpoint: input.targetHost.endpoint,
            hostCaCertificatePem: input.targetHost.caCertificatePem,
            hostCaFingerprint: input.targetHost.caFingerprint,
            identity: {
              authorityGeneration: record.status.targetAuthority.generation,
              currentMember: snapshot.currentMember,
              eventSequence: snapshot.eventSequence,
              project: snapshot.project,
            },
            memberCredential: targetCredential,
            status: record.status,
          });
        },
      },
      projectId: input.projectId,
      lanTarget: input.targetHost,
      source: {
        acknowledgeRedemption: () => {
          throw moduleError('authority-transfer-claimant-source-unavailable');
        },
        getClaim: () => {
          throw moduleError('authority-transfer-claimant-source-unavailable');
        },
      },
      target: {
        claimTransferredMembership: () => {
          throw moduleError('authority-transfer-claimant-target-replay-invalid');
        },
      },
    });
  }

  private bindLocalOnlyClaimant(
    record: AuthorityTransferClaimantRecord,
  ): AuthorityTransferDirectionBinding<AuthorityTransferClaimantCoordinator> {
    return this.bindClaimant({
      convergence: {
        converge: current => this.convergence.recoverConvertedClaimant(current),
      },
      projectId: record.projectId,
      lanTarget: record.variant === 'source-issued' ? record.lanTarget : null,
      source: {
        acknowledgeRedemption: () => {
          throw moduleError('authority-transfer-claimant-source-unavailable');
        },
        getClaim: () => {
          throw moduleError('authority-transfer-claimant-source-unavailable');
        },
      },
      target: {
        claimTransferredMembership: () => {
          throw moduleError('authority-transfer-claimant-target-replay-invalid');
        },
      },
    });
  }

  private bindClaimant(
    input: BindAuthorityTransferClaimantInput,
  ): AuthorityTransferDirectionBinding<AuthorityTransferClaimantCoordinator> {
    const coordinator = new AuthorityTransferClaimantCoordinator({
      convergence: input.convergence,
      ...(input.createCredential ? { createCredential: input.createCredential } : {}),
      ...(input.lanTarget !== undefined ? { lanTarget: input.lanTarget } : {}),
      now: input.now ?? this.now,
      ...(input.source ? { source: input.source } : {}),
      store: this.options.claimantStore,
      target: input.target,
    });
    const unregister = this.claimants.register(input.projectId, coordinator);
    return Object.freeze({ coordinator, dispose: unregister });
  }

  private requireTargetCredential(record: AuthorityTransferClaimantRecord): string {
    if (record.variant !== 'source-issued' || !record.targetCredential) {
      throw moduleError('authority-transfer-claimant-target-credential-missing');
    }
    return record.targetCredential;
  }

  private assertManagerReissuedTarget(
    record: ManagerReissuedAuthorityTransferClaimantRecord,
    status: CollabAuthorityTransferStatus,
    snapshot: Awaited<ReturnType<CloudAuthorityConnection['readSnapshot']>>,
  ): void {
    if (
      status.direction !== 'lan-to-cloud'
      || status.state !== 'completed'
      || status.phase !== 'completed'
      || status.relinquishmentProof === null
      || status.checkpointSha256 === null
      || status.projectId !== record.projectId
      || status.transferId !== record.transferId
      || status.targetAuthority.kind !== 'cloud'
      || status.targetAuthority.generation !== record.descriptor.targetAuthorityGeneration
      || status.targetUrl !== record.serverUrl
      || snapshot.project.id !== record.projectId
      || snapshot.project.authorityKind !== 'cloud'
      || snapshot.project.authorityGeneration !== record.descriptor.targetAuthorityGeneration
      || snapshot.currentMember.id !== record.memberId
      || snapshot.currentMember.personalRef !== record.memberPersonalRef
    ) throw moduleError('authority-transfer-claimant-target-binding-invalid');
  }

  private lanTargetSnapshotReader(
    projectId: CollabProjectId,
    targetHost: BindCloudToLanClaimantInput['targetHost'],
  ): Pick<ProjectControlClient, 'readSnapshot'> {
    return this.options.createLanTargetSnapshotReader?.(projectId, targetHost)
      ?? new ProjectControlClient(new PinnedCollabHttpClient({
        ...targetHost,
        projectId,
      }, 10_000));
  }

  private async resolveClaimantRuntime(
    record: AuthorityTransferClaimantRecord,
  ): Promise<AuthorityTransferClaimantRuntimeResolution | null> {
    const recover = this.options.recoverClaimant;
    if (!recover) return null;
    const recovered = await recover(record);
    const disposeCloudSession = (): void => {
      if ('cloudSession' in recovered) recovered.cloudSession.dispose();
    };
    const direction = record.variant === 'source-issued'
      ? record.status.direction
      : 'lan-to-cloud';
    if (recovered.direction !== direction) {
      disposeCloudSession();
      throw moduleError('authority-transfer-claimant-direction-mismatch');
    }
    try {
      const binding = recovered.mode === 'local-only'
        ? this.bindLocalOnlyClaimant(record)
        : recovered.mode === 'manager-reissued'
          ? this.bindManagerReissuedClaimant({
              cloudSession: recovered.cloudSession,
              projectId: record.projectId,
            })
        : recovered.direction === 'lan-to-cloud' && recovered.mode === 'full'
          ? this.bindLanToCloudClaimant({
            cloudSession: recovered.cloudSession,
            lanClient: recovered.lanClient,
            memberCredential: recovered.memberCredential,
            projectId: record.projectId,
          })
          : recovered.direction === 'lan-to-cloud'
            ? this.bindLanToCloudTargetOnlyClaimant({
                cloudSession: recovered.cloudSession,
                projectId: record.projectId,
              })
            : recovered.mode === 'full'
              ? this.bindCloudToLanClaimant({
                  cloudSession: recovered.cloudSession,
                  lanClient: recovered.lanClient,
                  projectId: record.projectId,
                  targetHost: recovered.targetHost,
                })
              : this.bindCloudToLanTargetOnlyClaimant({
                  projectId: record.projectId,
                  targetHost: recovered.targetHost,
                });
      return {
        dispose: async () => {
          await binding.dispose();
          disposeCloudSession();
        },
        runtime: binding.coordinator,
      };
    } catch (error) {
      disposeCloudSession();
      throw error;
    }
  }

  sourceActiveService(
    input: AuthorityTransferSourceRouteInput,
  ): LanAuthorityTransferSourceActiveService | null {
    const requireLocalHostAction = (): never => {
      throw new CollabError({
        code: 'authorization-denied',
        safeContext: { reason: 'authority-transfer-local-host-confirmation-required' },
      });
    };
    const service: LanAuthorityTransferSourceActiveService = {
      acceptLanToCloudTransferTarget: async () => requireLocalHostAction(),
      authenticateMemberCredential: input.authenticateMemberCredential,
      cancelProjectAuthorityTransfer: async () => requireLocalHostAction(),
      getProjectAuthorityTransfer: async (_actor, request) => {
        if (request.projectId !== input.projectId) {
          throw new CollabError({ code: 'authority-transfer-not-found' });
        }
        const record = await this.options.persistence.load(input.projectId);
        if (record) {
          if (record.localRole === 'source' && record.transferId === request.transferId) {
            return record.status;
          }
          throw new CollabError({ code: 'authority-transfer-not-found' });
        }
        const entry = await this.options.persistence.loadSourceEntry(input.projectId);
        if (
          entry?.status.transferId === request.transferId
        ) return entry.status;
        throw new CollabError({ code: 'authority-transfer-not-found' });
      },
      requestLanToCloudTransfer: async (actor, request) => {
        if (request.projectId !== input.projectId) {
          throw new CollabError({ code: 'project-not-found' });
        }
        if (request.expectedAuthorityGeneration !== input.authorityGeneration) {
          throw new CollabError({
            code: 'authority-transfer-stale',
            safeContext: { reason: 'lan-to-cloud-source-generation-stale' },
          });
        }
        return this.sourceProposals.propose(actor.memberId, request);
      },
    };
    return Object.freeze(service);
  }

  private assertCloudSession(
    projectId: CollabProjectId,
    session: CloudAuthorityConnection,
  ): void {
    if (
      session.projectId !== projectId
      || !session.supports('authority-transfer')
      || !session.supports('project-snapshot')
    ) throw moduleError('authority-transfer-cloud-session-incompatible');
  }

  private assertLanToCloudSourceOwner(
    projectId: CollabProjectId,
    expectedAuthorityGeneration: number,
  ): Promise<void> {
    return Promise.resolve(this.options.assertLanToCloudSourceOwner(
      projectId,
      expectedAuthorityGeneration,
    ));
  }

  private async resolveRuntime(
    record: AuthorityTransferRecord,
  ): Promise<AuthorityTransferDirectionRuntime | null> {
    await this.options.assertRecoveryOwner(
      record.ownerInstallationKey,
      record.projectId,
    );
    const bound = record.localRole === 'source'
      ? this.sourceBindings.get(record.projectId)?.coordinator
      : this.targetBindings.get(record.projectId)?.coordinator;
    if (bound) return bound;
    const locallyResolved = await this.options.terminalResolver?.resolve(record) ?? null;
    if (locallyResolved) return locallyResolved;
    if (record.status.state === 'completed') return null;
    const recoverCloudSession = this.options.recoverCloudSession;
    if (!recoverCloudSession) {
      return this.options.terminalResolver?.resolve(record) ?? null;
    }
    const session = await recoverCloudSession(record);
    try {
      if (record.localRole === 'source') {
        const binding = await this.bindLanToCloudSource({
          cloudSession: session,
          ...(record.sourceLanEndpoint
            ? { expectedSourceEndpoint: record.sourceLanEndpoint }
            : {}),
          expectedTargetUrl: record.status.targetUrl,
          projectId: record.projectId,
        });
        try {
          await binding.coordinator.restoreSourceEndpoint(record);
          this.recoveredCloudSessions.set(record.projectId, session);
          return binding.coordinator;
        } catch (error) {
          await binding.dispose();
          throw error;
        }
      }
      const coordinator = (await this.bindCloudToLanTarget({
        cloudSession: session,
        expectedTargetUrl: record.status.targetUrl,
        projectId: record.projectId,
      })).coordinator;
      this.recoveredCloudSessions.set(record.projectId, session);
      return coordinator;
    } catch (error) {
      session.dispose();
      throw error;
    }
  }
}
