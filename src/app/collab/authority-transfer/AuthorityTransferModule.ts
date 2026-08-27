import type {
  CollabProjectId,
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
  LanToCloudSourceCoordinator,
  type LanToCloudSourceCoordinatorOptions,
} from '@/app/collab/authority-transfer/lan-to-cloud/LanToCloudSourceCoordinator';
import type {
  AuthorityTransferPersistence,
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
  CloudAuthorityLifecycleSession,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface AuthorityTransferSourceRouteInput {
  readonly authenticateMemberCredential: (
    credential: string,
  ) => Promise<LanAuthorityTransferActor>;
  readonly hostMemberId: string;
  readonly projectId: CollabProjectId;
}

export interface AuthorityTransferModuleOptions {
  readonly claimantStore: AuthorityTransferClaimantCoordinatorOptions['store'];
  readonly convergence: AuthorityTransferLocalConvergence;
  readonly createCloudToLanTarget?: (
    projectId: CollabProjectId,
    session: CloudAuthorityLifecycleSession,
  ) => CloudToLanTargetCoordinatorOptions['target'];
  readonly createLanToCloudSource: (
    projectId: CollabProjectId,
    session: CloudAuthorityLifecycleSession,
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
  readonly persistence: AuthorityTransferPersistence;
  readonly recoverCloudSession?: (
    record: AuthorityTransferRecord,
  ) => Promise<CloudAuthorityLifecycleSession>;
  readonly recoverClaimant?: (
    record: AuthorityTransferClaimantRecord,
  ) => Promise<RecoveredAuthorityTransferClaimantBinding>;
  readonly terminalResolver?: AuthorityTransferRuntimeResolver;
}

export interface BindLanToCloudSourceInput {
  readonly cloudSession: CloudAuthorityLifecycleSession;
  readonly expectedSourceEndpoint?: string;
  readonly projectId: CollabProjectId;
}

export interface BindCloudToLanTargetInput {
  readonly cloudSession: CloudAuthorityLifecycleSession;
  readonly expectedTargetUrl?: string;
  readonly projectId: CollabProjectId;
}

export type BindAuthorityTransferClaimantInput = Omit<
  AuthorityTransferClaimantCoordinatorOptions,
  'store'
> & Readonly<{ readonly projectId: CollabProjectId }>;

export interface BindLanToCloudClaimantInput {
  readonly cloudSession: CloudAuthorityLifecycleSession;
  readonly lanClient: LanAuthorityTransferClient;
  readonly memberCredential: string;
  readonly projectId: CollabProjectId;
}

export interface BindCloudToLanClaimantInput {
  readonly cloudSession: CloudAuthorityLifecycleSession;
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
      readonly cloudSession: CloudAuthorityLifecycleSession;
      readonly direction: 'lan-to-cloud';
      readonly lanClient: LanAuthorityTransferClient;
      readonly memberCredential: string;
      readonly mode: 'full';
    }>
  | Readonly<{
      readonly cloudSession: CloudAuthorityLifecycleSession;
      readonly direction: 'cloud-to-lan';
      readonly lanClient: LanAuthorityTransferClient;
      readonly mode: 'full';
      readonly targetHost: BindCloudToLanClaimantInput['targetHost'];
    }>
  | Readonly<{
      readonly cloudSession: CloudAuthorityLifecycleSession;
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
    this.transferRecovery = new AuthorityTransferRecovery(
      options.persistence,
      this.runtimes,
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
    if (this.sourceBindings.has(input.projectId) || this.targetBindings.has(input.projectId)) {
      throw moduleError('authority-transfer-direction-runtime-conflict');
    }
    const coordinator = new LanToCloudSourceCoordinator({
      cloud: input.cloudSession.lifecycle,
      persistence: this.options.persistence,
      source: this.options.createLanToCloudSource(input.projectId, input.cloudSession),
    });
    const unregister = this.runtimes.register(input.projectId, 'source', coordinator);
    let cleanupRoute: () => Promise<void> = async () => undefined;
    const binding: SourceBinding = {
      cleanupRoute: () => cleanupRoute(),
      coordinator,
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
    const coordinator = new CloudToLanTargetCoordinator({
      cloud: input.cloudSession.lifecycle,
      persistence: this.options.persistence,
      target,
    });
    const unregister = this.runtimes.register(input.projectId, 'target', coordinator);
    const binding = Object.freeze({ coordinator, unregister });
    this.targetBindings.set(input.projectId, binding);
    try {
      const prepared = await target.prepareTarget(input.expectedTargetUrl);
      if (input.expectedTargetUrl && prepared.targetUrl !== input.expectedTargetUrl) {
        throw moduleError('authority-transfer-target-recovery-endpoint-mismatch');
      }
      return Object.freeze({
        coordinator,
        dispose: () => {
          if (this.targetBindings.get(input.projectId) !== binding) return;
          this.targetBindings.delete(input.projectId);
          unregister();
          target.dispose?.();
        },
        targetUrl: prepared.targetUrl,
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
            developmentActorId: input.cloudSession.developmentActorId,
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
    readonly cloudSession: CloudAuthorityLifecycleSession;
    readonly projectId: CollabProjectId;
  }>): AuthorityTransferDirectionBinding<AuthorityTransferClaimantCoordinator> {
    this.assertCloudSession(input.projectId, input.cloudSession);
    return this.bindClaimant({
      convergence: {
        converge: async (record, options) => {
          const snapshot = await input.cloudSession.readSnapshot(record.projectId, options);
          await this.convergence.lanToCloudMember({
            developmentActorId: input.cloudSession.developmentActorId,
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
    const binding = this.sourceBindings.get(input.projectId);
    if (!binding) return null;
    const requireHost = (actor: LanAuthorityTransferActor): void => {
      if (actor.memberId !== input.hostMemberId) {
        throw new CollabError({ code: 'authorization-denied' });
      }
    };
    const service: LanAuthorityTransferSourceActiveService = {
      acceptLanToCloudTransferTarget: async (actor, request) => {
        requireHost(actor);
        return this.options.lifecycle.runExclusive(
          input.projectId,
          'authority-transfer',
          'continuation',
          () => binding.coordinator.acceptAndTransfer(request),
        );
      },
      authenticateMemberCredential: input.authenticateMemberCredential,
      cancelProjectAuthorityTransfer: async (actor, request) => {
        requireHost(actor);
        if (request.projectId !== input.projectId) {
          throw new CollabError({ code: 'project-not-found' });
        }
        return this.options.lifecycle.runExclusive(
          input.projectId,
          'authority-transfer',
          'continuation',
          () => binding.coordinator.cancel(input.projectId),
        );
      },
      getProjectAuthorityTransfer: async (_actor, request) => {
        const record = await this.options.persistence.load(input.projectId);
        if (
          request.projectId !== input.projectId
          || !record
          || record.localRole !== 'source'
          || record.transferId !== request.transferId
        ) throw new CollabError({ code: 'authority-transfer-not-found' });
        return record.status;
      },
      requestLanToCloudTransfer: (_actor, request) => (
        binding.coordinator.propose(request)
      ),
    };
    return Object.freeze(service);
  }

  private assertCloudSession(
    projectId: CollabProjectId,
    session: CloudAuthorityLifecycleSession,
  ): void {
    if (
      session.projectId !== projectId
      || !session.supports('authority-transfer')
      || !session.supports('project-snapshot')
    ) throw moduleError('authority-transfer-cloud-session-incompatible');
  }

  private async resolveRuntime(
    record: AuthorityTransferRecord,
  ): Promise<AuthorityTransferDirectionRuntime | null> {
    const bound = record.localRole === 'source'
      ? this.sourceBindings.get(record.projectId)?.coordinator
      : this.targetBindings.get(record.projectId)?.coordinator;
    if (bound) return bound;
    if (record.status.state === 'completed') {
      return this.options.terminalResolver?.resolve(record) ?? null;
    }
    const recoverCloudSession = this.options.recoverCloudSession;
    if (!recoverCloudSession) {
      return this.options.terminalResolver?.resolve(record) ?? null;
    }
    const session = await recoverCloudSession(record);
    try {
      return record.localRole === 'source'
        ? (await this.bindLanToCloudSource({
            cloudSession: session,
            ...(record.sourceLanEndpoint
              ? { expectedSourceEndpoint: record.sourceLanEndpoint }
              : {}),
            projectId: record.projectId,
          })).coordinator
        : (await this.bindCloudToLanTarget({
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
