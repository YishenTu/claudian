import { randomUUID } from 'node:crypto';

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
  AuthorityTransferRuntimeDispatch,
  type AuthorityTransferRuntimeResolver,
} from '@/app/collab/authority-transfer/AuthorityTransferRuntimeDispatch';
import {
  AuthorityTransferClaimantCoordinator,
  type AuthorityTransferClaimantCoordinatorOptions,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantCoordinator';
import {
  type AuthorityTransferClaimantRecord,
  type CloudToLanManagerClaimantPredecessor,
  type ManagerReissuedAuthorityTransferClaimantRecord,
  type SourceIssuedAuthorityTransferClaimantRecord,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import {
  AuthorityTransferClaimantRecovery,
  authorityTransferClaimantRequiresNoRuntime,
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
  cloudToLanManagerRequiresClaimant,
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
import { LanAuthorityTransferTargetSnapshotReader } from '@/app/collab/authority-transfer/LanAuthorityTransferTargetSnapshotReader';
import type {
  AuthorityTransferPersistence,
  LanToCloudCancellationIntent,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import {
  AuthorityTransferRecovery,
} from '@/app/collab/authority-transfer/recovery/AuthorityTransferRecovery';
import {
  type CollabLocalMembershipRecord,
  isCollabLocalCloudMembership,
  isCollabLocalLanMembership,
} from '@/app/collab/CollabLocalProjectRepository';
import {
  LanAuthorityTransferClient,
  type LanAuthorityTransferTrustedHost,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferClient';
import type {
  LanAuthorityTransferActor,
  LanAuthorityTransferSourceActiveService,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferRouter';
import type {
  CollabProjectLifecycleSubsystem,
} from '@/app/collab/lifecycle/CollabProjectLifecycleSubsystem';
import type {
  CloudMembershipClaimInvitation,
} from '@/app/collab/project/CloudProjectInvitation';
import type {
  CloudAuthorityConnection,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { CloudAuthorityRejection } from '@/app/collab/remote-authority/CloudAuthorityError';
import { validateCloudServerUrl } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import type { CollabCloudToLanTransferView, CollabOperationOptions, CollabPendingReconnectView } from '@/core/collab';
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
    ownerInstallationKey: string,
    projectId: CollabProjectId,
  ) => Promise<void> | void;
  readonly claimantStore: AuthorityTransferClaimantCoordinatorOptions['store'];
  readonly createManagerReissuedClaimConnection?: (
    input: Readonly<{ readonly projectId: CollabProjectId; readonly serverUrl: string; readonly allowCredentialCreation: boolean }>,
    options: CollabOperationOptions,
  ) => Promise<CloudAuthorityConnection>;
  readonly convergence: AuthorityTransferLocalConvergence;
  readonly createCloudToLanTarget: (
    projectId: CollabProjectId,
    session: Readonly<{ readonly serverUrl: string }>,
  ) => CloudToLanTargetCoordinatorOptions['target'];
  readonly createCloudToLanConnection: (
    projectId: CollabProjectId,
    options: CollabOperationOptions,
  ) => Promise<CloudToLanEntryConnection>;
  readonly createCloudToLanClaimantClient?: (
    target: LanAuthorityTransferTrustedHost,
  ) => Pick<LanAuthorityTransferClient, 'claimTransferredMembership'>;
  readonly createLanToCloudConnection?: (
    input: Readonly<{ readonly projectId: CollabProjectId; readonly serverUrl: string; readonly allowCredentialCreation: boolean }>,
    options: CollabOperationOptions,
  ) => Promise<CloudAuthorityConnection>;
  readonly createLanToCloudClaimantClient?: (
    trust: LanAuthorityTransferTrustedHost,
  ) => LanAuthorityTransferClient;
  readonly createLanToCloudSource: (
    projectId: CollabProjectId,
    session: CloudAuthorityConnection,
  ) => LanToCloudSourceCoordinatorOptions['source'];
  readonly createLanTargetSnapshotReader?: (
    projectId: CollabProjectId,
    targetHost: BindCloudToLanClaimantInput['targetHost'],
    authorityGeneration: number,
  ) => Pick<LanAuthorityTransferTargetSnapshotReader, 'readSnapshot' | 'currentEndpoint'>;
  readonly activateLanToCloudSourceRoute?: (
    projectId: CollabProjectId,
    options: CollabOperationOptions,
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
    options: CollabOperationOptions,
  ) => Promise<CloudAuthorityConnection>;
  readonly recoverClaimant?: (
    record: AuthorityTransferClaimantRecord,
  ) => Promise<RecoveredAuthorityTransferClaimantBinding>;
  readonly terminalResolver?: AuthorityTransferRuntimeResolver;
  readonly restoreRetained?: (record: AuthorityTransferRecord, options: CollabOperationOptions) => Promise<void>;
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
  supports: CloudAuthorityConnection['supports'];
}

export interface BindLanToCloudSourceInput {
  readonly cloudSession: CloudAuthorityConnection;
  readonly expectedTargetUrl?: string;
  readonly projectId: CollabProjectId;
}

export interface CreateLanToCloudRequesterInput {
  readonly authorityGeneration: number;
  readonly lanClient: LanAuthorityTransferClient;
  readonly memberCredential: string;
  readonly memberId: LanAuthorityTransferActor['memberId'];
  readonly projectId: CollabProjectId;
}

export interface LanToCloudSourceProposalView {
  readonly cancellation: LanToCloudCancellationIntent | null;
  readonly beginSubmission: 'cloud-absent' | 'not-sent' | 'possibly-sent';
  readonly proposedByMemberId: LanAuthorityTransferActor['memberId'];
  readonly request: Readonly<RequestLanToCloudTransferRequest>;
  readonly status: CollabAuthorityTransferStatus;
}

export interface LanToCloudTransferView {
  readonly entryRole: 'requester' | 'source';
  readonly proposedByMemberId: LanAuthorityTransferActor['memberId'];
  readonly request: Readonly<RequestLanToCloudTransferRequest>;
  readonly status: CollabAuthorityTransferStatus | null;
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
  readonly cloudSession: Pick<
    CloudAuthorityConnection,
    'lifecycle' | 'projectId' | 'serverUrl' | 'supports'
  >;
  readonly lanClient: Pick<LanAuthorityTransferClient, 'claimTransferredMembership'>;
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

interface AuthorityTransferBindingOwner {
  readonly operationIntentId: string;
  readonly sourceAuthorityGeneration: number;
  readonly targetAuthorityGeneration: number;
  readonly transferId: string;
}

function bindingOwner(operationIntentId: string, status: CollabAuthorityTransferStatus): AuthorityTransferBindingOwner {
  return Object.freeze({
    operationIntentId,
    sourceAuthorityGeneration: status.sourceAuthority.generation,
    targetAuthorityGeneration: status.targetAuthority.generation,
    transferId: status.transferId,
  });
}

function bindingOwnerMatches(owner: AuthorityTransferBindingOwner, record: AuthorityTransferRecord): boolean {
  return owner.operationIntentId === record.operationIntentId
    && owner.transferId === record.transferId
    && owner.sourceAuthorityGeneration === record.status.sourceAuthority.generation
    && owner.targetAuthorityGeneration === record.status.targetAuthority.generation;
}

interface SourceBinding {
  readonly owner: AuthorityTransferBindingOwner;
  readonly ownedConnection: CloudAuthorityConnection | null;
  readonly cleanupRoute: () => Promise<void>;
  readonly coordinator: LanToCloudSourceCoordinator;
  readonly targetUrl: string;
}

interface TargetBinding {
  readonly owner: AuthorityTransferBindingOwner;
  readonly coordinator: CloudToLanTargetCoordinator;
  dispose(): Promise<void>;
  readonly managedConnection?: {
    released: boolean;
    release(): void;
    readonly target: CloudToLanTargetCoordinatorOptions['target'];
  };
  readonly terminalCleanup?: {
    readonly handle: CloudToLanTransferHandle;
    readonly status: CollabAuthorityTransferStatus;
    targetDisposed: boolean;
  };
}

interface TargetPreparationBinding {
  readonly cleanupOperationIntentId?: string;
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

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
}

function durableOutcome(operationId: string, reason: string, cause?: unknown): CollabAuthorityTransferOutcomeError {
  const error = cause instanceof CollabAuthorityTransferOutcomeError
    ? cause.result.error
    : cause instanceof CollabError ? cause : moduleError(reason);
  return new CollabAuthorityTransferOutcomeError({
    durablePhase: 'committed',
    durableProgress: true,
    error: new CollabError({
      code: error.code,
      recoveryActions: ['resume', 'open-diagnostics'],
      safeContext: error.safeContext,
    }),
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
  readonly runtimes: AuthorityTransferRuntimeDispatch;
  private readonly claimantRecovery: AuthorityTransferClaimantRecovery;
  private readonly readyCloudToLanTargets = new Map<CollabProjectId, AuthorityTransferBindingOwner>();
  private readonly sourceProposals: LanToCloudSourceProposalCoordinator;
  private readonly sourceBindings = new Map<CollabProjectId, SourceBinding>();
  private readonly targetBindings = new Map<CollabProjectId, TargetBinding>();
  private readonly targetPreparations = new Map<CollabProjectId, TargetPreparationBinding>();
  private readonly transferRecovery: AuthorityTransferRecovery;
  private readonly now: () => Date;

  constructor(private readonly options: AuthorityTransferModuleOptions) {
    this.now = options.now ?? (() => new Date());
    this.convergence = options.convergence;
    this.runtimes = new AuthorityTransferRuntimeDispatch({
      resolve: (record, operationOptions) => this.#resolveRuntime(record, operationOptions),
    });
    this.claimants = new AuthorityTransferClaimantRuntimeRegistry({
      resolve: record => this.#resolveClaimantRuntime(record),
    });
    this.sourceProposals = new LanToCloudSourceProposalCoordinator({
      installationKey: options.installationKey,
      persistence: options.persistence,
    });
    this.transferRecovery = new AuthorityTransferRecovery(
      options.persistence,
      {
        managerHandoffEstablished: projectId => (
          this.#isCloudToLanManagerClaimantHandoffEstablished(projectId)
        ),
        prepare: (record, recoveryOptions) => (
          this.runtimes.prepare(record, recoveryOptions)
        ),
        resume: (record, recoveryOptions) => (
          this.#resumeAuthorityTransferRecord(record, recoveryOptions)
        ),
        resumeRetained: async (record, recoveryOptions) => {
          if (!this.options.restoreRetained) throw moduleError('authority-transfer-retained-recovery-unavailable');
          await this.options.restoreRetained(record, recoveryOptions);
        },
        resumeManager: (projectId, recoveryOptions) => (
          this.#resumeCloudToLanManagerEntry(projectId, recoveryOptions)
        ),
        resumeTargetPreparation: (entry, recoveryOptions) => (
          this.#prepareCloudToLanTargetOwned({
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
        beforeProject: record => this.#assertClaimantManagerPredecessor(record),
        complete: record => this.#completeAuthorityTransferClaimant(record),
        isLocalOwner: record => this.#isAuthorityTransferClaimantLocalOwner(record),
        resume: (record, recoveryOptions) => this.claimants.resume(record, recoveryOptions),
      },
    );
    this.transferRecovery.register(options.lifecycle);
    this.claimantRecovery.register(options.lifecycle);
  }

  async bindLanToCloudSource(
    input: BindLanToCloudSourceInput,
    options: CollabOperationOptions = {},
  ): Promise<AuthorityTransferDirectionBinding<LanToCloudSourceCoordinator>> {
    return this.#bindLanToCloudSource(input, options, null);
  }

  async #bindLanToCloudSource(
    input: BindLanToCloudSourceInput,
    options: CollabOperationOptions,
    ownedConnection: CloudAuthorityConnection | null,
  ): Promise<AuthorityTransferDirectionBinding<LanToCloudSourceCoordinator>> {
    throwIfCancelled(options.signal);
    this.#assertCloudSession(input.projectId, input.cloudSession);
    const sourceEntry = await this.options.persistence.loadSourceEntry(input.projectId);
    throwIfCancelled(options.signal);
    const record = sourceEntry ? null : await this.options.persistence.load(input.projectId);
    throwIfCancelled(options.signal);
    const expectedAuthorityGeneration = sourceEntry?.request.expectedAuthorityGeneration
      ?? (record?.localRole === 'source'
        ? record.status.sourceAuthority.generation
        : undefined);
    if (expectedAuthorityGeneration === undefined) {
      throw moduleError('authority-transfer-source-owner-unavailable');
    }
    await this.#assertLanToCloudSourceOwner(
      input.projectId,
      expectedAuthorityGeneration,
    );
    throwIfCancelled(options.signal);
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
    let cleanupRoute: () => Promise<void> = async () => undefined;
    const binding: SourceBinding = {
      owner: bindingOwner(sourceEntry?.request.idempotencyKey ?? record!.operationIntentId, sourceEntry?.status ?? record!.status),
      ownedConnection,
      cleanupRoute: () => cleanupRoute(),
      coordinator,
      targetUrl: persistedTargetUrl,
    };
    this.sourceBindings.set(input.projectId, binding);
    try {
      cleanupRoute = await this.options.activateLanToCloudSourceRoute?.(
        input.projectId,
        options,
      ) ?? (async () => undefined);
    } catch (error) {
      this.sourceBindings.delete(input.projectId);
      throw error;
    }
    if (options.signal?.aborted) {
      await this.#disposeLanToCloudSourceBinding(input.projectId, binding);
      throwIfCancelled(options.signal);
    }
    return Object.freeze({
      coordinator,
      dispose: () => this.#disposeLanToCloudSourceBinding(input.projectId, binding),
    });
  }

  createLanToCloudRequester(
    input: CreateLanToCloudRequesterInput,
  ): LanToCloudRequesterCoordinator {
    return new LanToCloudRequesterCoordinator({
      authorityGeneration: input.authorityGeneration,
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
    if (!entry) return null;
    const record = entry.phase === 'handed-off'
      ? await this.options.persistence.load(projectId)
      : null;
    if (entry.phase === 'handed-off' && !record) {
      throw moduleError('authority-transfer-source-successor-missing');
    }
    if (
      record
      && (record.transferId !== entry.status.transferId
        || record.operationIntentId !== entry.request.idempotencyKey)
    ) throw moduleError('authority-transfer-source-successor-mismatch');
    return Object.freeze({
      beginSubmission: entry.beginSubmission,
      cancellation: entry.cancellation,
      proposedByMemberId: entry.proposedByMemberId,
      request: entry.request,
      status: record?.status ?? entry.status,
    });
  }

  async readLanToCloudTransfer(
    projectId: CollabProjectId,
  ): Promise<LanToCloudTransferView | null> {
    const [source, requester] = await Promise.all([
      this.options.persistence.loadSourceEntry(projectId),
      this.options.persistence.loadRequesterEntry(projectId, this.options.installationKey),
    ]);
    const entry = source ?? requester;
    if (!entry) return null;
    const record = source?.phase === 'handed-off'
      ? await this.options.persistence.load(projectId)
      : null;
    if (source?.phase === 'handed-off' && !record) {
      throw moduleError('authority-transfer-source-successor-missing');
    }
    if (
      source
      && record
      && (record.transferId !== source.status.transferId
        || record.operationIntentId !== source.request.idempotencyKey)
    ) throw moduleError('authority-transfer-source-successor-mismatch');
    return Object.freeze({
      entryRole: entry.entryRole,
      proposedByMemberId: entry.proposedByMemberId,
      request: entry.request,
      status: record?.status ?? entry.status,
    });
  }

  async readCloudToLanTransfer(
    projectId: CollabProjectId,
  ): Promise<CollabCloudToLanTransferView | null> {
    const [manager, target, physical] = await Promise.all([
      this.options.persistence.loadCloudToLanManagerEntry(projectId),
      this.options.persistence.loadCloudToLanTargetEntry(projectId),
      this.options.persistence.load(projectId),
    ]);
    const activeManager = manager
      && manager.phase !== 'rejected'
      && manager.phase !== 'settled'
      ? manager
      : null;
    const activeTarget = target && target.phase !== 'withdrawn' ? target : null;
    if (!activeManager && !activeTarget) return null;
    const targetHandle = activeTarget?.phase === 'handed-off'
      && activeTarget.descriptor
      && activeTarget.successor
      ? Object.freeze({
          operationIntentId: activeTarget.successor.operationIntentId,
          preparationId: activeTarget.descriptor.preparationId,
          projectId: activeTarget.projectId,
          schemaVersion: activeTarget.descriptor.schemaVersion,
          selectedTargetMemberId: activeTarget.selectedTargetMemberId,
          sourceAuthorityGeneration: activeTarget.sourceAuthorityGeneration,
          sourceCloudUrl: activeTarget.sourceCloudUrl,
          targetUrl: activeTarget.descriptor.targetUrl,
          transferId: activeTarget.successor.transferId,
        })
      : null;
    const targetStatus = targetHandle
      && physical?.transferId === targetHandle.transferId
      && physical.operationIntentId === targetHandle.operationIntentId
      ? physical.status
      : null;
    return Object.freeze({
      manager: activeManager
        ? Object.freeze({
            descriptor: activeManager.descriptor,
            handle: activeManager.status ? cloudToLanTransferHandle(activeManager) : null,
            status: activeManager.status,
          })
        : null,
      target: activeTarget
        ? Object.freeze({
            canWithdraw: activeTarget.phase === 'published',
            descriptor: activeTarget.descriptor,
            handle: targetHandle,
            status: targetStatus,
          })
        : null,
    });
  }

  async #bindOwnedLanToCloudSource(
    request: AcceptLanToCloudTransferTargetRequest,
    options: CollabOperationOptions,
  ): Promise<void> {
    const createConnection = this.options.createLanToCloudConnection;
    if (!createConnection) throw moduleError('authority-transfer-source-runtime-unavailable');
    const entry = await this.options.persistence.loadSourceEntry(request.projectId);
    if (!entry || entry.status.transferId !== request.transferId
      || entry.request.expectedAuthorityGeneration !== request.expectedAuthorityGeneration
      || entry.request.targetUrl !== request.targetUrl) {
      throw moduleError('authority-transfer-source-proposal-stale');
    }
    throwIfCancelled(options.signal);
    const connection = await createConnection({
      allowCredentialCreation: entry.beginSubmission !== 'possibly-sent',
      projectId: request.projectId,
      serverUrl: entry.request.targetUrl,
    }, options);
    try {
      await this.#bindLanToCloudSource({
        cloudSession: connection,
        expectedTargetUrl: entry.request.targetUrl,
        projectId: request.projectId,
      }, options, connection);
    } catch (error) {
      connection.dispose();
      throw error;
    }
  }

  acceptLanToCloudTransferTarget(
    request: AcceptLanToCloudTransferTargetRequest,
    sourceInput?: BindLanToCloudSourceInput,
    options: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus> {
    return this.options.lifecycle.runExclusive(
      request.projectId,
      'authority-transfer',
      'continuation',
      async () => {
        throwIfCancelled(options.signal);
        await this.#assertLanToCloudSourceOwner(
          request.projectId,
          request.expectedAuthorityGeneration,
        );
        throwIfCancelled(options.signal);
        let binding = this.sourceBindings.get(request.projectId);
        if (!binding && sourceInput) {
          if (sourceInput.projectId !== request.projectId) {
            throw moduleError('authority-transfer-source-runtime-mismatch');
          }
          await this.bindLanToCloudSource(sourceInput, options);
          binding = this.sourceBindings.get(request.projectId);
        } else if (!binding) {
          await this.#bindOwnedLanToCloudSource(request, options);
          binding = this.sourceBindings.get(request.projectId);
        }
        throwIfCancelled(options.signal);
        if (!binding) throw moduleError('authority-transfer-source-runtime-unavailable');
        if (binding.owner.transferId !== request.transferId
          || binding.owner.sourceAuthorityGeneration !== request.expectedAuthorityGeneration) {
          throw moduleError('authority-transfer-runtime-owner-mismatch');
        }
        if (binding.targetUrl !== request.targetUrl) {
          throw moduleError('authority-transfer-cloud-target-mismatch');
        }
        const status = await binding.coordinator.acceptAndTransfer(request, options);
        if (status.state === 'cancelled' || status.state === 'completed') {
          await this.#disposeLanToCloudSourceBinding(request.projectId, binding);
        }
        return status;
      },
    );
  }

  assertLanToCloudSourceInstallationOwner(
    projectId: CollabProjectId,
    expectedAuthorityGeneration: number,
  ): Promise<void> {
    return this.#assertLanToCloudSourceOwner(projectId, expectedAuthorityGeneration);
  }

  assertLanHostStartReady(record: AuthorityTransferRecord | null): void {
    if (
      !record
      || record.ownerInstallationKey !== this.options.installationKey
      || record.localRole !== 'target'
      || record.status.direction !== 'cloud-to-lan'
      || record.status.state !== 'completed'
      || record.terminalCleanupCompleted
    ) return;
    const ready = this.readyCloudToLanTargets.get(record.projectId);
    if (!ready || !bindingOwnerMatches(ready, record)) {
      throw moduleError('authority-transfer-target-recovery-required');
    }
  }

  cancelLanToCloudTransfer(
    request: LanToCloudCancellationIntent,
  ): Promise<CollabAuthorityTransferStatus> {
    return this.options.lifecycle.runExclusive(
      request.projectId,
      'authority-transfer',
      'continuation',
      async () => {
        await this.#assertLanToCloudSourceOwner(
          request.projectId,
          request.expectedAuthorityGeneration,
        );
        const record = await this.options.persistence.load(request.projectId);
        if (!record) {
          const status = await this.sourceProposals.cancel(request);
          const binding = this.sourceBindings.get(request.projectId);
          if (binding) await this.#disposeLanToCloudSourceBinding(request.projectId, binding);
          return status;
        }
        const binding = this.sourceBindings.get(request.projectId);
        if (binding) {
          const status = await binding.coordinator.cancel(request);
          if (status.state === 'cancelled' || status.state === 'completed') {
            await this.#disposeLanToCloudSourceBinding(request.projectId, binding);
          }
          return status;
        }
        const prepared = await this.options.persistence.prepareLanToCloudCancellation(request);
        if (prepared.terminalCleanupCompleted) return prepared.status;
        await this.runtimes.resume(prepared, {});
        const status = (await this.options.persistence.load(request.projectId))?.status
          ?? prepared.status;
        if (status.state === 'cancelled' || status.state === 'completed') {
          await this.#disposeRecoveredRuntime(prepared);
        }
        return status;
      },
    );
  }

  async #disposeLanToCloudSourceBinding(
    projectId: CollabProjectId,
    binding: SourceBinding,
  ): Promise<void> {
    if (this.sourceBindings.get(projectId) !== binding) return;
    await binding.cleanupRoute();
    if (this.sourceBindings.get(projectId) !== binding) return;
    this.sourceBindings.delete(projectId);
    binding.ownedConnection?.dispose();
  }

  async prepareCloudToLanTarget(
    input: PrepareCloudToLanTargetInput,
    options: CollabOperationOptions = {},
  ): Promise<CloudToLanTargetPreparationDescriptor> {
    return this.options.lifecycle.runExclusive(
      input.projectId,
      'authority-transfer',
      'continuation',
      () => this.#prepareCloudToLanTargetOwned(input, options),
    );
  }

  async #prepareCloudToLanTargetOwned(
    input: PrepareCloudToLanTargetInput,
    options: CollabOperationOptions,
  ): Promise<CloudToLanTargetPreparationDescriptor> {
    const retainedBinding = this.targetBindings.get(input.projectId);
    if (retainedBinding?.terminalCleanup) {
      throw durableOutcome(
        retainedBinding.terminalCleanup.handle.operationIntentId,
        'authority-transfer-target-cancellation-cleanup-incomplete',
      );
    }
    const retainedCleanup = this.targetPreparations.get(input.projectId);
    if (retainedCleanup?.cleanupOperationIntentId) {
      if (!(await this.#disposeCloudToLanTargetRuntime(input.projectId))) {
        throw durableOutcome(
          retainedCleanup.cleanupOperationIntentId,
          'authority-transfer-target-preparation-incomplete',
        );
      }
    }
    const createConnection = this.options.createCloudToLanConnection;
    const createTarget = this.options.createCloudToLanTarget;
    let existing = await this.options.persistence.loadCloudToLanTargetEntry(
      input.projectId,
    );
    if (existing
      && existing.ownerInstallationKey !== this.options.installationKey) {
      throw moduleError('host-installation-recovery-owner-mismatch');
    }
    if (
      existing
      && existing.operationIntentId !== input.operationIntentId
      && existing.phase === 'withdrawn'
    ) {
      if (
        this.targetBindings.has(input.projectId)
        || this.targetPreparations.has(input.projectId)
      ) {
        throw durableOutcome(
          existing.operationIntentId,
          'authority-transfer-target-withdrawal-cleanup-incomplete',
        );
      }
      existing = null;
    }
    const retainedPreparation = this.targetPreparations.get(input.projectId);
    if (existing?.phase === 'published' && existing.descriptor && retainedPreparation) {
      return existing.descriptor;
    }
    const connection = await createConnection(input.projectId, options);
    let durableOperationId = existing?.operationIntentId ?? null;
    let keepConnection = false;
    let createdTarget: CloudToLanTargetCoordinatorOptions['target'] | null = null;
    try {
      if (!connection.supports('authority-transfer')) {
        throw moduleError('authority-transfer-cloud-capability-unavailable');
      }
      let entry = existing;
      if (!entry) {
        const snapshot = await connection.readSnapshot(input.projectId, options);
        this.#assertCloudToLanConnectionIdentity(connection, snapshot);
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
        this.#assertCloudToLanTargetConnection(entry, connection);
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
          'authority-transfer-target-preparation-incomplete', error,
        );
      }
      throw error;
    } finally {
      if (!keepConnection) {
        const [cleanup] = await Promise.allSettled([
          disposeCloudToLanTargetPreparation(connection, createdTarget),
        ]);
        if (
          cleanup?.status === 'rejected'
          && createdTarget
          && durableOperationId !== null
        ) {
          this.targetPreparations.set(input.projectId, {
            cleanupOperationIntentId: durableOperationId,
            connection,
            target: createdTarget,
          });
        }
      }
    }
  }

  async beginCloudToLanTransfer(
    input: BeginCloudToLanTransferInput,
    options: CollabOperationOptions = {},
  ): Promise<CloudToLanTransferHandle> {
    const descriptor = decodeCloudToLanTargetPreparationDescriptor(input.descriptor);
    return this.options.lifecycle.runAuthorityTransferManagerContinuation(
      descriptor.projectId,
      () => this.#beginCloudToLanTransferOwned(
        descriptor,
        input.operationIntentId,
        options,
      ),
    );
  }

  async #beginCloudToLanTransferOwned(
    descriptor: CloudToLanTargetPreparationDescriptor,
    operationIntentId: string,
    options: CollabOperationOptions,
  ): Promise<CloudToLanTransferHandle> {
    const createConnection = this.options.createCloudToLanConnection;
    let entry = await this.options.persistence.loadCloudToLanManagerEntry(
      descriptor.projectId,
    );
    if (entry) this.#assertCloudToLanManagerInstallationOwner(entry);
    const claimant = await this.#loadCloudToLanManagerClaimantPredecessor(
      descriptor.projectId,
      entry,
    );
    const existingDescriptorMatches = entry !== null
      && JSON.stringify(entry.descriptor) === JSON.stringify(descriptor);
    if (entry?.phase === 'settled') {
      if (existingDescriptorMatches && entry.status) {
        const handle = cloudToLanTransferHandle(entry);
        await this.#completeSettledCloudToLanManagerEntry(entry, claimant, options);
        return handle;
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
    const connection = await createConnection(descriptor.projectId, options);
    try {
      if (!entry) {
        const [snapshot, listed] = await Promise.all([
          connection.readSnapshot(descriptor.projectId, options),
          connection.listProjectMembers({ projectId: descriptor.projectId }, options),
        ]);
        this.#assertCloudToLanConnectionIdentity(connection, snapshot);
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
            ownerInstallationKey: this.options.installationKey,
          }),
        );
      }
      if (
        JSON.stringify(entry.descriptor) !== JSON.stringify(descriptor)
      ) throw moduleError('authority-transfer-manager-entry-conflict');
      this.#assertCloudToLanManagerConnection(entry, connection);
      const wasPossiblySent = entry.phase === 'submitted';
      try {
        entry = await this.options.persistence.markCloudToLanManagerBeginPossiblySent(entry);
      } catch (error) {
        throw durableOutcome(
          entry.operationIntentId,
          'authority-transfer-manager-begin-incomplete', error,
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
            await this.#settleRejectedCloudToLanManagerEntry(entry, connection, options);
          } catch (error) {
            throw durableOutcome(
              entry.operationIntentId,
              'authority-transfer-manager-rejection-settlement-incomplete', error,
            );
          }
          throw error;
        }
        throw durableOutcome(
          entry.operationIntentId,
          'authority-transfer-manager-begin-ambiguous', error,
        );
      }
      try {
        entry = await this.options.persistence.recordCloudToLanManagerStatus(entry, status);
      } catch (error) {
        throw durableOutcome(
          entry.operationIntentId,
          'authority-transfer-manager-status-incomplete', error,
        );
      }
      const handle = cloudToLanTransferHandle(entry);
      if (entry.phase === 'settled') {
        await this.#completeCloudToLanManagerEntry(entry, connection, options);
      }
      return handle;
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
        let binding = this.targetBindings.get(handle.projectId);
        const retainedCleanup = binding?.terminalCleanup;
        if (binding && retainedCleanup) {
          if (!sameCloudToLanTransferHandle(retainedCleanup.handle, handle)) {
            throw moduleError('authority-transfer-target-handle-mismatch');
          }
          return this.#completeCancelledCloudToLanTarget(binding, retainedCleanup);
        }
        if (binding?.managedConnection?.released) binding = undefined;
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
        if (binding && (binding.owner.operationIntentId !== handle.operationIntentId
          || binding.owner.transferId !== handle.transferId
          || binding.owner.sourceAuthorityGeneration !== handle.sourceAuthorityGeneration)) {
          throw moduleError('authority-transfer-runtime-owner-mismatch');
        }
        const completed = await this.options.persistence.load(handle.projectId);
        if (completed?.status.state === 'completed') {
          await this.runtimes.resume(completed, options);
          await this.#settleMatchingCloudToLanManager(handle, completed.status);
          await this.#releaseCompletedCloudToLanRuntime(handle.projectId);
          this.readyCloudToLanTargets.set(handle.projectId, bindingOwner(completed.operationIntentId, completed.status));
          return completed.status;
        }
        if (!binding) {
          const createConnection = this.options.createCloudToLanConnection;
          const createTarget = this.options.createCloudToLanTarget;
          let preparation = this.targetPreparations.get(handle.projectId);
          if (!preparation) {
            const connection = await createConnection(handle.projectId, options);
            const retainedTarget = this.targetBindings.get(
              handle.projectId,
            )?.managedConnection?.target;
            try {
              this.#assertCloudToLanTargetConnection(entry, connection);
              preparation = {
                connection,
                target: retainedTarget ?? createTarget(handle.projectId, connection),
              };
            } catch (error) {
              connection.dispose();
              throw error;
            }
            this.targetPreparations.set(handle.projectId, preparation);
          }
          binding = this.#bindPreparedCloudToLanTarget(handle.projectId, preparation, {
            operationIntentId: handle.operationIntentId,
            sourceAuthorityGeneration: handle.sourceAuthorityGeneration,
            targetAuthorityGeneration: handle.sourceAuthorityGeneration + 1,
            transferId: handle.transferId,
          });
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
            'authority-transfer-target-acceptance-incomplete', error,
          );
          throw error;
        }
        if (status.state === 'cancelled') {
          const terminalCleanup = {
            handle,
            status,
            targetDisposed: false,
          };
          const terminalBinding: TargetBinding = {
            ...binding,
            terminalCleanup,
          };
          if (this.targetBindings.get(handle.projectId) === binding) {
            this.targetBindings.set(handle.projectId, terminalBinding);
          }
          return this.#completeCancelledCloudToLanTarget(
            terminalBinding,
            terminalCleanup,
          );
        }
        try {
          await this.#settleMatchingCloudToLanManager(handle, status);
        } catch (error) {
          throw durableOutcome(
            handle.operationIntentId,
            'authority-transfer-manager-status-incomplete', error,
          );
        }
        if (status.state === 'completed') {
          await this.#releaseCompletedCloudToLanRuntime(handle.projectId);
          this.readyCloudToLanTargets.set(handle.projectId, bindingOwner(handle.operationIntentId, status));
        }
        return status;
      },
    );
  }

  async #completeCancelledCloudToLanTarget(
    binding: TargetBinding,
    cleanup: NonNullable<TargetBinding['terminalCleanup']>,
  ): Promise<CollabAuthorityTransferStatus> {
    const { handle, status } = cleanup;
    let managerSettlementFailed = false;
    try {
      await this.#settleMatchingCloudToLanManager(handle, status);
    } catch {
      managerSettlementFailed = true;
    }
    let targetCleanupFailed = false;
    if (!cleanup.targetDisposed) {
      try {
        await binding.dispose();
        cleanup.targetDisposed = true;
      } catch {
        targetCleanupFailed = true;
      }
    }
    if (!managerSettlementFailed && !targetCleanupFailed) {
      if (this.targetBindings.get(handle.projectId) === binding) {
        this.targetBindings.delete(handle.projectId);
      }
      return status;
    }
    throw durableOutcome(
      handle.operationIntentId,
      targetCleanupFailed
        ? 'authority-transfer-target-cancellation-cleanup-incomplete'
        : 'authority-transfer-manager-status-incomplete',
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
        if (!binding && !preparation) return;
        if (!(await this.#disposeCloudToLanTargetRuntime(input.projectId))) {
          throw durableOutcome(
            entry.operationIntentId,
            'authority-transfer-target-withdrawal-cleanup-incomplete',
          );
        }
      },
    );
  }

  async #releaseCompletedCloudToLanRuntime(projectId: CollabProjectId): Promise<void> {
    const record = await this.options.persistence.load(projectId);
    if (
      record?.localRole !== 'target'
      || record.status.direction !== 'cloud-to-lan'
      || record.status.state !== 'completed'
      || record.status.relinquishmentProof === null
      || record.restartFence !== 'open'
    ) return;
    const binding = this.targetBindings.get(projectId);
    if (binding && !bindingOwnerMatches(binding.owner, record)) {
      throw moduleError('authority-transfer-runtime-owner-mismatch');
    }
    if (!await this.#disposeCloudToLanTargetRuntime(projectId)) {
      throw durableOutcome(record.operationIntentId, 'authority-transfer-target-cleanup-incomplete');
    }
  }

  async #disposeCloudToLanTargetRuntime(projectId: CollabProjectId): Promise<boolean> {
    const binding = this.targetBindings.get(projectId);
    const preparation = this.targetPreparations.get(projectId);
    const [bindingResult, preparationResult] = await Promise.allSettled([
      binding?.dispose() ?? Promise.resolve(),
      preparation
        ? disposeCloudToLanTargetPreparation(preparation.connection, preparation.target)
        : Promise.resolve(),
    ]);
    if (bindingResult.status === 'fulfilled' && this.targetBindings.get(projectId) === binding) {
      this.targetBindings.delete(projectId);
    }
    if (
      preparationResult.status === 'fulfilled'
      && this.targetPreparations.get(projectId) === preparation
    ) {
      this.targetPreparations.delete(projectId);
    }
    return bindingResult.status === 'fulfilled' && preparationResult.status === 'fulfilled';
  }

  async observeCloudToLanTransfer(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus> {
    return this.options.lifecycle.runAuthorityTransferManagerContinuation(
      projectId,
      () => this.#observeCloudToLanTransferOwned(projectId, options),
    );
  }

  async #observeCloudToLanTransferOwned(
    projectId: CollabProjectId,
    options: CollabOperationOptions,
  ): Promise<CollabAuthorityTransferStatus> {
    const entry = await this.options.persistence.loadCloudToLanManagerEntry(projectId);
    if (entry) this.#assertCloudToLanManagerInstallationOwner(entry);
    if (!entry?.status) {
      throw moduleError('authority-transfer-manager-status-missing');
    }
    const claimant = await this.#loadCloudToLanManagerClaimantPredecessor(projectId, entry);
    if (entry.phase === 'settled') {
      await this.#completeSettledCloudToLanManagerEntry(entry, claimant, options);
      return entry.status;
    }
    const connection = await this.#requireCloudToLanManagerConnection(entry, options);
    try {
      const status = await connection.lifecycle.authorityTransfer(
        'getProjectAuthorityTransfer',
        { projectId, transferId: entry.status.transferId },
        options,
      );
      const observed = await this.options.persistence.recordCloudToLanManagerStatus(entry, status);
      if (observed.phase === 'settled') {
        await this.#completeCloudToLanManagerEntry(observed, connection, options);
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
    return this.options.lifecycle.runExclusive(
      handle.projectId,
      'authority-transfer',
      'continuation',
      () => this.#cancelCloudToLanTransferOwned(handle, options),
    );
  }

  async #cancelCloudToLanTransferOwned(
    handle: CloudToLanTransferHandle,
    options: CollabOperationOptions,
  ): Promise<CollabAuthorityTransferStatus> {
    const projectId = handle.projectId;
    let entry = await this.#requireCloudToLanManagerStatus(projectId);
    this.#assertCloudToLanManagerInstallationOwner(entry);
    if (!sameCloudToLanTransferHandle(cloudToLanTransferHandle(entry), handle)) {
      throw moduleError('authority-transfer-manager-handle-mismatch');
    }
    const connection = await this.#requireCloudToLanManagerConnection(entry, options);
    try {
      if (entry.cancellation === null) {
        const current = await connection.lifecycle.authorityTransfer(
          'getProjectAuthorityTransfer',
          { projectId, transferId: entry.status!.transferId },
          options,
        );
        entry = await this.options.persistence.recordCloudToLanManagerStatus(entry, current);
        if (entry.phase === 'settled') {
          await this.#completeCloudToLanManagerEntry(entry, connection, options);
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
      } catch (error) {
        throw durableOutcome(
          entry.operationIntentId,
          'authority-transfer-manager-cancellation-incomplete', error,
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
        } catch (error) {
          throw durableOutcome(
            entry.operationIntentId,
            'authority-transfer-manager-cancellation-status-incomplete', error,
          );
        }
        if (observed.phase === 'settled') {
          await this.#completeCloudToLanManagerEntry(observed, connection, options);
        }
        return cancelled;
      } catch (error) {
        if (error instanceof CollabAuthorityTransferOutcomeError) throw error;
        if (!(error instanceof CloudAuthorityRejection)) {
          throw durableOutcome(
            entry.operationIntentId,
            'authority-transfer-manager-cancellation-ambiguous', error,
          );
        }
        let observed: CollabAuthorityTransferStatus;
        try {
          observed = await connection.lifecycle.authorityTransfer(
            'getProjectAuthorityTransfer',
            { projectId, transferId: entry.status!.transferId },
            options,
          );
        } catch (error) {
          throw durableOutcome(
            entry.operationIntentId,
            'authority-transfer-manager-cancellation-observation-incomplete', error,
          );
        }
        if (observed.phase === entry.status!.phase) throw error;
        let advanced: CloudToLanManagerEntryRecord;
        try {
          advanced = await this.options.persistence.recordCloudToLanManagerStatus(
            entry,
            observed,
          );
        } catch (error) {
          throw durableOutcome(
            entry.operationIntentId,
            'authority-transfer-manager-cancellation-status-incomplete', error,
          );
        }
        if (advanced.phase === 'settled') {
          await this.#completeCloudToLanManagerEntry(advanced, connection, options);
        }
        return observed;
      }
    } finally {
      connection.dispose();
    }
  }

  async #disposeRecoveredRuntime(record: AuthorityTransferRecord): Promise<void> {
    const target = this.targetBindings.get(record.projectId);
    if (target && (record.localRole !== 'target' || !bindingOwnerMatches(target.owner, record))) {
      throw moduleError('authority-transfer-runtime-owner-mismatch');
    }
    if (
      record.localRole === 'target'
      && record.status.direction === 'cloud-to-lan'
      && !await this.#disposeCloudToLanTargetRuntime(record.projectId)
    ) throw durableOutcome(record.operationIntentId, 'authority-transfer-target-cleanup-incomplete');
    const source = this.sourceBindings.get(record.projectId);
    if (source) {
      if (record.localRole !== 'source' || !bindingOwnerMatches(source.owner, record)) {
        throw moduleError('authority-transfer-runtime-owner-mismatch');
      }
      await this.#disposeLanToCloudSourceBinding(record.projectId, source);
    }
  }

  async #resumeCloudToLanManagerEntry(
    projectId: CollabProjectId,
    options: CollabOperationOptions,
  ): Promise<void> {
    let entry = await this.options.persistence.loadCloudToLanManagerEntry(projectId);
    if (!entry) return;
    if (entry.ownerInstallationKey !== this.options.installationKey) return;
    const claimant = await this.#loadCloudToLanManagerClaimantPredecessor(projectId, entry);
    if (entry.phase === 'rejected') {
      await this.options.persistence.settleCloudToLanManagerEntry(entry);
      return;
    }
    const physical = await this.options.persistence.load(projectId);
    if (physical?.ownerInstallationKey === this.options.installationKey) {
      if (!this.#cloudToLanManagerMatchesPhysical(entry, physical)) {
        throw moduleError('authority-transfer-manager-physical-mismatch');
      }
      return;
    }
    if (entry.phase === 'settled') {
      await this.#completeSettledCloudToLanManagerEntry(entry, claimant, options);
      return;
    }
    const connection = await this.#requireCloudToLanManagerConnection(entry, options);
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
          await this.#settleRejectedCloudToLanManagerEntry(entry, connection, options);
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
        await this.#completeCloudToLanManagerEntry(observed, connection, options);
      }
    } finally {
      connection.dispose();
    }
  }

  async #resumeAuthorityTransferRecord(
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
      try {
        await this.runtimes.resume(record, options);
      } finally {
        if (record.localRole === 'target' && record.status.direction === 'cloud-to-lan') {
          this.targetBindings.get(record.projectId)?.managedConnection?.release();
        }
      }
    }
    await this.#releaseCompletedCloudToLanRuntime(record.projectId);
    const current = await this.options.persistence.load(record.projectId);
    if (current && (
      current.status.state === 'cancelled'
      || (current.localRole === 'source' && current.status.state === 'completed')
    )) {
      await this.#disposeRecoveredRuntime(current);
    }
    if (
      current
      && current.localRole === 'target'
      && current.status.direction === 'cloud-to-lan'
      && (current.status.state === 'cancelled' || current.status.state === 'completed')
    ) await this.#settleRecoveredCloudToLanManager(current);
    if (
      current
      && current.ownerInstallationKey === this.options.installationKey
      && current.localRole === 'target'
      && current.status.direction === 'cloud-to-lan'
      && current.status.state === 'completed'
      && !current.terminalCleanupCompleted
    ) this.readyCloudToLanTargets.set(current.projectId, bindingOwner(current.operationIntentId, current.status));
  }

  async #settleRecoveredCloudToLanManager(
    record: AuthorityTransferRecord,
  ): Promise<void> {
    const entry = await this.options.persistence.loadCloudToLanManagerEntry(record.projectId);
    if (!entry?.status) return;
    if (!this.#cloudToLanManagerMatchesPhysical(entry, record)) {
      throw moduleError('authority-transfer-manager-physical-mismatch');
    }
    await this.#settleMatchingCloudToLanManager(
      cloudToLanTransferHandle(entry),
      record.status,
    );
  }

  #bindPreparedCloudToLanTarget(
    projectId: CollabProjectId,
    preparation: TargetPreparationBinding,
    owner: AuthorityTransferBindingOwner,
  ): TargetBinding {
    const retained = this.targetBindings.get(projectId);
    if (
      this.sourceBindings.has(projectId)
      || (retained !== undefined && (
        !retained.managedConnection?.released
        || retained.managedConnection.target !== preparation.target
      ))
    ) {
      throw moduleError('authority-transfer-direction-runtime-conflict');
    }
    const coordinator = new CloudToLanTargetCoordinator({
      cloud: preparation.connection.lifecycle,
      installationKey: this.options.installationKey,
      persistence: this.options.persistence,
      target: preparation.target,
    });
    const managedConnection = {
      released: false,
      release: () => {
        if (managedConnection.released) return;
        managedConnection.released = true;
        preparation.connection.dispose();
      },
      target: preparation.target,
    };
    const binding: TargetBinding = {
      owner,
      coordinator,
      dispose: async () => {
        managedConnection.release();
        await preparation.target.dispose?.();
      },
      managedConnection,
    };
    this.targetBindings.set(projectId, binding);
    this.targetPreparations.delete(projectId);
    return binding;
  }

  #cloudToLanManagerMatchesPhysical(
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

  async #assertClaimantManagerPredecessor(
    claimant: AuthorityTransferClaimantRecord,
  ): Promise<'skip' | void> {
    const isCloudToLanManagerClaimant = claimant.variant === 'source-issued'
      && claimant.status.direction === 'cloud-to-lan';
    if (
      isCloudToLanManagerClaimant
      && claimant.managerPredecessor?.ownerInstallationKey
      !== this.options.installationKey
    ) return 'skip';
    const entry = await this.options.persistence.loadCloudToLanManagerEntry(claimant.projectId);
    if (entry && entry.phase !== 'settled') {
      throw moduleError('authority-transfer-manager-observer-pending');
    }
    if (entry && !this.#cloudToLanManagerMatchesClaimant(entry, claimant)) {
      throw moduleError('authority-transfer-claimant-attempt-conflict');
    }
    if (!isCloudToLanManagerClaimant) return;
    if (!await this.#isCloudToLanManagerClaimantCompletionOwner(claimant)) return 'skip';
  }

  async #isAuthorityTransferClaimantLocalOwner(
    claimant: AuthorityTransferClaimantRecord,
  ): Promise<boolean> {
    if (
      claimant.variant !== 'source-issued'
      || claimant.status.direction !== 'cloud-to-lan'
    ) return true;
    return claimant.managerPredecessor?.ownerInstallationKey
      === this.options.installationKey
      && this.#isCloudToLanManagerClaimantCompletionOwner(claimant);
  }

  async #assertCloudToLanManagerSettled(projectId: CollabProjectId): Promise<void> {
    const entry = await this.options.persistence.loadCloudToLanManagerEntry(projectId);
    if (entry && entry.phase !== 'settled') {
      throw moduleError('authority-transfer-manager-observer-pending');
    }
  }

  async #settleMatchingCloudToLanManager(
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
    const locallyOwned = entry.ownerInstallationKey === this.options.installationKey;
    if (entry.phase === 'settled') {
      if (cloudToLanManagerRequiresClaimant(entry) || !locallyOwned) return;
      await this.options.persistence.settleCloudToLanManagerEntry(entry);
      return;
    }
    if (entry.phase !== 'submitted' && entry.phase !== 'observing') return;
    const observed = await this.options.persistence.recordCloudToLanManagerStatus(entry, status);
    if (
      observed.phase === 'settled'
      && !cloudToLanManagerRequiresClaimant(observed)
      && locallyOwned
    ) {
      await this.options.persistence.settleCloudToLanManagerEntry(observed);
    }
  }

  async #requireCloudToLanManagerConnection(
    entry: NonNullable<Awaited<ReturnType<AuthorityTransferPersistence['loadCloudToLanManagerEntry']>>>,
    options: CollabOperationOptions,
  ): Promise<CloudToLanEntryConnection> {
    const createConnection = this.options.createCloudToLanConnection;
    const connection = await createConnection(entry.projectId, options);
    try {
      this.#assertCloudToLanManagerConnection(entry, connection);
      return connection;
    } catch (error) {
      connection.dispose();
      throw error;
    }
  }

  async #settleRejectedCloudToLanManagerEntry(
    entry: CloudToLanManagerEntryRecord,
    connection: CloudToLanEntryConnection,
    options: CollabOperationOptions,
  ): Promise<void> {
    const [snapshot, listed] = await Promise.all([
      connection.readSnapshot(entry.projectId, options),
      connection.listProjectMembers({ projectId: entry.projectId }, options),
    ]);
    this.#assertCloudToLanConnectionIdentity(connection, snapshot);
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

  #assertCloudToLanManagerConnection(
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

  #cloudToLanManagerMatchesClaimant(
    entry: CloudToLanManagerEntryRecord,
    claimant: AuthorityTransferClaimantRecord,
  ): boolean {
    const predecessor = claimant.variant === 'source-issued'
      ? claimant.managerPredecessor
      : null;
    return cloudToLanManagerRequiresClaimant(entry)
      && claimant.variant === 'source-issued'
      && claimant.status.direction === 'cloud-to-lan'
      && predecessor !== null
      && predecessor.initiatingPersonalRef === entry.initiatingPersonalRef
      && predecessor.operationIntentId === entry.operationIntentId
      && predecessor.ownerInstallationKey === entry.ownerInstallationKey
      && predecessor.preparationId === entry.descriptor.preparationId
      && predecessor.selectedTargetMemberId === entry.descriptor.selectedTargetMemberId
      && predecessor.sourceCloudUrl === entry.descriptor.sourceCloudUrl
      && claimant.memberId === entry.initiatingMemberId
      && claimant.operationIntentId === authorityTransferChildIdempotencyKey(
        entry.operationIntentId,
        'claims',
      )
      && claimant.projectId === entry.projectId
      && JSON.stringify(claimant.status) === JSON.stringify(entry.status)
      && claimant.lanTarget !== null
      && claimant.lanTarget.caCertificatePem === entry.descriptor.caCertificatePem
      && claimant.lanTarget.caFingerprint === entry.descriptor.caFingerprint
      && claimant.lanTarget.endpoint === entry.descriptor.targetUrl;
  }

  async #loadCloudToLanManagerClaimantPredecessor(
    projectId: CollabProjectId,
    entry: CloudToLanManagerEntryRecord | null,
  ): Promise<AuthorityTransferClaimantRecord | null> {
    const claimant = await this.options.claimantStore.load(projectId);
    if (!claimant) return null;
    if (!entry || !this.#cloudToLanManagerMatchesClaimant(entry, claimant)) {
      throw moduleError('authority-transfer-claimant-attempt-conflict');
    }
    return claimant;
  }

  async #isCloudToLanManagerClaimantHandoffEstablished(
    projectId: CollabProjectId,
  ): Promise<boolean> {
    const entry = await this.options.persistence.loadCloudToLanManagerEntry(projectId);
    if (
      !entry
      || entry.ownerInstallationKey !== this.options.installationKey
      || !cloudToLanManagerRequiresClaimant(entry)
    ) return false;
    const claimant = await this.options.claimantStore.load(projectId);
    return claimant !== null && this.#cloudToLanManagerMatchesClaimant(entry, claimant);
  }

  async #resumeCloudToLanManagerClaimant(
    entry: CloudToLanManagerEntryRecord,
    claimant: AuthorityTransferClaimantRecord | null,
    options: CollabOperationOptions,
  ): Promise<boolean> {
    if (!claimant) return false;
    if (!this.#cloudToLanManagerMatchesClaimant(entry, claimant)) {
      throw moduleError('authority-transfer-claimant-attempt-conflict');
    }
    if (!await this.#isCloudToLanManagerClaimantCompletionOwner(claimant)) return true;
    if (authorityTransferClaimantRequiresNoRuntime(claimant, this.now())) {
      await this.#completeAuthorityTransferClaimant(claimant);
    } else {
      await this.claimants.resume(claimant, options);
    }
    return true;
  }

  async #completeSettledCloudToLanManagerEntry(
    entry: CloudToLanManagerEntryRecord,
    claimant: AuthorityTransferClaimantRecord | null,
    options: CollabOperationOptions,
  ): Promise<void> {
    if (await this.#resumeCloudToLanManagerClaimant(entry, claimant, options)) return;
    if (!cloudToLanManagerRequiresClaimant(entry)) {
      await this.options.persistence.settleCloudToLanManagerEntry(entry);
      return;
    }
    if (this.now().getTime() >= Date.parse(entry.status!.expiresAt)) {
      await this.#completeCloudToLanManagerEntry(entry, null, options);
      return;
    }
    const connection = await this.#requireCloudToLanManagerConnection(entry, options);
    try {
      await this.#completeCloudToLanManagerEntry(entry, connection, options);
    } finally {
      connection.dispose();
    }
  }

  async #completeAuthorityTransferClaimant(
    claimant: AuthorityTransferClaimantRecord,
  ): Promise<void> {
    if (
      claimant.variant === 'source-issued'
      && claimant.status.direction === 'cloud-to-lan'
    ) {
      if (!await this.#isCloudToLanManagerClaimantCompletionOwner(claimant)) return;
      const entry = await this.options.persistence.loadCloudToLanManagerEntry(
        claimant.projectId,
      );
      if (entry) {
        if (!this.#cloudToLanManagerMatchesClaimant(entry, claimant)) {
          throw moduleError('authority-transfer-claimant-attempt-conflict');
        }
        await this.options.persistence.settleCloudToLanManagerEntry(entry);
      }
    }
    await this.options.claimantStore.remove(claimant.projectId);
  }

  async #isCloudToLanManagerClaimantCompletionOwner(
    claimant: AuthorityTransferClaimantRecord,
  ): Promise<boolean> {
    if (
      claimant.variant !== 'source-issued'
      || claimant.status.direction !== 'cloud-to-lan'
      || claimant.managerPredecessor === null
      || claimant.managerPredecessor.ownerInstallationKey !== this.options.installationKey
    ) return false;
    const loadMembership = this.options.loadClaimantMembership;
    if (!loadMembership) return false;
    const membership = await loadMembership(claimant.projectId);
    return membership?.member.id === claimant.memberId
      && membership.member.personalRef === claimant.managerPredecessor.initiatingPersonalRef;
  }

  async #isCloudToLanManagerEntryCompletionOwner(
    entry: CloudToLanManagerEntryRecord,
  ): Promise<boolean> {
    if (entry.ownerInstallationKey !== this.options.installationKey) return false;
    const loadMembership = this.options.loadClaimantMembership;
    if (!loadMembership) return false;
    const membership = await loadMembership(entry.projectId);
    return membership?.member.id === entry.initiatingMemberId
      && membership.member.personalRef === entry.initiatingPersonalRef;
  }

  async #completeCloudToLanManagerEntry(
    entry: CloudToLanManagerEntryRecord,
    connection: CloudToLanEntryConnection | null,
    options: CollabOperationOptions,
  ): Promise<void> {
    if (cloudToLanManagerRequiresClaimant(entry)) {
      if (!await this.#isCloudToLanManagerEntryCompletionOwner(entry)) return;
      const targetHost = {
        caCertificatePem: entry.descriptor.caCertificatePem,
        caFingerprint: entry.descriptor.caFingerprint,
        endpoint: entry.descriptor.targetUrl,
      };
      const expired = this.now().getTime() >= Date.parse(entry.status!.expiresAt);
      if (!expired && !connection) {
        throw moduleError('authority-transfer-claimant-source-unavailable');
      }
      const binding = expired
        ? this.#bindClaimant({
            convergence: {
              converge: () => {
                throw moduleError('authority-transfer-claimant-target-replay-invalid');
              },
            },
            lanTarget: targetHost,
            projectId: entry.projectId,
            source: {
              acknowledgeRedemption: () => {
                throw moduleError('authority-transfer-claimant-source-unavailable');
              },
              getClaim: () => {
                throw moduleError('authority-transfer-claimant-source-unavailable');
              },
            },
            target: {
              cloudPrincipalId: null,
              claimTransferredMembership: () => {
                throw moduleError('authority-transfer-claimant-target-replay-invalid');
              },
            },
          })
        : this.bindCloudToLanClaimant({
            cloudSession: connection!,
            lanClient: this.options.createCloudToLanClaimantClient?.({
              ...targetHost,
              projectId: entry.projectId,
            }) ?? new LanAuthorityTransferClient({ ...targetHost, projectId: entry.projectId }),
            projectId: entry.projectId,
            targetHost,
          });
      try {
        await binding.coordinator.start({
          managerPredecessor: this.#cloudToLanManagerClaimantPredecessor(entry),
          memberId: entry.initiatingMemberId,
          operationIntentId: authorityTransferChildIdempotencyKey(
            entry.operationIntentId,
            'claims',
          ),
          status: entry.status!,
        }, options);
      } finally {
        await binding.dispose();
      }
      return;
    }
    await this.options.persistence.settleCloudToLanManagerEntry(entry);
  }

  #cloudToLanManagerClaimantPredecessor(
    entry: CloudToLanManagerEntryRecord,
  ): CloudToLanManagerClaimantPredecessor {
    return Object.freeze({
      initiatingPersonalRef: entry.initiatingPersonalRef,
      operationIntentId: entry.operationIntentId,
      ownerInstallationKey: entry.ownerInstallationKey,
      preparationId: entry.descriptor.preparationId,
      selectedTargetMemberId: entry.descriptor.selectedTargetMemberId,
      sourceCloudUrl: entry.descriptor.sourceCloudUrl,
    });
  }

  #assertCloudToLanTargetConnection(
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

  #assertCloudToLanManagerInstallationOwner(
    entry: CloudToLanManagerEntryRecord,
  ): void {
    if (entry.ownerInstallationKey !== this.options.installationKey) {
      throw moduleError('host-installation-recovery-owner-mismatch');
    }
  }

  async #requireCloudToLanManagerStatus(
    projectId: CollabProjectId,
  ) {
    const entry = await this.options.persistence.loadCloudToLanManagerEntry(projectId);
    if (!entry?.status || entry.phase === 'settled') {
      throw moduleError('authority-transfer-manager-status-missing');
    }
    return entry;
  }

  #assertCloudToLanConnectionIdentity(
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
    const sourceBindings = [...this.sourceBindings.entries()];
    const targetBindings = [...this.targetBindings.values()];
    const targetPreparations = [...this.targetPreparations.values()];
    this.targetBindings.clear();
    this.targetPreparations.clear();
    const results = await Promise.allSettled([
      ...sourceBindings.map(([projectId, binding]) => (
        this.#disposeLanToCloudSourceBinding(projectId, binding)
      )),
      ...targetBindings.map(binding => binding.dispose()),
      ...targetPreparations.map(preparation => disposeCloudToLanTargetPreparation(
        preparation.connection,
        preparation.target,
      )),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) throw failure.reason;
  }

  async readPendingLanToCloudClaim(projectId: CollabProjectId): Promise<CollabPendingReconnectView | null> {
    const pending = await this.options.claimantStore.load(projectId);
    if (pending?.variant !== 'source-issued' || pending.status.direction !== 'lan-to-cloud') return null;
    return Object.freeze({
      operationId: pending.operationIntentId, projectId, serverUrl: pending.status.targetUrl,
    });
  }

  async reconnectLanToCloud(
    projectId: CollabProjectId,
    selectedServerUrl: string,
    options: CollabOperationOptions = {},
  ): Promise<boolean> {
    const loadMembership = this.options.loadClaimantMembership;
    if (!loadMembership) throw moduleError('authority-transfer-claimant-entry-unavailable');
    const membership = await loadMembership(projectId);
    const pending = await this.options.claimantStore.load(projectId);
    if ((!membership || !isCollabLocalLanMembership(membership))
      && !(pending?.variant === 'source-issued' && pending.status.direction === 'lan-to-cloud')) return false;
    const serverUrl = validateCloudServerUrl(selectedServerUrl, 'serverUrl');
    return this.options.lifecycle.runExclusive(
      projectId, this.claimantRecovery.durableOwner.name, 'continuation',
      async () => {
        throwIfCancelled(options.signal);
        const current = await loadMembership(projectId);
        if (!current) throw moduleError('authority-transfer-claimant-membership-invalid');
        const retained = await this.options.claimantStore.load(projectId);
        let targetGeneration: number;
        if (retained) {
          if (retained.variant !== 'source-issued'
            || retained.status.direction !== 'lan-to-cloud'
            || retained.status.targetUrl !== serverUrl
            || retained.memberId !== current.member.id) {
            throw moduleError('authority-transfer-claimant-attempt-conflict');
          }
          targetGeneration = retained.status.targetAuthority.generation;
          if (authorityTransferClaimantRequiresNoRuntime(retained, this.now())) {
            await this.#completeAuthorityTransferClaimant(retained);
          } else {
            await this.claimants.resume(retained, options);
          }
        } else {
          if (!isCollabLocalLanMembership(current) || current.hostOwnership.ownsAuthority
            || !current.authority.endpoint || !current.authority.hostCaCertificatePem
            || !current.authority.hostCaFingerprint) {
            throw moduleError('authority-transfer-claimant-source-invalid');
          }
          const trust = {
            authorityGeneration: current.authority.authorityGeneration,
            caCertificatePem: current.authority.hostCaCertificatePem,
            caFingerprint: current.authority.hostCaFingerprint,
            endpoint: current.authority.endpoint,
            projectId,
          };
          const lanClient = this.options.createLanToCloudClaimantClient?.(trust)
            ?? new LanAuthorityTransferClient(trust);
          const status = await lanClient.readCurrentTransferStatus(current.member.credential, options);
          if (status.projectId !== projectId || status.direction !== 'lan-to-cloud'
            || status.state !== 'completed' || status.sourceAuthority.kind !== 'lan'
            || status.sourceAuthority.generation !== current.authority.authorityGeneration
            || status.targetAuthority.kind !== 'cloud'
            || status.targetUrl !== serverUrl) {
            throw moduleError('authority-transfer-claimant-source-mismatch');
          }
          if (this.now().getTime() >= Date.parse(status.expiresAt)) {
            throw moduleError('authority-transfer-claimant-expired');
          }
          const createConnection = this.options.createLanToCloudConnection;
          if (!createConnection) throw moduleError('authority-transfer-claimant-entry-unavailable');
          throwIfCancelled(options.signal);
          const cloudSession = await createConnection({ projectId, serverUrl, allowCredentialCreation: true }, options);
          try {
            const binding = this.bindLanToCloudClaimant({
              cloudSession, lanClient, memberCredential: current.member.credential, projectId,
            });
            try {
              await binding.coordinator.start({
                memberId: current.member.id, operationIntentId: `claim-${randomUUID()}`, status,
              }, options);
            } finally {
              await binding.dispose();
            }
          } finally {
            cloudSession.dispose();
          }
          targetGeneration = status.targetAuthority.generation;
        }
        const claimed = await loadMembership(projectId);
        if (!claimed || !isCollabLocalCloudMembership(claimed)
          || claimed.authority.authorityGeneration !== targetGeneration
          || claimed.authority.serverUrl !== serverUrl || claimed.member.id !== current.member.id) {
          throw moduleError('authority-transfer-claimant-not-converged');
        }
        return true;
      },
    ).catch(async error => {
      const retained = await this.readPendingLanToCloudClaim(projectId);
      if (retained?.serverUrl === serverUrl) {
        throw durableOutcome(retained.operationId, 'authority-transfer-claimant-recovery-required', error);
      }
      throw error;
    });
  }

  bindLanToCloudClaimant(
    input: BindLanToCloudClaimantInput,
  ): AuthorityTransferDirectionBinding<AuthorityTransferClaimantCoordinator> {
    this.#assertCloudSession(input.projectId, input.cloudSession);
    return this.#bindClaimant({
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
              idempotencyKey: authorityTransferChildIdempotencyKey(
                record.operationIntentId,
                'source-ack',
              ),
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
        cloudPrincipalId: input.cloudSession.principalId,
        confirmCloudTargetBinding: (record, options) => this.#confirmSourceIssuedCloudTarget(record, input.cloudSession, options),
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
    this.#assertCloudSession(input.projectId, input.cloudSession);
    return this.#bindClaimant({
      convergence: {
        converge: async (record, options) => {
          if (record.variant !== 'manager-reissued' || !record.targetStatus) {
            throw moduleError('authority-transfer-claimant-variant-invalid');
          }
          if (record.serverUrl !== input.cloudSession.serverUrl) {
            throw moduleError('authority-transfer-cloud-binding-mismatch');
          }
          const snapshot = await input.cloudSession.readSnapshot(record.projectId, options);
          this.#assertManagerReissuedTarget(record, record.targetStatus, snapshot);
          await this.convergence.lanToCloudMember({
            snapshot,
            status: record.targetStatus,
          });
        },
      },
      projectId: input.projectId,
      lanTarget: null,
      target: {
        cloudPrincipalId: input.cloudSession.principalId,
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
          this.#assertManagerReissuedTarget(record, status, snapshot);
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
      () => this.#redeemManagerReissuedClaimOwned(invitation, options),
    );
  }

  async #redeemManagerReissuedClaimOwned(
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
      allowCredentialCreation: await this.options.claimantStore.load(invitation.claim.projectId) === null,
      projectId: invitation.claim.projectId,
      serverUrl: invitation.serverUrl,
    }, options);
    try {
      await this.#assertCloudToLanManagerSettled(invitation.claim.projectId);
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
    this.#assertCloudAuthorityTransferSession(input.projectId, input.cloudSession);
    return this.#bindClaimant({
      convergence: {
        converge: (record, options) => this.#convergeCloudToLanClaimant(record, input.targetHost, options),
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
              idempotencyKey: authorityTransferChildIdempotencyKey(
                record.operationIntentId,
                'source-ack',
              ),
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
        cloudPrincipalId: null,
        claimTransferredMembership: (_record, request, options) => {
          if (!('credentialHash' in request) || request.credentialHash === undefined) {
            throw moduleError('authority-transfer-lan-claim-credential-missing');
          }
          return input.lanClient.claimTransferredMembership(request, options);
        },
      },
    });
  }

  #bindLanToCloudTargetOnlyClaimant(input: Readonly<{
    readonly cloudSession: CloudAuthorityConnection;
    readonly projectId: CollabProjectId;
  }>): AuthorityTransferDirectionBinding<AuthorityTransferClaimantCoordinator> {
    this.#assertCloudSession(input.projectId, input.cloudSession);
    return this.#bindClaimant({
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
        cloudPrincipalId: input.cloudSession.principalId,
        confirmCloudTargetBinding: (record, options) => this.#confirmSourceIssuedCloudTarget(record, input.cloudSession, options),
        claimTransferredMembership: () => {
          throw moduleError('authority-transfer-claimant-target-replay-invalid');
        },
      },
    });
  }

  #bindCloudToLanTargetOnlyClaimant(input: Readonly<{
    readonly projectId: CollabProjectId;
    readonly targetHost: BindCloudToLanClaimantInput['targetHost'];
  }>): AuthorityTransferDirectionBinding<AuthorityTransferClaimantCoordinator> {
    return this.#bindClaimant({
      convergence: {
        converge: (record, options) => this.#convergeCloudToLanClaimant(record, input.targetHost, options),
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
        cloudPrincipalId: null,
        claimTransferredMembership: () => {
          throw moduleError('authority-transfer-claimant-target-replay-invalid');
        },
      },
    });
  }

  #bindLocalOnlyClaimant(
    record: AuthorityTransferClaimantRecord,
  ): AuthorityTransferDirectionBinding<AuthorityTransferClaimantCoordinator> {
    return this.#bindClaimant({
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
        cloudPrincipalId: null,
        claimTransferredMembership: () => {
          throw moduleError('authority-transfer-claimant-target-replay-invalid');
        },
      },
    });
  }

  #bindClaimant(
    input: BindAuthorityTransferClaimantInput,
  ): AuthorityTransferDirectionBinding<AuthorityTransferClaimantCoordinator> {
    const coordinator = new AuthorityTransferClaimantCoordinator({
      complete: record => this.#completeAuthorityTransferClaimant(record),
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

  #requireTargetCredential(record: AuthorityTransferClaimantRecord): string {
    if (record.variant !== 'source-issued' || !record.targetCredential) {
      throw moduleError('authority-transfer-claimant-target-credential-missing');
    }
    return record.targetCredential;
  }

  async #confirmSourceIssuedCloudTarget(
    record: SourceIssuedAuthorityTransferClaimantRecord,
    session: CloudAuthorityConnection,
    options: CollabOperationOptions,
  ): Promise<void> {
    if (session.principalId !== record.cloudPrincipalId || session.serverUrl !== record.status.targetUrl) {
      throw moduleError('authority-transfer-claimant-target-binding-invalid');
    }
    const status = await session.lifecycle.authorityTransfer('getProjectAuthorityTransfer', {
      projectId: record.projectId, transferId: record.transferId,
    }, options);
    const snapshot = await session.readSnapshot(record.projectId, options);
    const membership = await this.options.loadClaimantMembership?.(record.projectId);
    if (!membership || membership.member.id !== record.memberId
      || status.direction !== 'lan-to-cloud' || status.state !== 'completed' || status.phase !== 'completed'
      || status.projectId !== record.projectId || status.transferId !== record.transferId
      || status.sourceAuthority.generation !== record.status.sourceAuthority.generation
      || status.targetAuthority.generation !== record.status.targetAuthority.generation
      || status.targetUrl !== record.status.targetUrl
      || status.checkpointSha256 !== record.status.checkpointSha256
      || JSON.stringify(status.relinquishmentProof) !== JSON.stringify(record.status.relinquishmentProof)
      || snapshot.project.id !== record.projectId || snapshot.project.authorityKind !== 'cloud'
      || snapshot.project.authorityGeneration !== record.status.targetAuthority.generation
      || snapshot.currentMember.id !== record.memberId
      || snapshot.currentMember.personalRef !== membership.member.personalRef) {
      throw moduleError('authority-transfer-claimant-target-binding-invalid');
    }
  }

  #assertManagerReissuedTarget(
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

  async #convergeCloudToLanClaimant(
    record: AuthorityTransferClaimantRecord,
    targetHost: BindCloudToLanClaimantInput['targetHost'],
    options: CollabOperationOptions,
  ): Promise<void> {
    if (record.variant !== 'source-issued') throw moduleError('authority-transfer-claimant-variant-invalid');
    const generation = record.status.targetAuthority.generation;
    const control = this.options.createLanTargetSnapshotReader?.(record.projectId, targetHost, generation)
      ?? new LanAuthorityTransferTargetSnapshotReader({ ...targetHost, authorityGeneration: generation, projectId: record.projectId });
    const targetCredential = this.#requireTargetCredential(record);
    const snapshot = await control.readSnapshot(record.projectId, targetCredential, options);
    await this.convergence.cloudToLanMember({
      endpoint: control.currentEndpoint,
      hostCaCertificatePem: targetHost.caCertificatePem,
      hostCaFingerprint: targetHost.caFingerprint,
      identity: {
        authorityGeneration: generation,
        currentMember: snapshot.currentMember,
        eventSequence: snapshot.eventSequence,
        project: snapshot.project,
      },
      memberCredential: targetCredential,
      status: record.status,
    });
  }

  async #resolveClaimantRuntime(
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
        ? this.#bindLocalOnlyClaimant(record)
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
            ? this.#bindLanToCloudTargetOnlyClaimant({
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
              : this.#bindCloudToLanTargetOnlyClaimant({
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

  #assertCloudSession(
    projectId: CollabProjectId,
    session: Pick<
      CloudAuthorityConnection,
      'projectId' | 'supports'
    >,
  ): void {
    this.#assertCloudAuthorityTransferSession(projectId, session);
    if (!session.supports('project-snapshot')) {
      throw moduleError('authority-transfer-cloud-session-incompatible');
    }
  }

  #assertCloudAuthorityTransferSession(
    projectId: CollabProjectId,
    session: Pick<CloudAuthorityConnection, 'projectId' | 'supports'>,
  ): void {
    if (
      session.projectId !== projectId
      || !session.supports('authority-transfer')
    ) throw moduleError('authority-transfer-cloud-session-incompatible');
  }

  #assertLanToCloudSourceOwner(
    projectId: CollabProjectId,
    expectedAuthorityGeneration: number,
  ): Promise<void> {
    return Promise.resolve(this.options.assertLanToCloudSourceOwner(
      projectId,
      expectedAuthorityGeneration,
    ));
  }

  async #resolveRuntime(
    record: AuthorityTransferRecord,
    options: CollabOperationOptions,
  ): Promise<AuthorityTransferDirectionRuntime | null> {
    await this.options.assertRecoveryOwner(
      record.ownerInstallationKey,
      record.projectId,
    );
    const targetBinding = this.targetBindings.get(record.projectId);
    const sourceBinding = this.sourceBindings.get(record.projectId);
    if ((sourceBinding && (record.localRole !== 'source' || !bindingOwnerMatches(sourceBinding.owner, record)))
      || (targetBinding && (record.localRole !== 'target' || !bindingOwnerMatches(targetBinding.owner, record)))) {
      throw moduleError('authority-transfer-runtime-owner-mismatch');
    }
    const bound = record.localRole === 'source'
      ? sourceBinding?.coordinator
      : targetBinding?.managedConnection?.released
        ? undefined
        : targetBinding?.coordinator;
    if (bound) return bound;
    const locallyResolved = await this.options.terminalResolver?.resolve(record, options) ?? null;
    if (locallyResolved) return locallyResolved;
    if (record.status.state === 'completed') return null;
    if (record.localRole === 'target') {
      const entry = await this.options.persistence.loadCloudToLanTargetEntry(record.projectId);
      if (!entry || entry.phase !== 'handed-off') {
        throw moduleError('authority-transfer-target-successor-mismatch');
      }
      const connection = await this.options.createCloudToLanConnection(
        record.projectId,
        options,
      );
      let target: CloudToLanTargetCoordinatorOptions['target'] | null = null;
      let createdTarget = false;
      try {
        if (!connection.supports('authority-transfer')) {
          throw moduleError('authority-transfer-cloud-capability-unavailable');
        }
        this.#assertCloudToLanTargetConnection(entry, connection);
        target = targetBinding?.managedConnection?.target
          ?? this.options.createCloudToLanTarget(record.projectId, connection);
        createdTarget = targetBinding?.managedConnection?.target === undefined;
        return this.#bindPreparedCloudToLanTarget(record.projectId, {
          connection,
          target,
        }, bindingOwner(record.operationIntentId, record.status)).coordinator;
      } catch (error) {
        if (createdTarget) {
          await disposeCloudToLanTargetPreparation(connection, target);
        } else {
          connection.dispose();
        }
        throw error;
      }
    }
    const recoverCloudSession = this.options.recoverCloudSession;
    if (!recoverCloudSession) {
      return this.options.terminalResolver?.resolve(record, options) ?? null;
    }
    const session = await recoverCloudSession(record, options);
    try {
      return (await this.#bindLanToCloudSource({
        cloudSession: session,
        expectedTargetUrl: record.status.targetUrl,
        projectId: record.projectId,
      }, options, session)).coordinator;
    } catch (error) {
      session.dispose();
      throw error;
    }
  }
}
