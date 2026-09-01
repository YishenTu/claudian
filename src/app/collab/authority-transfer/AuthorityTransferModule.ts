import type {
  AcceptLanToCloudTransferTargetRequest,
  CollabAuthorityTransferStatus,
  CollabProjectId,
  RequestLanToCloudTransferRequest,
} from '@claudian-collab/protocol';

import type {
  AuthorityTransferLocalConvergence,
} from '@/app/collab/authority-transfer/AuthorityTransferLocalConvergence';
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
import type { AuthorityTransferClaimantRecord } from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
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
import type { LanAuthorityTransferClient } from '@/app/collab/lan/authority-transfer/LanAuthorityTransferClient';
import type {
  LanAuthorityTransferActor,
  LanAuthorityTransferSourceActiveService,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferRouter';
import { PinnedCollabHttpClient } from '@/app/collab/lan/CollabHttpClient';
import type {
  CollabProjectLifecycleSubsystem,
} from '@/app/collab/lifecycle/CollabProjectLifecycleSubsystem';
import { ProjectControlClient } from '@/app/collab/publish/ProjectControlClient';
import type {
  CloudAuthorityConnection,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';
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
  readonly convergence: AuthorityTransferLocalConvergence;
  readonly createCloudToLanTarget?: (
    projectId: CollabProjectId,
    session: CloudAuthorityConnection,
  ) => CloudToLanTargetCoordinatorOptions['target'];
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
  readonly installationKey: InstallationKey;
  readonly persistence: AuthorityTransferPersistence;
  readonly recoverCloudSession?: (
    record: AuthorityTransferRecord,
  ) => Promise<CloudAuthorityConnection>;
  readonly recoverClaimant?: (
    record: AuthorityTransferClaimantRecord,
  ) => Promise<RecoveredAuthorityTransferClaimantBinding>;
  readonly terminalResolver?: AuthorityTransferRuntimeResolver;
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
  readonly unregister: () => void;
}

function moduleError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
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
  private readonly sourceProposals: LanToCloudSourceProposalCoordinator;
  private readonly sourceBindings = new Map<CollabProjectId, SourceBinding>();
  private readonly targetBindings = new Map<CollabProjectId, TargetBinding>();
  private readonly transferRecovery: AuthorityTransferRecovery;

  constructor(private readonly options: AuthorityTransferModuleOptions) {
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
      this.runtimes,
      options.assertRecoveryOwner,
    );
    this.claimantRecovery = new AuthorityTransferClaimantRecovery(
      options.claimantStore,
      this.claimants,
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
    if (!createTarget) throw moduleError('authority-transfer-target-runtime-unavailable');
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
    const coordinator = new CloudToLanTargetCoordinator({
      cloud: input.cloudSession.lifecycle,
      installationKey: this.options.installationKey,
      persistence: this.options.persistence,
      target,
    });
    const unregister = this.runtimes.register(input.projectId, 'target', coordinator);
    const binding = Object.freeze({ coordinator, unregister });
    this.targetBindings.set(input.projectId, binding);
    try {
      return Object.freeze({
        coordinator,
        dispose: () => {
          if (this.targetBindings.get(input.projectId) !== binding) return;
          this.targetBindings.delete(input.projectId);
          unregister();
          target.dispose?.();
        },
        targetUrl: input.expectedTargetUrl,
      });
    } catch (error) {
      this.targetBindings.delete(input.projectId);
      unregister();
      target.dispose?.();
      throw error;
    }
  }

  bindLanToCloudClaimant(
    input: BindLanToCloudClaimantInput,
  ): AuthorityTransferDirectionBinding<AuthorityTransferClaimantCoordinator> {
    this.assertCloudSession(input.projectId, input.cloudSession);
    return this.bindClaimant({
      convergence: {
        converge: async (record, options) => {
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

  bindCloudToLanClaimant(
    input: BindCloudToLanClaimantInput,
  ): AuthorityTransferDirectionBinding<AuthorityTransferClaimantCoordinator> {
    this.assertCloudSession(input.projectId, input.cloudSession);
    const control = this.lanTargetSnapshotReader(input.projectId, input.targetHost);
    return this.bindClaimant({
      convergence: {
        converge: async (record, options) => {
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
            memberCredential: targetCredential,
            snapshot,
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
            memberCredential: targetCredential,
            snapshot,
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
      lanTarget: record.lanTarget,
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
      ...(input.now ? { now: input.now } : {}),
      source: input.source,
      store: this.options.claimantStore,
      target: input.target,
    });
    const unregister = this.claimants.register(input.projectId, coordinator);
    return Object.freeze({ coordinator, dispose: unregister });
  }

  private requireTargetCredential(record: AuthorityTransferClaimantRecord): string {
    if (!record.targetCredential) {
      throw moduleError('authority-transfer-claimant-target-credential-missing');
    }
    return record.targetCredential;
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
    if (recovered.direction !== record.status.direction) {
      disposeCloudSession();
      throw moduleError('authority-transfer-claimant-direction-mismatch');
    }
    try {
      const binding = recovered.mode === 'local-only'
        ? this.bindLocalOnlyClaimant(record)
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
          return binding.coordinator;
        } catch (error) {
          await binding.dispose();
          throw error;
        }
      }
      return (await this.bindCloudToLanTarget({
        cloudSession: session,
        expectedTargetUrl: record.status.targetUrl,
        projectId: record.projectId,
      })).coordinator;
    } catch (error) {
      session.dispose();
      throw error;
    }
  }
}
