import { randomUUID } from 'node:crypto';

import type {
  AcceptLanToCloudTransferTargetRequest,
  CollabAuthorityTransferStatus,
  CollabCloudToLanPreparation,
  CollabProjectId,
  CollabProjectMembershipOperationMap,
  RequestLanToCloudTransferRequest,
} from '@claudian-collab/protocol';
import {
  COLLAB_AUTHORITY_TRANSFER_CANCELLABLE_PHASES,
} from '@claudian-collab/protocol';

import type { AuthorityRecoveryOutcome } from '@/app/collab/authority-transfer/AuthorityRecoveryOutcome';
import {
  authorityTransferEntryExpiresAt,
} from '@/app/collab/authority-transfer/AuthorityTransferEntryRecord';
import type {
  AuthorityTransferLocalConvergence,
} from '@/app/collab/authority-transfer/AuthorityTransferLocalConvergence';
import {
  authorityTransferChildIdempotencyKey,
} from '@/app/collab/authority-transfer/AuthorityTransferOperationIdentity';
import { AuthorityTransferReadModel, type LANToCloudTransferView } from '@/app/collab/authority-transfer/AuthorityTransferReadModel';
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
  type CloudToLANManagerClaimantPredecessor,
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
import { CloudToLANApprovalWait } from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLANApprovalWait';
import {
  CloudToLANTargetCoordinator,
  type CloudToLANTargetCoordinatorOptions,
} from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLANTargetCoordinator';
import {
  assertCloudToLANTargetHandle,
  type CloudToLANManagerEntryRecord,
  cloudToLANManagerRequiresClaimant,
  type CloudToLANTargetPreparationDescriptor,
  type CloudToLANTransferHandle,
  cloudToLANTransferHandle,
  createCloudToLANManagerEntry,
  createCloudToLANTargetEntry,
  decodeCloudToLANTargetPreparationDescriptor,
  decodeCloudToLANTransferHandle,
} from '@/app/collab/authority-transfer/cloud-to-lan/CloudToLANTransferEntryRecord';
import { CollabAuthorityTransferOutcomeError } from '@/app/collab/authority-transfer/CollabAuthorityTransferOutcomeError';
import {
  LANToCloudRequesterCoordinator,
} from '@/app/collab/authority-transfer/lan-to-cloud/LANToCloudRequesterCoordinator';
import {
  LANToCloudSourceCoordinator,
  type LANToCloudSourceCoordinatorOptions,
  LANToCloudSourceProposalCoordinator,
} from '@/app/collab/authority-transfer/lan-to-cloud/LANToCloudSourceCoordinator';
import { LANAuthorityTransferTargetSnapshotReader } from '@/app/collab/authority-transfer/LANAuthorityTransferTargetSnapshotReader';
import type {
  AuthorityTransferPersistence,
  LANToCloudCancellationIntent,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import { completedTargetHandleDigest } from '@/app/collab/authority-transfer/persistence/RetainedAuthorityTransferRecord';
import {
  AuthorityTransferRecovery,
} from '@/app/collab/authority-transfer/recovery/AuthorityTransferRecovery';
import {
  type CollabLocalMembershipRecord,
  isCollabLocalCloudMembership,
  isCollabLocalLANMembership,
} from '@/app/collab/CollabLocalProjectRepository';
import {
  LANAuthorityTransferClient,
  type LANAuthorityTransferTrustedHost,
} from '@/app/collab/lan/authority-transfer/LANAuthorityTransferClient';
import type {
  LANAuthorityTransferActor,
  LANAuthorityTransferSourceActiveService,
} from '@/app/collab/lan/authority-transfer/LANAuthorityTransferRouter';
import type {
  CollabProjectLifecycleSubsystem,
} from '@/app/collab/lifecycle/CollabProjectLifecycleSubsystem';
import { LANMembershipClaimClient } from '@/app/collab/membership/LANMembershipClaimClient';
import type {
  CloudMembershipClaimInvitation,
} from '@/app/collab/project/CloudProjectInvitation';
import type { LANMembershipClaimInvitation } from '@/app/collab/project/LANMembershipClaimInvitation';
import type { ProjectRecoveryInvitation } from '@/app/collab/project/ProjectRecoveryInvitation';
import type {
  CloudAuthorityConnection,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { CloudAuthorityRejection } from '@/app/collab/remote-authority/CloudAuthorityError';
import { validateCloudServerURL } from '@/app/collab/remote-authority/CloudAuthorityURLs';
import type { CollabCloudToLANTransferView, CollabOperationOptions, CollabPendingReconnectView } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import type { InstallationKey } from '@/core/device/InstallationKey';

export interface AuthorityTransferSourceRouteInput {
  readonly authorityGeneration: number;
  readonly authenticateMemberCredential: (
    credential: string,
  ) => Promise<LANAuthorityTransferActor>;
  readonly hostMemberId: string;
  readonly projectId: CollabProjectId;
}

export interface AuthorityTransferModuleOptions {
  readonly observeProject?: (projectId: CollabProjectId) => { dispose(): void };
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
  ) => CloudToLANTargetCoordinatorOptions['target'];
  readonly createCloudToLanConnection: (
    projectId: CollabProjectId,
    options: CollabOperationOptions,
  ) => Promise<CloudToLANEntryConnection>;
  readonly createCloudToLanClaimantClient?: (
    target: LANAuthorityTransferTrustedHost,
  ) => Pick<LANAuthorityTransferClient, 'claimTransferredMembership'>;
  readonly createLanToCloudConnection?: (
    input: Readonly<{ readonly projectId: CollabProjectId; readonly serverUrl: string; readonly allowCredentialCreation: boolean }>,
    options: CollabOperationOptions,
  ) => Promise<CloudAuthorityConnection>;
  readonly createLanToCloudClaimantClient?: (
    trust: LANAuthorityTransferTrustedHost,
  ) => LANAuthorityTransferClient;
  readonly createLanToCloudSource: (
    projectId: CollabProjectId,
    session: CloudAuthorityConnection,
  ) => LANToCloudSourceCoordinatorOptions['source'];
  readonly createLanTargetSnapshotReader?: (
    projectId: CollabProjectId,
    targetHost: BindCloudToLANClaimantInput['targetHost'],
    authorityGeneration: number,
  ) => Pick<LANAuthorityTransferTargetSnapshotReader, 'readSnapshot' | 'currentEndpoint'>;
  readonly activateLanToCloudSourceRoute?: (
    projectId: CollabProjectId,
    options: CollabOperationOptions,
  ) => Promise<() => Promise<void>>;
  readonly lifecycle: CollabProjectLifecycleSubsystem;
  readonly assertProjectRecoveryPredecessor?: (projectId: string, identity: { actorMemberId: string; authorityGeneration: number }) => Promise<void>;
  readonly loadClaimantProofCredential?: (projectId: string) => Promise<string>;
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

export interface CloudToLANEntryConnection {
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

export interface BindLANToCloudSourceInput {
  readonly cloudSession: CloudAuthorityConnection;
  readonly expectedTargetUrl?: string;
  readonly projectId: CollabProjectId;
}

export interface CreateLANToCloudRequesterInput {
  readonly authorityGeneration: number;
  readonly lanClient: LANAuthorityTransferClient;
  readonly memberCredential: string;
  readonly memberId: LANAuthorityTransferActor['memberId'];
  readonly projectId: CollabProjectId;
}

export interface LANToCloudSourceProposalView {
  readonly cancellation: LANToCloudCancellationIntent | null;
  readonly beginSubmission: 'cloud-absent' | 'not-sent' | 'possibly-sent';
  readonly proposedByMemberId: LANAuthorityTransferActor['memberId'];
  readonly request: Readonly<RequestLanToCloudTransferRequest>;
  readonly status: CollabAuthorityTransferStatus;
}


export interface PrepareCloudToLANTargetInput {
  readonly operationIntentId: string;
  readonly projectId: CollabProjectId;
}

export interface BeginCloudToLANTransferInput {
  readonly descriptor: CloudToLANTargetPreparationDescriptor;
  readonly operationIntentId: string;
}

export interface AcceptPreparedCloudToLANTransferInput {
  readonly handle: CloudToLANTransferHandle;
}

export interface WithdrawPreparedCloudToLANTargetInput {
  readonly preparationId: string;
  readonly projectId: CollabProjectId;
}

export type BindAuthorityTransferClaimantInput = Omit<
  AuthorityTransferClaimantCoordinatorOptions,
  'store'
> & Readonly<{ readonly projectId: CollabProjectId }>;

export interface BindLANToCloudClaimantInput {
  readonly cloudSession: CloudAuthorityConnection;
  readonly lanClient: LANAuthorityTransferClient;
  readonly memberCredential: string;
  readonly projectId: CollabProjectId;
}

export interface BindCloudToLANClaimantInput {
  readonly cloudSession: Pick<
    CloudAuthorityConnection,
    'lifecycle' | 'projectId' | 'serverUrl' | 'supports'
  >;
  readonly lanClient: Pick<LANAuthorityTransferClient, 'claimTransferredMembership'>;
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
  | Readonly<{ direction: 'cloud-to-lan' | 'lan-to-cloud'; mode: 'project-recovery'; cloudSession?: CloudAuthorityConnection }>
  | Readonly<{
      readonly direction: 'cloud-to-lan';
      readonly mode: 'manager-reissued';
      readonly targetHost: BindCloudToLANClaimantInput['targetHost'];
      readonly authorityGeneration: number;
    }>
  | Readonly<{
      readonly cloudSession: CloudAuthorityConnection;
      readonly direction: 'lan-to-cloud';
      readonly lanClient: LANAuthorityTransferClient;
      readonly memberCredential: string;
      readonly mode: 'full';
    }>
  | Readonly<{
      readonly cloudSession: CloudAuthorityConnection;
      readonly direction: 'cloud-to-lan';
      readonly lanClient: LANAuthorityTransferClient;
      readonly mode: 'full';
      readonly targetHost: BindCloudToLANClaimantInput['targetHost'];
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
      readonly targetHost: BindCloudToLANClaimantInput['targetHost'];
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
  readonly coordinator: LANToCloudSourceCoordinator;
  readonly targetUrl: string;
}

interface TargetBinding {
  readonly owner: AuthorityTransferBindingOwner;
  readonly coordinator: CloudToLANTargetCoordinator;
  dispose(): Promise<void>;
  readonly managedConnection?: {
    released: boolean;
    release(): void;
    readonly target: CloudToLANTargetCoordinatorOptions['target'];
  };
  readonly terminalCleanup?: {
    readonly handle: CloudToLANTransferHandle;
    readonly status: CollabAuthorityTransferStatus;
    targetDisposed: boolean;
  };
}

interface TargetPreparationBinding {
  readonly cleanupOperationIntentId?: string;
  readonly connection: CloudToLANEntryConnection;
  readonly target: CloudToLANTargetCoordinatorOptions['target'];
}

async function disposeCloudToLANTargetPreparation(
  connection: CloudToLANEntryConnection,
  target: CloudToLANTargetCoordinatorOptions['target'] | null,
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

function isDefinitiveCloudToLANBeginRejection(
  error: CloudAuthorityRejection,
  wasPossiblySent: boolean,
): boolean {
  return !wasPossiblySent && (
    error.code === 'authorization-denied' || error.code === 'authority-transfer-stale'
  );
}

function sameCloudToLANTransferHandle(
  left: CloudToLANTransferHandle,
  right: CloudToLANTransferHandle,
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
  private readonly readModel: AuthorityTransferReadModel;
  readonly #approvalWait = new CloudToLANApprovalWait((projectId, signal) => (
    this.#pollCloudToLanApproval(projectId, signal)
  ), projectId => this.options.observeProject?.(projectId) ?? { dispose() {} });

  notifyCloudToLanApproval(projectId: CollabProjectId): void {
    this.#approvalWait.notify(projectId);
  }

  waitForCloudToLanApproval(projectId: CollabProjectId): void {
    this.#approvalWait.start(projectId);
  }

  async #pollCloudToLanApproval(projectId: CollabProjectId, signal: AbortSignal): Promise<AuthorityRecoveryOutcome> {
    const handle = await this.options.lifecycle.runExclusive(
      projectId, 'authority-transfer', 'continuation', async () => {
        const entry = await this.options.persistence.loadCloudToLanTargetEntry(projectId);
        if (!entry || entry.ownerInstallationKey !== this.options.installationKey) return undefined;
        if (entry.phase === 'handed-off') {
          return (await this.readCloudToLanTransfer(projectId))?.target?.handle ?? undefined;
        }
        if (entry.phase !== 'published' || !entry.descriptor) return undefined;
        if (Date.parse(entry.expiresAt) <= this.now().getTime()) return undefined;
        const preparation = this.targetPreparations.get(projectId);
        if (!preparation || signal.aborted) return undefined;
        this.#assertCloudToLanTargetConnection(entry, preparation.connection);
        const registered = await this.#registerCloudToLanPreparation(projectId, { signal });
        if (registered.withdrawnAt !== null) {
          await this.options.persistence.withdrawCloudToLanTargetEntry(entry);
          await this.#disposeCloudToLanTargetRuntime(projectId);
          return undefined;
        }
        const { approval } = await preparation.connection.lifecycle.authorityTransfer(
          'getCloudToLanPreparationApproval', {
            preparationId: entry.descriptor.preparationId,
            projectId,
            sourceAuthorityGeneration: entry.sourceAuthorityGeneration,
          }, { signal },
        );
        if (!approval) return null;
        if (approval.projectId !== projectId || approval.direction !== 'cloud-to-lan'
          || approval.sourceAuthority.kind !== 'cloud'
          || approval.sourceAuthority.generation !== entry.sourceAuthorityGeneration
          || approval.targetAuthority.kind !== 'lan'
          || approval.targetAuthority.generation !== entry.sourceAuthorityGeneration + 1
          || approval.targetUrl !== entry.descriptor.targetUrl) {
          throw moduleError('cloud-to-lan-prepared-status-mismatch');
        }
        return decodeCloudToLANTransferHandle({
          operationIntentId: entry.descriptor.preparationId,
          preparationId: entry.descriptor.preparationId,
          projectId, schemaVersion: 1,
          selectedTargetMemberId: entry.selectedTargetMemberId,
          sourceAuthorityGeneration: entry.sourceAuthorityGeneration,
          sourceCloudUrl: entry.sourceCloudUrl,
          targetUrl: entry.descriptor.targetUrl,
          transferId: approval.transferId,
        });
      },
    );
    if (handle === null) return { kind: 'waiting' };
    if (signal.aborted) return { kind: 'cancelled' };
    if (!handle) return { kind: 'idle' };
    await this.acceptCloudToLanTransfer({ handle }, { signal });
    return { kind: 'completed' };
  }

  readonly claimants: AuthorityTransferClaimantRuntimeRegistry;
  readonly convergence: AuthorityTransferLocalConvergence;
  readonly runtimes: AuthorityTransferRuntimeDispatch;
  private readonly claimantRecovery: AuthorityTransferClaimantRecovery;
  private readonly sourceProposals: LANToCloudSourceProposalCoordinator;
  private readonly sourceBindings = new Map<CollabProjectId, SourceBinding>();
  private readonly targetBindings = new Map<CollabProjectId, TargetBinding>();
  private readonly targetPreparations = new Map<CollabProjectId, TargetPreparationBinding>();
  private readonly transferRecovery: AuthorityTransferRecovery;
  private readonly now: () => Date;

  constructor(private readonly options: AuthorityTransferModuleOptions) {
    this.readModel = new AuthorityTransferReadModel(options.persistence, options.installationKey);
    this.now = options.now ?? (() => new Date());
    this.convergence = options.convergence;
    this.runtimes = new AuthorityTransferRuntimeDispatch({
      resolve: (record, operationOptions) => this.#resolveRuntime(record, operationOptions),
    });
    this.claimants = new AuthorityTransferClaimantRuntimeRegistry({
      resolve: record => this.#resolveClaimantRuntime(record),
    });
    this.sourceProposals = new LANToCloudSourceProposalCoordinator({
      installationKey: options.installationKey,
      persistence: options.persistence,
    });
    this.transferRecovery = new AuthorityTransferRecovery(
      options.persistence,
      {
        reconcileRequester: async projectId => {
          const membership = await this.options.loadClaimantMembership?.(projectId);
          if (!membership || membership.project.id !== projectId) return;
          await this.options.persistence.settleLocalAuthorityAdvance({
            projectId, memberId: membership.member.id, authorityGeneration: membership.authority.authorityGeneration,
          });
        },
        runHostTransferOffer: (projectId, operationOptions, createOffer) => (
          this.#runHostTransferOffer(projectId, operationOptions, createOffer)
        ),
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
          }, recoveryOptions).then(() => this.waitForCloudToLanApproval(entry.projectId))
        ),
      },
      options.assertRecoveryOwner,
    );
    this.claimantRecovery = new AuthorityTransferClaimantRecovery(
      options.claimantStore,
      {
        assertTransferPredecessor: record => this.#assertClaimantTransferPredecessor(record),
        beforeProject: record => this.#assertClaimantManagerPredecessor(record),
        complete: record => this.#completeAuthorityTransferClaimant(record),
        isLocalOwner: record => this.#isAuthorityTransferClaimantLocalOwner(record),
        resume: (record, recoveryOptions) => this.claimants.resume(record, recoveryOptions),
      },
      this.now,
    );
    this.transferRecovery.register(options.lifecycle);
    this.claimantRecovery.register(options.lifecycle);
  }

  async bindLanToCloudSource(
    input: BindLANToCloudSourceInput,
    options: CollabOperationOptions = {},
  ): Promise<AuthorityTransferDirectionBinding<LANToCloudSourceCoordinator>> {
    return this.#bindLanToCloudSource(input, options, null);
  }

  async #bindLanToCloudSource(
    input: BindLANToCloudSourceInput,
    options: CollabOperationOptions,
    ownedConnection: CloudAuthorityConnection | null,
  ): Promise<AuthorityTransferDirectionBinding<LANToCloudSourceCoordinator>> {
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
    const coordinator = new LANToCloudSourceCoordinator({
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
    input: CreateLANToCloudRequesterInput,
  ): LANToCloudRequesterCoordinator {
    return new LANToCloudRequesterCoordinator({
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
  ): Promise<LANToCloudSourceProposalView | null> {
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

  readLanToCloudTransfer(projectId: CollabProjectId, sourceAuthorityGeneration: number): Promise<LANToCloudTransferView | null> {
    return this.readModel.readLanToCloudTransfer(projectId, sourceAuthorityGeneration);
  }

  readCloudToLanTransfer(projectId: CollabProjectId): Promise<CollabCloudToLANTransferView | null> {
    return this.readModel.readCloudToLanTransfer(projectId);
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
    sourceInput?: BindLANToCloudSourceInput,
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
    throw moduleError('authority-transfer-target-recovery-required');
  }

  cancelLanToCloudTransfer(
    request: LANToCloudCancellationIntent,
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
    input: PrepareCloudToLANTargetInput,
    options: CollabOperationOptions = {},
  ): Promise<CloudToLANTargetPreparationDescriptor> {
    return this.options.lifecycle.runExclusive(
      input.projectId,
      'authority-transfer',
      'continuation',
      async () => {
        const descriptor = await this.#prepareCloudToLanTargetOwned(input, options);
        await this.#registerCloudToLanPreparation(input.projectId, options);
        return descriptor;
      },
    );
  }

  async #registerCloudToLanPreparation(projectId: string, options: CollabOperationOptions) {
    const entry = await this.options.persistence.loadCloudToLanTargetEntry(projectId);
    const runtime = this.targetPreparations.get(projectId);
    if (!entry || entry.ownerInstallationKey !== this.options.installationKey
      || entry.phase !== 'published' || !entry.descriptor || !runtime) {
      throw moduleError('authority-transfer-target-preparation-missing');
    }
    this.#assertCloudToLanTargetConnection(entry, runtime.connection);
    return runtime.connection.lifecycle.authorityTransfer('registerCloudToLanPreparation', {
      caCertificatePem: entry.descriptor.caCertificatePem,
      caFingerprint: entry.descriptor.caFingerprint,
      expectedAuthorityGeneration: entry.sourceAuthorityGeneration,
      expiresAt: entry.expiresAt,
      idempotencyKey: entry.operationIntentId,
      projectId,
      targetUrl: entry.descriptor.targetUrl,
    }, options);
  }

  async readCloudToLanPreparations(projectId: string, options: CollabOperationOptions = {}) {
    const connection = await this.options.createCloudToLanConnection(projectId, options);
    try {
      const result = await connection.lifecycle.authorityTransfer('listCloudToLanPreparations', { projectId }, options);
      return result.preparations.map(preparation => this.#preparationDescriptor(preparation, connection.serverUrl));
    } finally { connection.dispose(); }
  }

  #preparationDescriptor(preparation: CollabCloudToLanPreparation, sourceCloudUrl: string) {
    return decodeCloudToLANTargetPreparationDescriptor({
      caCertificatePem: preparation.caCertificatePem, caFingerprint: preparation.caFingerprint,
      preparationId: preparation.preparationId, projectId: preparation.projectId,
      publishedAt: preparation.createdAt, schemaVersion: 1,
      selectedTargetMemberId: preparation.targetHostMemberId,
      sourceAuthorityGeneration: preparation.sourceAuthorityGeneration,
      sourceCloudUrl, targetUrl: preparation.targetUrl,
    });
  }

  async resolveCloudToLanPreparation(projectId: string, preparationId: string, options: CollabOperationOptions = {}) {
    const manager = await this.options.persistence.loadCloudToLanManagerEntry(projectId);
    if (manager?.descriptor.preparationId === preparationId) return manager.descriptor;
    const preparations = await this.readCloudToLanPreparations(projectId, options);
    const descriptor = preparations.find(item => item.preparationId === preparationId);
    if (!descriptor) throw moduleError('authority-transfer-target-preparation-missing');
    const target = await this.options.persistence.loadCloudToLanTargetEntry(projectId);
    if (target?.descriptor?.preparationId === preparationId
      && target.ownerInstallationKey === this.options.installationKey) {
      const local = target.descriptor;
      if (JSON.stringify({ ...descriptor, publishedAt: local.publishedAt }) !== JSON.stringify(local)) {
        throw moduleError('authority-transfer-target-preparation-mismatch');
      }
      return local;
    }
    return descriptor;
  }

  async #prepareCloudToLanTargetOwned(
    input: PrepareCloudToLANTargetInput,
    options: CollabOperationOptions,
  ): Promise<CloudToLANTargetPreparationDescriptor> {
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
    let createdTarget: CloudToLANTargetCoordinatorOptions['target'] | null = null;
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
          createCloudToLANTargetEntry({
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
          disposeCloudToLANTargetPreparation(connection, createdTarget),
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
    input: BeginCloudToLANTransferInput,
    options: CollabOperationOptions = {},
  ): Promise<CloudToLANTransferHandle> {
    const descriptor = decodeCloudToLANTargetPreparationDescriptor(input.descriptor);
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
    descriptor: CloudToLANTargetPreparationDescriptor,
    operationIntentId: string,
    options: CollabOperationOptions,
  ): Promise<CloudToLANTransferHandle> {
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
        const handle = cloudToLANTransferHandle(entry);
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
    if (entry?.status) return cloudToLANTransferHandle(entry);
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
          createCloudToLANManagerEntry({
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
          && isDefinitiveCloudToLANBeginRejection(error, wasPossiblySent)
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
      const handle = cloudToLANTransferHandle(entry);
      if (entry.phase === 'settled') {
        await this.#completeCloudToLanManagerEntry(entry, connection, options);
      }
      return handle;
    } finally {
      connection.dispose();
    }
  }

  async acceptCloudToLanTransfer(
    input: AcceptPreparedCloudToLANTransferInput,
    options: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus> {
    const handle = decodeCloudToLANTransferHandle(input.handle);
    return this.options.lifecycle.runExclusive(
      handle.projectId,
      'authority-transfer',
      'continuation',
      async () => {
        const retained = await this.options.persistence.loadRetainedCloudToLanTarget(handle.projectId, handle.transferId);
        if (retained) {
          try {
            if (completedTargetHandleDigest(handle) !== retained.targetHandleSha256) throw new TypeError();
          } catch {
            throw moduleError('authority-transfer-target-handle-mismatch');
          }
          const manager = await this.options.persistence.loadCloudToLanManagerEntry(handle.projectId);
          if (manager && this.#cloudToLanManagerMatchesPhysical(manager, retained.record)) {
            await this.#settleRecoveredCloudToLanManager(retained.record);
          }
          await this.#releaseCompletedCloudToLanRuntime(handle.projectId);
          return retained.record.status;
        }
        let binding = this.targetBindings.get(handle.projectId);
        const retainedCleanup = binding?.terminalCleanup;
        if (binding && retainedCleanup) {
          if (!sameCloudToLANTransferHandle(retainedCleanup.handle, handle)) {
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
          assertCloudToLANTargetHandle(entry, handle);
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
    input: WithdrawPreparedCloudToLANTargetInput,
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
          if (entry.phase !== 'published' || this.targetBindings.has(input.projectId)) {
            throw moduleError('authority-transfer-target-already-accepted');
          }
          await this.#registerCloudToLanPreparation(input.projectId, options);
          const runtime = this.targetPreparations.get(input.projectId)!;
          await runtime.connection.lifecycle.authorityTransfer('withdrawCloudToLanPreparation', {
            preparationId: input.preparationId, projectId: input.projectId,
            idempotencyKey: authorityTransferChildIdempotencyKey(input.preparationId, 'cancel'),
          }, options);
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
    const bindingTransfer = this.targetBindings.get(projectId)?.owner.transferId;
    const record = await this.options.persistence.load(projectId, bindingTransfer);
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
        ? disposeCloudToLANTargetPreparation(preparation.connection, preparation.target)
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
    input: CloudToLANTransferHandle,
    options: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus> {
    const handle = decodeCloudToLANTransferHandle(input);
    return this.options.lifecycle.runExclusive(
      handle.projectId,
      'authority-transfer',
      'continuation',
      () => this.#cancelCloudToLanTransferOwned(handle, options),
    );
  }

  async #cancelCloudToLanTransferOwned(
    handle: CloudToLANTransferHandle,
    options: CollabOperationOptions,
  ): Promise<CollabAuthorityTransferStatus> {
    const projectId = handle.projectId;
    let entry = await this.#requireCloudToLanManagerStatus(projectId);
    this.#assertCloudToLanManagerInstallationOwner(entry);
    if (!sameCloudToLANTransferHandle(cloudToLANTransferHandle(entry), handle)) {
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
        let observed: CloudToLANManagerEntryRecord;
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
        let advanced: CloudToLANManagerEntryRecord;
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
    const physical = await this.options.persistence.load(projectId, entry.status?.transferId);
    if (physical?.ownerInstallationKey === this.options.installationKey) {
      if (!this.#cloudToLanManagerMatchesPhysical(entry, physical)) {
        throw moduleError('authority-transfer-manager-physical-mismatch');
      }
      if (physical.status.state === 'completed') {
        await this.#settleRecoveredCloudToLanManager(physical);
        await this.#releaseCompletedCloudToLanRuntime(projectId);
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
            || !isDefinitiveCloudToLANBeginRejection(error, wasPossiblySent)
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

  async #runHostTransferOffer(
    projectId: CollabProjectId,
    options: CollabOperationOptions,
    createOffer: () => Promise<void>,
  ): Promise<boolean> {
    const record = await this.options.persistence.load(projectId);
    if (!record || record.ownerInstallationKey !== this.options.installationKey
      || record.localRole !== 'target' || record.status.direction !== 'cloud-to-lan'
      || record.status.state !== 'completed') return false;
    throwIfCancelled(options.signal);
    await this.#resumeAuthorityTransferRecord(record, options);
    if (await this.options.persistence.load(projectId)) {
      throw moduleError('authority-transfer-host-predecessor-unsettled');
    }
    await createOffer();
    return true;
  }

  async #resumeAuthorityTransferRecord(
    record: AuthorityTransferRecord,
    options: CollabOperationOptions,
  ): Promise<void> {
    if (record.terminalCleanupCompleted && record.status.state !== 'completed') {
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
    const current = await this.options.persistence.load(record.projectId, record.transferId);
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
      cloudToLANTransferHandle(entry),
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
    const coordinator = new CloudToLANTargetCoordinator({
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
    entry: CloudToLANManagerEntryRecord,
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
      && claimant.status.direction === 'cloud-to-lan'
      && claimant.managerPredecessor !== null;
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
      || claimant.managerPredecessor === null
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
    handle: CloudToLANTransferHandle,
    status: CollabAuthorityTransferStatus,
  ): Promise<void> {
    const entry = await this.options.persistence.loadCloudToLanManagerEntry(
      handle.projectId,
    );
    if (
      !entry?.status
      || !sameCloudToLANTransferHandle(cloudToLANTransferHandle(entry), handle)
    ) return;
    const locallyOwned = entry.ownerInstallationKey === this.options.installationKey;
    if (entry.phase === 'settled') {
      if (cloudToLANManagerRequiresClaimant(entry) || !locallyOwned) return;
      await this.options.persistence.settleCloudToLanManagerEntry(entry);
      return;
    }
    if (entry.phase !== 'submitted' && entry.phase !== 'observing') return;
    const observed = await this.options.persistence.recordCloudToLanManagerStatus(entry, status);
    if (
      observed.phase === 'settled'
      && !cloudToLANManagerRequiresClaimant(observed)
      && locallyOwned
    ) {
      await this.options.persistence.settleCloudToLanManagerEntry(observed);
    }
  }

  async #requireCloudToLanManagerConnection(
    entry: NonNullable<Awaited<ReturnType<AuthorityTransferPersistence['loadCloudToLanManagerEntry']>>>,
    options: CollabOperationOptions,
  ): Promise<CloudToLANEntryConnection> {
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
    entry: CloudToLANManagerEntryRecord,
    connection: CloudToLANEntryConnection,
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
    connection: CloudToLANEntryConnection,
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
    entry: CloudToLANManagerEntryRecord,
    claimant: AuthorityTransferClaimantRecord,
  ): boolean {
    const predecessor = claimant.variant === 'source-issued'
      ? claimant.managerPredecessor
      : null;
    return cloudToLANManagerRequiresClaimant(entry)
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
    entry: CloudToLANManagerEntryRecord | null,
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
      || !cloudToLANManagerRequiresClaimant(entry)
    ) return false;
    const claimant = await this.options.claimantStore.load(projectId);
    return claimant !== null && this.#cloudToLanManagerMatchesClaimant(entry, claimant);
  }

  async #resumeCloudToLanManagerClaimant(
    entry: CloudToLANManagerEntryRecord,
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
    entry: CloudToLANManagerEntryRecord,
    claimant: AuthorityTransferClaimantRecord | null,
    options: CollabOperationOptions,
  ): Promise<void> {
    if (await this.#resumeCloudToLanManagerClaimant(entry, claimant, options)) return;
    if (!cloudToLANManagerRequiresClaimant(entry)) {
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
      && claimant.managerPredecessor !== null
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
    entry: CloudToLANManagerEntryRecord,
  ): Promise<boolean> {
    if (entry.ownerInstallationKey !== this.options.installationKey) return false;
    const loadMembership = this.options.loadClaimantMembership;
    if (!loadMembership) return false;
    const membership = await loadMembership(entry.projectId);
    return membership?.member.id === entry.initiatingMemberId
      && membership.member.personalRef === entry.initiatingPersonalRef;
  }

  async #completeCloudToLanManagerEntry(
    entry: CloudToLANManagerEntryRecord,
    connection: CloudToLANEntryConnection | null,
    options: CollabOperationOptions,
  ): Promise<void> {
    if (cloudToLANManagerRequiresClaimant(entry)) {
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
            }) ?? new LANAuthorityTransferClient({ ...targetHost, projectId: entry.projectId }),
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
    entry: CloudToLANManagerEntryRecord,
  ): CloudToLANManagerClaimantPredecessor {
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
    connection: CloudToLANEntryConnection,
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
    entry: CloudToLANManagerEntryRecord,
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
    connection: CloudToLANEntryConnection,
    snapshot: Awaited<ReturnType<CloudToLANEntryConnection['readSnapshot']>>,
  ): void {
    if (
      connection.projectId !== snapshot.project.id
      || connection.authorityGeneration !== snapshot.project.authorityGeneration
      || connection.memberId !== snapshot.currentMember.id
      || connection.personalRef !== snapshot.currentMember.personalRef
    ) throw moduleError('authority-transfer-cloud-binding-mismatch');
  }

  async close(): Promise<void> {
    await this.#approvalWait.close();
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
      ...targetPreparations.map(preparation => disposeCloudToLANTargetPreparation(
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

  async followAuthoritySuccessor(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<boolean> {
    const loadMembership = this.options.loadClaimantMembership;
    if (!loadMembership) throw moduleError('authority-transfer-claimant-entry-unavailable');
    const membership = await loadMembership(projectId);
    if (!membership) return false;
    const pending = await this.options.claimantStore.load(projectId);
    if (pending) {
      return this.options.lifecycle.runAuthorityTransferClaimant(projectId, async () => {
        const retained = await this.options.claimantStore.load(projectId);
        if (!retained || retained.operationIntentId !== pending.operationIntentId) throw moduleError('authority-transfer-claimant-attempt-conflict');
        await this.#assertClaimantTransferPredecessor(retained);
      }, async () => {
        const retained = await this.options.claimantStore.load(projectId);
        if (!retained || await this.#assertClaimantManagerPredecessor(retained) === 'skip') return false;
        if (authorityTransferClaimantRequiresNoRuntime(retained, this.now())) {
          await this.#completeAuthorityTransferClaimant(retained);
        } else {
          await this.claimants.resume(retained, options);
        }
        return true;
      });
    }
    const requireSuccessor = (status: CollabAuthorityTransferStatus): void => {
      if (status.projectId !== projectId || status.state !== 'completed' || status.phase !== 'completed'
        || !status.relinquishmentProof || status.sourceAuthority.kind !== membership.authority.kind
        || status.sourceAuthority.generation !== membership.authority.authorityGeneration
        || status.targetAuthority.generation !== membership.authority.authorityGeneration + 1) {
        throw moduleError('authority-transfer-claimant-source-mismatch');
      }
      if (this.now().getTime() >= Date.parse(status.expiresAt)) {
        throw moduleError('authority-transfer-claimant-expired');
      }
    };
    if (isCollabLocalLANMembership(membership)) {
      if (membership.hostOwnership.ownsAuthority) return false;
      if (!membership.authority.endpoint || !membership.authority.hostCaCertificatePem
        || !membership.authority.hostCaFingerprint) return false;
      const trust = {
        authorityGeneration: membership.authority.authorityGeneration,
        caCertificatePem: membership.authority.hostCaCertificatePem,
        caFingerprint: membership.authority.hostCaFingerprint,
        endpoint: membership.authority.endpoint, projectId,
      };
      const client = this.options.createLanToCloudClaimantClient?.(trust) ?? new LANAuthorityTransferClient(trust);
      const status = await client.readCurrentTransferStatus(membership.member.credential, options);
      requireSuccessor(status);
      if (status.direction !== 'lan-to-cloud' || status.targetAuthority.kind !== 'cloud') {
        throw moduleError('authority-transfer-claimant-source-mismatch');
      }
      return this.reconnectLanToCloud(projectId, status.targetUrl, options);
    }
    return this.options.lifecycle.runAuthorityTransferClaimant(projectId, async () => {
      const current = await loadMembership(projectId);
      if (!current) throw moduleError('authority-transfer-claimant-membership-invalid');
      await this.#assertProjectRecoveryPredecessor(projectId, current.member.id, current.authority.authorityGeneration);
    }, async () => {
      const current = await loadMembership(projectId);
      if (!current || !isCollabLocalCloudMembership(current)
        || current.member.id !== membership.member.id
        || current.authority.authorityGeneration !== membership.authority.authorityGeneration
        || current.authority.serverUrl !== membership.authority.serverUrl) return false;
      await this.#assertCloudToLanManagerSettled(projectId);
      const connection = await this.options.createCloudToLanConnection(projectId, options);
      try {
        const { successor } = await connection.lifecycle.authorityTransfer('getProjectAuthoritySuccessor', {
          projectId, sourceAuthorityGeneration: current.authority.authorityGeneration,
        }, options);
        if (!successor) return false;
        requireSuccessor(successor);
        if (successor.direction !== 'cloud-to-lan' || successor.targetAuthority.kind !== 'lan' || !successor.lanTarget) {
          throw moduleError('authority-transfer-claimant-source-mismatch');
        }
        const targetHost = { ...successor.lanTarget, endpoint: successor.targetUrl };
        const trust = { ...targetHost, authorityGeneration: successor.targetAuthority.generation, projectId };
        const binding = this.bindCloudToLanClaimant({
          cloudSession: connection, projectId, targetHost,
          lanClient: this.options.createCloudToLanClaimantClient?.(trust) ?? new LANAuthorityTransferClient(trust),
        });
        try {
          await binding.coordinator.start({
            memberId: current.member.id, operationIntentId: `claim-${randomUUID()}`, status: successor,
          }, options);
        } finally {
          await binding.dispose();
        }
        return true;
      } finally {
        connection.dispose();
      }
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
    if ((!membership || !isCollabLocalLANMembership(membership))
      && !(pending?.variant === 'source-issued' && pending.status.direction === 'lan-to-cloud')) return false;
    const serverUrl = validateCloudServerURL(selectedServerUrl, 'serverUrl');
    return this.options.lifecycle.runAuthorityTransferClaimant(
      projectId, async () => {
        const current = await loadMembership(projectId);
        if (!current) throw moduleError('authority-transfer-claimant-membership-invalid');
        await this.#assertProjectRecoveryPredecessor(projectId, current.member.id, current.authority.authorityGeneration);
      },
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
          if (!isCollabLocalLANMembership(current) || current.hostOwnership.ownsAuthority
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
            ?? new LANAuthorityTransferClient(trust);
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
    input: BindLANToCloudClaimantInput,
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
        confirmSourceTargetBinding: (record, options) => this.#confirmSourceIssuedCloudTarget(record, input.cloudSession, options),
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
          await this.convergence.restoreCloudMembership({
            snapshot,
            status: record.targetStatus,
          }, record.retainedAttempts);
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

  #bindLanManagerReissuedClaimant(
    projectId: CollabProjectId,
    targetHost: BindCloudToLANClaimantInput['targetHost'],
    authorityGeneration: number,
  ): AuthorityTransferDirectionBinding<AuthorityTransferClaimantCoordinator> {
    const client = new LANMembershipClaimClient({ ...targetHost, projectId, authorityGeneration });
    const confirm = async (record: ManagerReissuedAuthorityTransferClaimantRecord, options: CollabOperationOptions) => {
      if (!record.lanTarget || record.lanTarget.caFingerprint !== targetHost.caFingerprint
        || record.descriptor.targetAuthorityGeneration !== authorityGeneration || !record.targetCredential) {
        throw moduleError('authority-transfer-claimant-target-binding-invalid');
      }
      const snapshot = await client.snapshots.readSnapshot(projectId, record.targetCredential, options);
      if (snapshot.project.id !== record.projectId || snapshot.project.authorityGeneration !== authorityGeneration
        || snapshot.currentMember.id !== record.memberId || snapshot.currentMember.personalRef !== record.memberPersonalRef) {
        throw moduleError('authority-transfer-claimant-target-binding-invalid');
      }
      return snapshot;
    };
    return this.#bindClaimant({
      projectId, lanTarget: targetHost,
      target: {
        cloudPrincipalId: null,
        claimTransferredMembership: (record, request, options) => {
          if (record.variant !== 'manager-reissued' || !record.lanTarget || typeof request.credentialHash !== 'string') {
            throw moduleError('authority-transfer-claimant-variant-invalid');
          }
          return client.redeem({ ...request, credentialHash: request.credentialHash }, options);
        },
        confirmTargetBinding: async (record, _proof, options) => { await confirm(record, options); return null; },
      },
      convergence: { converge: async (record, options) => {
        if (record.variant !== 'manager-reissued') throw moduleError('authority-transfer-claimant-variant-invalid');
        const snapshot = await confirm(record, options);
        await this.convergence.restoreLanMembership({
          endpoint: client.snapshots.currentEndpoint,
          hostCaCertificatePem: targetHost.caCertificatePem, hostCaFingerprint: targetHost.caFingerprint,
          memberCredential: record.targetCredential!,
          identity: { authorityGeneration, currentMember: snapshot.currentMember, eventSequence: snapshot.eventSequence, project: snapshot.project },
        }, record.retainedAttempts);
      } },
    });
  }

  #assertClaimantTransferPredecessor(record: AuthorityTransferClaimantRecord): Promise<void> {
    const generation = record.variant === 'source-issued' ? record.status.targetAuthority.generation
      : record.variant === 'manager-reissued' ? record.descriptor.targetAuthorityGeneration
        : record.invitation.link.authorityGeneration;
    return this.#assertProjectRecoveryPredecessor(record.projectId, record.memberId, generation);
  }

  #assertProjectRecoveryPredecessor(projectId: string, actorMemberId: string, authorityGeneration: number): Promise<void> {
    if (!this.options.assertProjectRecoveryPredecessor) throw moduleError('project-recovery-predecessor-unavailable');
    return this.options.assertProjectRecoveryPredecessor(projectId, { actorMemberId, authorityGeneration });
  }

  redeemProjectRecoveryLink(invitation: ProjectRecoveryInvitation, options: CollabOperationOptions = {}): Promise<void> {
    return this.options.lifecycle.runAuthorityTransferClaimant(invitation.link.projectId, async () => {
      const membership = await this.options.loadClaimantMembership?.(invitation.link.projectId);
      if (!membership) throw moduleError('project-recovery-membership-invalid');
      await this.#assertProjectRecoveryPredecessor(invitation.link.projectId, membership.member.id, invitation.link.authorityGeneration);
    }, async () => {
      const projectId = invitation.link.projectId;
      const membership = await this.options.loadClaimantMembership?.(projectId);
      if (!membership || membership.authority.authorityGeneration > invitation.link.authorityGeneration
        || isCollabLocalLANMembership(membership) && membership.hostOwnership.ownsAuthority) throw moduleError('project-recovery-membership-invalid');
      await this.#assertCloudToLanManagerSettled(projectId);
      const pending = await this.options.claimantStore.load(projectId);
      const proofCredential = isCollabLocalLANMembership(membership) ? membership.member.credential
        : await this.options.loadClaimantProofCredential?.(projectId);
      if (!proofCredential) throw moduleError('project-recovery-proof-unavailable');
      const pinned = pending && (pending.cloudPrincipalId !== null || pending.variant !== 'source-issued'
        && pending.retainedAttempts.some(attempt => attempt.cloudPrincipalId !== null));
      const cloudSession = invitation.target.kind === 'cloud'
        ? await this.options.createManagerReissuedClaimConnection?.({ projectId, serverUrl: invitation.target.serverUrl, allowCredentialCreation: !pinned }, options) : undefined;
      try {
        if (invitation.target.kind === 'cloud' && !cloudSession) throw moduleError('project-recovery-target-unavailable');
        const binding = this.#bindProjectRecoveryClaimant(projectId, invitation, cloudSession);
        try {
          await binding.coordinator.startProjectRecovery({ invitation, memberId: membership.member.id,
            memberPersonalRef: membership.member.personalRef, proofCredential,
            ...(invitation.target.kind === 'lan' && isCollabLocalLANMembership(membership) ? { targetCredential: membership.member.credential } : {}) }, options);
        } finally { await binding.dispose(); }
      } finally { cloudSession?.dispose(); }
    });
  }

  #bindProjectRecoveryClaimant(projectId: string, invitation: ProjectRecoveryInvitation, cloudSession?: CloudAuthorityConnection): AuthorityTransferDirectionBinding<AuthorityTransferClaimantCoordinator> {
    const target = invitation.target;
    if (cloudSession && (target.kind !== 'cloud' || cloudSession.serverUrl !== target.serverUrl || cloudSession.projectId !== projectId
      || !cloudSession.supports('project-recovery'))) throw moduleError('project-recovery-target-invalid');
    const lan = target.kind === 'lan' ? new LANMembershipClaimClient({ ...target, projectId, authorityGeneration: invitation.link.authorityGeneration }) : null;
    return this.#bindClaimant({ projectId,
      target: {
        cloudPrincipalId: cloudSession?.principalId ?? null,
        claimTransferredMembership: () => { throw moduleError('project-recovery-variant-invalid'); },
        redeemProjectRecoveryLink: (record, options) => {
          if (lan) return lan.redeemProjectRecoveryLink(record.redemptionRequest, options);
          if (!cloudSession?.redeemProjectRecoveryLink) throw moduleError('project-recovery-target-unavailable');
          return cloudSession.redeemProjectRecoveryLink(record.redemptionRequest, options);
        },
        confirmProjectRecoveryBinding: async (record, options) => {
          const snapshot = lan && record.targetCredential ? await lan.snapshots.readSnapshot(projectId, record.targetCredential, options)
            : await cloudSession?.readSnapshot(projectId, options);
          if (!snapshot || snapshot.project.id !== projectId || snapshot.project.authorityGeneration !== invitation.link.authorityGeneration
            || snapshot.currentMember.id !== record.memberId || snapshot.currentMember.personalRef !== record.memberPersonalRef) throw moduleError('project-recovery-target-identity-invalid');
          return this.convergence.prepareProjectRecovery(record, {
            target: target.kind === 'lan' && lan ? { ...target, endpoint: lan.snapshots.currentEndpoint } : target,
            identity: { authorityGeneration: snapshot.project.authorityGeneration, project: { id: snapshot.project.id, name: snapshot.project.name },
              currentMember: { id: snapshot.currentMember.id, personalRef: snapshot.currentMember.personalRef,
                role: snapshot.currentMember.role, displayName: snapshot.currentMember.displayName }, eventSequence: snapshot.eventSequence },
          });
        },
      },
      convergence: { converge: record => {
        if (record.variant !== 'project-recovery') throw moduleError('project-recovery-variant-invalid');
        return this.convergence.restoreProjectRecovery(record);
      } },
    });
  }

  redeemManagerReissuedClaim(
    invitation: CloudMembershipClaimInvitation | LANMembershipClaimInvitation,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    return this.options.lifecycle.runAuthorityTransferClaimant(
      invitation.claim.projectId,
      () => this.#assertProjectRecoveryPredecessor(invitation.claim.projectId, invitation.claim.memberId, invitation.claim.targetAuthorityGeneration),
      () => this.#redeemManagerReissuedClaimOwned(invitation, options),
    );
  }

  async #redeemManagerReissuedClaimOwned(
    invitation: CloudMembershipClaimInvitation | LANMembershipClaimInvitation,
    options: CollabOperationOptions,
  ): Promise<void> {
    const loadMembership = this.options.loadClaimantMembership;
    const createConnection = this.options.createManagerReissuedClaimConnection;
    if (!loadMembership || invitation.kind === 'cloud-membership-claim' && !createConnection) {
      throw moduleError('authority-transfer-claimant-entry-unavailable');
    }
    const membership = await loadMembership(invitation.claim.projectId);
    if (
      !membership
      || isCollabLocalLANMembership(membership) && membership.hostOwnership.ownsAuthority
      || membership.authority.authorityGeneration > invitation.claim.targetAuthorityGeneration
      || membership.member.id !== invitation.claim.memberId
    ) throw moduleError('authority-transfer-claimant-membership-invalid');
    if (invitation.kind === 'lan-membership-claim') {
      await this.#assertCloudToLanManagerSettled(invitation.claim.projectId);
      const binding = this.#bindLanManagerReissuedClaimant(invitation.claim.projectId, invitation.targetHost, invitation.claim.targetAuthorityGeneration);
      try {
        await binding.coordinator.startManagerReissued({ descriptor: invitation.claim,
          memberPersonalRef: membership.member.personalRef, serverUrl: invitation.targetHost.endpoint }, options);
      } finally { await binding.dispose(); }
      return;
    }
    const pending = await this.options.claimantStore.load(invitation.claim.projectId);
    const hasPinnedCloudPrincipal = pending !== null && (pending.cloudPrincipalId !== null
      || pending.variant === 'manager-reissued' && pending.retainedAttempts.some(attempt => attempt.cloudPrincipalId !== null));
    const cloudSession = await createConnection!({
      allowCredentialCreation: !hasPinnedCloudPrincipal,
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
    input: BindCloudToLANClaimantInput,
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
        confirmSourceTargetBinding: (record, options) => this.#confirmSourceIssuedLanTarget(record, input.targetHost, options),
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
        confirmSourceTargetBinding: (record, options) => this.#confirmSourceIssuedCloudTarget(record, input.cloudSession, options),
        claimTransferredMembership: () => {
          throw moduleError('authority-transfer-claimant-target-replay-invalid');
        },
      },
    });
  }

  #bindCloudToLanTargetOnlyClaimant(input: Readonly<{
    readonly projectId: CollabProjectId;
    readonly targetHost: BindCloudToLANClaimantInput['targetHost'];
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
        confirmSourceTargetBinding: (record, options) => this.#confirmSourceIssuedLanTarget(record, input.targetHost, options),
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
      lanTarget: record.variant === 'project-recovery' ? null : record.lanTarget,
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

  async #confirmSourceIssuedLanTarget(
    record: SourceIssuedAuthorityTransferClaimantRecord,
    targetHost: BindCloudToLANClaimantInput['targetHost'],
    options: CollabOperationOptions,
  ): Promise<void> {
    const generation = record.status.targetAuthority.generation;
    const control = this.options.createLanTargetSnapshotReader?.(record.projectId, targetHost, generation)
      ?? new LANAuthorityTransferTargetSnapshotReader({ ...targetHost, authorityGeneration: generation, projectId: record.projectId });
    const snapshot = await control.readSnapshot(record.projectId, this.#requireTargetCredential(record), options);
    const membership = await this.options.loadClaimantMembership?.(record.projectId);
    if (!membership || snapshot.project.id !== record.projectId || snapshot.currentMember.id !== record.memberId
      || snapshot.currentMember.personalRef !== membership.member.personalRef) {
      throw moduleError('authority-transfer-claimant-target-binding-invalid');
    }
  }

  async #convergeCloudToLanClaimant(
    record: AuthorityTransferClaimantRecord,
    targetHost: BindCloudToLANClaimantInput['targetHost'],
    options: CollabOperationOptions,
  ): Promise<void> {
    if (record.variant !== 'source-issued') throw moduleError('authority-transfer-claimant-variant-invalid');
    const generation = record.status.targetAuthority.generation;
    const control = this.options.createLanTargetSnapshotReader?.(record.projectId, targetHost, generation)
      ?? new LANAuthorityTransferTargetSnapshotReader({ ...targetHost, authorityGeneration: generation, projectId: record.projectId });
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
      if ('cloudSession' in recovered) recovered.cloudSession?.dispose();
    };
    if (record.variant === 'project-recovery') {
      if (recovered.mode !== 'project-recovery') { disposeCloudSession(); throw moduleError('project-recovery-runtime-invalid'); }
      try {
        const binding = this.#bindProjectRecoveryClaimant(record.projectId, record.invitation, recovered.cloudSession);
        return { runtime: binding.coordinator, dispose: async () => { await binding.dispose(); disposeCloudSession(); } };
      } catch (error) { disposeCloudSession(); throw error; }
    }
    if (recovered.mode === 'project-recovery') { disposeCloudSession(); throw moduleError('project-recovery-runtime-invalid'); }
    const direction = record.variant === 'source-issued'
      ? record.status.direction
      : record.lanTarget ? 'cloud-to-lan' : 'lan-to-cloud';
    if (recovered.direction !== direction) {
      disposeCloudSession();
      throw moduleError('authority-transfer-claimant-direction-mismatch');
    }
    try {
      const binding = recovered.mode === 'local-only'
        ? this.#bindLocalOnlyClaimant(record)
        : recovered.mode === 'manager-reissued' && recovered.direction === 'cloud-to-lan'
          ? this.#bindLanManagerReissuedClaimant(record.projectId, recovered.targetHost, recovered.authorityGeneration)
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
  ): LANAuthorityTransferSourceActiveService | null {
    const requireLocalHostAction = (): never => {
      throw new CollabError({
        code: 'authorization-denied',
        safeContext: { reason: 'authority-transfer-local-host-confirmation-required' },
      });
    };
    const service: LANAuthorityTransferSourceActiveService = {
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
      let target: CloudToLANTargetCoordinatorOptions['target'] | null = null;
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
          await disposeCloudToLANTargetPreparation(connection, target);
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
