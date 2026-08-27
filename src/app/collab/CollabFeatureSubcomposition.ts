import { randomUUID } from 'node:crypto';

import {
  AuthorityTransferLocalConvergence,
} from '@/app/collab/authority-transfer/AuthorityTransferLocalConvergence';
import {
  AuthorityTransferLocalFence,
} from '@/app/collab/authority-transfer/AuthorityTransferLocalFence';
import {
  AuthorityTransferModule,
} from '@/app/collab/authority-transfer/AuthorityTransferModule';
import {
  isAuthorityTransferTerminalResponderExpired,
} from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import {
  AuthorityTransferClaimantBindingResolver,
} from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantBindingResolver';
import {
  ProductionCloudToLanTargetEffects,
} from '@/app/collab/authority-transfer/cloud-to-lan/ProductionCloudToLanTargetEffects';
import {
  ProductionLanToCloudSourceEffects,
} from '@/app/collab/authority-transfer/lan-to-cloud/ProductionLanToCloudSourceEffects';
import { CloudBootstrapBindingFinalizer } from '@/app/collab/bootstrap/CloudBootstrapBindingFinalizer';
import { CloudBootstrapCoordinator } from '@/app/collab/bootstrap/CloudBootstrapCoordinator';
import { CloudBootstrapLocalFence } from '@/app/collab/bootstrap/CloudBootstrapLocalFence';
import { CloudBootstrapReadinessCollector } from '@/app/collab/bootstrap/CloudBootstrapReadiness';
import { CloudBootstrapService } from '@/app/collab/bootstrap/CloudBootstrapService';
import {
  developmentBootstrapManifestSha256,
} from '@/app/collab/bootstrap/CloudBootstrapTransitionRecord';
import {
  DevelopmentBootstrapCloudClient,
} from '@/app/collab/bootstrap/DevelopmentBootstrapCloudClient';
import {
  LocalCloudBootstrapBindingEffects,
} from '@/app/collab/bootstrap/LocalCloudBootstrapBindingEffects';
import {
  LocalCloudBootstrapReadinessInspector,
} from '@/app/collab/bootstrap/LocalCloudBootstrapReadinessInspector';
import {
  LocalDevelopmentBootstrapSource,
} from '@/app/collab/bootstrap/LocalDevelopmentBootstrapSource';
import type { ClaudianCollabService } from '@/app/collab/ClaudianCollabService';
import {
  CollabFeatureService,
  type CollabLocalExitPort,
  type CollabRetirementPort,
} from '@/app/collab/CollabFeatureService';
import {
  isCollabLocalCloudMembership,
  isCollabLocalLanMembership,
} from '@/app/collab/CollabLocalProjectRepository';
import { FilesystemLocalRepositoryIdentity } from '@/app/collab/exit/FilesystemLocalRepositoryIdentity';
import {
  LocalExitProjectStore,
  ManagerResponsibilityReceiptStore,
} from '@/app/collab/exit/LocalExitStores';
import {
  LocalProjectCleanupCoordinator,
  type LocalProjectCleanupPort,
} from '@/app/collab/exit/LocalProjectCleanupCoordinator';
import { LocalProjectExitCoordinator } from '@/app/collab/exit/LocalProjectExitCoordinator';
import { PendingLeaveAuthorityService } from '@/app/collab/exit/PendingLeaveAuthorityService';
import { PendingLeaveWorker } from '@/app/collab/exit/PendingLeaveWorker';
import { RetiredProjectFinalizer } from '@/app/collab/exit/RetiredProjectFinalizer';
import {
  ensureTrustedCollabOrigin,
  rotateAuthorityTransferOrigin,
  rotateCloudBootstrapOrigin,
} from '@/app/collab/git/CollabGitOriginPolicy';
import { CollabLifecycleJournalStore } from '@/app/collab/lifecycle/CollabLifecycleJournalStore';
import {
  createCollabProjectLifecycleDurableOwners,
} from '@/app/collab/lifecycle/CollabProjectLifecycleOwners';
import { CollabProjectLifecycleSubsystem } from '@/app/collab/lifecycle/CollabProjectLifecycleSubsystem';
import { CollabMembershipService } from '@/app/collab/membership/CollabMembershipService';
import {
  ManagerResponsibilityOperationCoordinator,
} from '@/app/collab/membership/ManagerResponsibilityOperationCoordinator';
import type { CollabProjectSetupService } from '@/app/collab/project/CollabProjectSetupService';
import { CollabPublicationService } from '@/app/collab/publish/CollabPublicationService';
import { CloudAuthorityAdapter } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import {
  CollabAuthorityGitNetworkEnvironment,
} from '@/app/collab/remote-authority/CollabAuthorityGitNetworkEnvironment';
import { CloudRetirementClient } from '@/app/collab/retirement/CloudRetirementClient';
import { RetirementAcknowledgementWorker } from '@/app/collab/retirement/RetirementAcknowledgementWorker';
import { RetirementClientHandler } from '@/app/collab/retirement/RetirementClientHandler';
import { RetirementLocalRecovery } from '@/app/collab/retirement/RetirementLocalRecovery';
import { type CollabFinalizeRetiredProjectRequest, type CollabLeaveProjectRequest, type CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CollabFeatureSubcompositionOptions {
  readonly cloudAuthority?: Pick<CloudAuthorityAdapter, 'create' | 'createLifecycle'>;
  readonly foundation: ClaudianCollabService;
  readonly projectSetup: CollabProjectSetupService;
  readonly vaultRoot: string;
}

export interface CollabFeatureSubcomposition {
  readonly authorityTransfer: AuthorityTransferModule;
  readonly feature: CollabFeatureService;
}

function cancelled(): CollabError {
  return new CollabError({ code: 'cancelled' });
}

function bootstrapCompositionError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function normalizedFingerprint(value: string): string {
  return value.replaceAll(':', '').toLocaleLowerCase('en-US');
}

export function createCollabFeatureSubcomposition(
  options: CollabFeatureSubcompositionOptions,
): CollabFeatureSubcomposition {
  const { foundation, projectSetup, vaultRoot } = options;
  const journals = new CollabLifecycleJournalStore(vaultRoot);
  const transitions = foundation.cloudBootstrapTransitions;
  const pendingLeaves = journals.pendingLeaves;
  const pendingLeaveAuthority = new PendingLeaveAuthorityService({
    hostTransitionCandidates: foundation.hostTransitionCandidates,
  });
  const managerReceipts = new ManagerResponsibilityReceiptStore(
    foundation.local.projects,
  );
  const managerResponsibilityOperations = new ManagerResponsibilityOperationCoordinator();
  const exitProjects = new LocalExitProjectStore(foundation.local.projects);
  const leaveCleanupRecords = foundation.local.projects.localCleanup;
  const retiredCleanupRecords = journals.retiredCleanups;
  let leaveCleanupPromise: Promise<LocalProjectCleanupCoordinator> | null = null;
  const requireLeaveCleanup = (): Promise<LocalProjectCleanupCoordinator> => {
    if (leaveCleanupPromise) return leaveCleanupPromise;
    const pending = foundation.requireGitFoundation().then(git => (
      new LocalProjectCleanupCoordinator(
        foundation.local.workspace,
        git.repositories,
        leaveCleanupRecords,
      )
    ));
    leaveCleanupPromise = pending;
    void pending.catch(() => {
      if (leaveCleanupPromise === pending) leaveCleanupPromise = null;
    });
    return pending;
  };
  const retiredCleanup = new LocalProjectCleanupCoordinator(
    foundation.local.workspace,
    new FilesystemLocalRepositoryIdentity(),
    retiredCleanupRecords,
  );
  const retiredFinalizer = new RetiredProjectFinalizer(
    retiredCleanup,
    foundation.local.projects,
  );
  const leaveCleanup: LocalProjectCleanupPort = {
    cleanup: async (...args) => (await requireLeaveCleanup()).cleanup(...args),
    completeRetiredFinalization: async (...args) => (
      (await requireLeaveCleanup()).completeRetiredFinalization(...args)
    ),
    finalizeRetiredChoice: async (...args) => (
      (await requireLeaveCleanup()).finalizeRetiredChoice(...args)
    ),
    resume: async (...args) => (await requireLeaveCleanup()).resume(...args),
  };

  let lifecycle: CollabProjectLifecycleSubsystem | null = null;
  let publication: CollabPublicationService | null = null;
  const requireLifecycle = (): CollabProjectLifecycleSubsystem => {
    if (!lifecycle) {
      throw new CollabError({
        code: 'not-initialized',
        safeContext: { reason: 'collab-lifecycle-not-composed' },
      });
    }
    return lifecycle;
  };
  const requirePublication = (): CollabPublicationService => {
    if (!publication) {
      throw new CollabError({
        code: 'not-initialized',
        safeContext: { reason: 'collab-publication-not-composed' },
      });
    }
    return publication;
  };
  const cloudAuthority = options.cloudAuthority ?? new CloudAuthorityAdapter();
  const cloudRetirement = new CloudRetirementClient({
    createLifecycle: binding => cloudAuthority.createLifecycle(binding),
    createSession: membership => cloudAuthority.create(membership),
  });
  const acknowledgementWorker = new RetirementAcknowledgementWorker(
    foundation.local.projects,
    {
      acknowledge: input => foundation.acknowledgeRetirement(input),
      acknowledgeCloud: input => cloudRetirement.acknowledge(input, {
        ...(input.signal ? { signal: input.signal } : {}),
      }),
    },
    {
      projectRecoveryAdmission: (projectId, operation) => requireLifecycle().runExclusive(
        projectId,
        'retirement',
        'recovery',
        operation,
      ),
    },
  );
  const retirementHandler = new RetirementClientHandler(
    foundation.local.projects,
    {
      closeProject: async projectId => {
        lifecycle?.closeProjectAdmission(projectId);
        requirePublication().closeProject(projectId);
      },
      drainProject: projectId => requirePublication().drainProject(projectId),
    },
    acknowledgementWorker,
    retiredCleanup,
    {
      pendingLeaveCleanup: {
        resume: (...args) => leaveCleanup.resume(...args),
      },
      pendingLeaveCleanupRecords: leaveCleanupRecords,
      pendingLeaves,
      retiredCleanupRecords,
      publish: () => {
        void lifecycle?.refreshLifecycleProjection().catch(() => undefined);
      },
    },
  );
  foundation.setRetirementHandler(retirementHandler);
  const membership = new CollabMembershipService(
    foundation.local.projects,
    {
      readCoordinationSnapshot: (...args) => (
        requirePublication().readCoordinationSnapshot(...args)
      ),
    },
    {},
    {
      managerResponsibilityAdmission: (projectId, operation) => (
        requireLifecycle().runExclusive(
          projectId,
          'manager-responsibility',
          'operation',
          operation,
        )
      ),
      managerReceipts,
      managerResponsibilityOperations,
      pendingLeaves,
    },
  );
  publication = new CollabPublicationService(foundation, {
    discovery: foundation.discovery,
    isLocalHostRunning: projectId => foundation.lanHost.isProjectRunning(projectId),
    managerResponsibility: {
      reconcileSnapshot: snapshot => requireLifecycle().runExclusive(
          snapshot.project.id,
          'manager-responsibility',
          'continuation',
          () => membership.reconcileManagerResponsibilitySnapshot(snapshot),
      ),
    },
    reconnect: foundation.reconnect,
    retirement: retirementHandler,
    retirementAdmission: (projectId, operation) => requireLifecycle().runRetirementAdoption(
      projectId,
      operation,
    ),
    vaultRoot,
  });
  foundation.lanHost.bindConnectionProjection({
    resetProjectConnection: projectId => requirePublication().resetProjectConnection(projectId),
  });
  const hostTransfer = foundation.createHostTransferService(
    publication,
    (projectId, operation) => requireLifecycle().runExclusive(
      projectId,
      'host-transfer',
      'recovery',
      operation,
    ),
  );
  let exitCoordinator: LocalProjectExitCoordinator | null = null;
  const requireExitCoordinator = (): Promise<LocalProjectExitCoordinator> => {
    if (!exitCoordinator) {
      exitCoordinator = new LocalProjectExitCoordinator(
        exitProjects,
        pendingLeaves,
        {
          prepareLeave: input => pendingLeaveAuthority.prepare({
            ...(input.managerResponsibilityOfferId === undefined ? {} : {
              managerResponsibilityOfferId: input.managerResponsibilityOfferId,
            }),
            pending: input.pending,
            ...(input.signal ? { signal: input.signal } : {}),
          }),
          refreshLeave: input => pendingLeaveAuthority.refresh({
            pending: input.pending,
            ...(input.signal ? { signal: input.signal } : {}),
          }),
          resolveLeaveHost: input => pendingLeaveAuthority.resolveHost(input),
          settleLeave: input => pendingLeaveAuthority.settle({
            pending: input.pending,
            ...(input.signal ? { signal: input.signal } : {}),
          }),
        },
        leaveCleanup,
        {
          completeProject: suspension => (
            requirePublication().completeProjectSuspension(suspension)
          ),
          resumeProject: suspension => requirePublication().resumeProject(suspension),
          suspendProject: projectId => requirePublication().suspendProject(projectId),
        },
        {
          managerReceipts,
          managerResponsibilityOperations,
          retirement: retirementHandler,
        },
      );
    }
    return Promise.resolve(exitCoordinator);
  };
  const localExit: CollabLocalExitPort = {
    leaveProject: async (
      request: CollabLeaveProjectRequest,
      operationOptions?: CollabOperationOptions,
    ): Promise<void> => {
      const result = await (await requireExitCoordinator()).leave(request, operationOptions);
      if (result.status === 'cancelled') throw cancelled();
    },
  };
  const pendingLeaveWorker = new PendingLeaveWorker(pendingLeaves, {
    resume: async (...args) => (await requireExitCoordinator()).resume(...args),
  }, (projectId, operation) => requireLifecycle().runExclusive(
    projectId,
    'local-exit',
    'recovery',
    operation,
  ));
  const retirementLocalRecovery = new RetirementLocalRecovery(
    foundation.local.projects,
    pendingLeaves,
    retiredCleanupRecords,
    retirementHandler,
    retiredFinalizer,
    (projectId, operation) => requireLifecycle().runExclusive(
      projectId,
      'retirement',
      'recovery',
      operation,
    ),
  );
  const retirement: CollabRetirementPort = {
    close: () => retirementHandler.close(),
    finalizeRetiredProject: async (
      request: CollabFinalizeRetiredProjectRequest,
      operationOptions?: CollabOperationOptions,
    ): Promise<void> => {
      await retiredFinalizer.finalize({
        choice: request.cleanupChoice,
        projectId: request.projectId,
      }, operationOptions);
    },
    retireProject: async (request, operationOptions): Promise<void> => {
      const localMembership = await foundation.local.projects.loadMembership(request.projectId);
      const result = localMembership && isCollabLocalCloudMembership(localMembership)
        ? await cloudRetirement.retire(localMembership, request, operationOptions)
        : await foundation.retireProject(request, operationOptions?.signal);
      await requireLifecycle().runRetirementAdoption(
        request.projectId,
        () => retirementHandler.handle(result, 'response'),
      );
    },
    retryProjectCleanup: async (projectId, operationOptions): Promise<void> => {
      if (operationOptions?.signal?.aborted) throw cancelled();
      await retirementHandler.resume(projectId);
    },
  };
  lifecycle = new CollabProjectLifecycleSubsystem({
    closeRecovery: () => acknowledgementWorker.close(),
    durableOwners: createCollabProjectLifecycleDurableOwners({
      cloudBootstrapTransitions: transitions,
      hostTransferRecovery: foundation.local.projects.hostTransferRecovery,
      localCleanup: foundation.local.projects.localCleanup,
      managerReceipts,
      pendingLeaves,
      retiredCleanups: retiredCleanupRecords,
      retirements: foundation.local.projects,
      retirementTombstones: foundation.local.projects,
    }),
    hostTransfer,
    localExit,
    recoveryStages: [
      {
        name: 'retirement-responders',
        run: () => foundation.restoreRetirementResponders(
          (projectId, operation) => requireLifecycle().runExclusive(
            projectId,
            'retirement',
            'recovery',
            operation,
          ),
        ),
      },
      {
        name: 'host-transfers',
        run: operationOptions => hostTransfer.resume(operationOptions),
      },
      {
        name: 'pending-leaves',
        run: async operationOptions => {
          const result = await pendingLeaveWorker.runOnce(operationOptions.signal);
          if (result.failed.length > 0) {
            throw new CollabError({
              code: 'durable-progress-recovery-required',
              recoveryActions: ['resume'],
              safeContext: { reason: 'pending-leave-recovery-incomplete' },
            });
          }
        },
      },
      {
        name: 'retirement-acknowledgements',
        run: async operationOptions => {
          const projectIds = await foundation.local.projects
            .listRetirementAcknowledgementProjectIds();
          for (const projectId of projectIds) {
            if (operationOptions.signal?.aborted) break;
            acknowledgementWorker.schedule(projectId);
          }
        },
      },
      {
        name: 'local-retirement',
        run: operationOptions => retirementLocalRecovery.resume(operationOptions),
      },
    ],
    retirement,
  });
  foundation.lanHost.bindProjectLifecycleAdmissions({
    hostTransfer: (projectId, operation) => requireLifecycle().runExclusive(
      projectId,
      'host-transfer',
      'continuation',
      operation,
    ),
    retirement: (projectId, operation) => requireLifecycle().runExclusive(
      projectId,
      'retirement',
      'continuation',
      operation,
    ),
  });

  const bootstrapWorkSessions: CloudBootstrapLocalFence = new CloudBootstrapLocalFence({
    admission: {
      drainAdmittedOperations: () => feature.drainAdmittedOperations(),
      resumeProjectAdmission: suspension => feature.resumeProjectAdmission(suspension),
      suspendProjectAdmission: projectId => feature.suspendProjectAdmission(projectId),
    },
    workSessions: {
      resumeProject: suspension => requirePublication().resumeProject(suspension),
      suspendProject: projectId => requirePublication().suspendProject(projectId),
    },
  });
  const source = new LocalDevelopmentBootstrapSource({ foundation, vaultRoot });
  const readiness = new CloudBootstrapReadinessCollector(
    new LocalCloudBootstrapReadinessInspector({
      foundation,
      isProjectQuiesced: projectId => bootstrapWorkSessions.isProjectQuiesced(projectId),
      managerResponsibilityReceipts: managerReceipts,
      vaultRoot,
    }),
  );
  const bootstrapGitNetwork = new CollabAuthorityGitNetworkEnvironment(vaultRoot);
  const binding = new CloudBootstrapBindingFinalizer({
    effects: new LocalCloudBootstrapBindingEffects({
      activation: {
        get: (record, signal) => new DevelopmentBootstrapCloudClient({
          developmentActorId: record.developmentActorId,
          serverUrl: record.newAuthority.serverUrl,
        }).get({ attemptId: record.attemptId }, signal),
      },
      authorityAdapter: new CloudAuthorityAdapter(),
      authorityLifecycle: {
        closeAuthority: projectId => foundation.closeAuthority(projectId),
      },
      git: {
        assertOrigin: async (record, repositoryPath) => ensureTrustedCollabOrigin(
          (await foundation.requireGitFoundation()).repositories,
          {
            allowHostRemoteRepair: false,
            projectId: record.projectId,
            remoteUrl: record.newAuthority.gitRemoteUrl,
            repositoryPath,
          },
          'cloud-bootstrap-binding-origin-mismatch',
        ),
        fetchFromUrl: async (...input) => (
          (await foundation.requireGitFoundation()).repositories.fetchFromUrl(...input)
        ),
        network: (projectId, network) => bootstrapGitNetwork.resolve(projectId, network),
        resolveRefs: async (...input) => (
          (await foundation.requireGitFoundation()).repositories.resolveRefs(...input)
        ),
        rotateOrigin: async (record, repositoryPath) => rotateCloudBootstrapOrigin(
          (await foundation.requireGitFoundation()).repositories,
          {
            newRemoteUrl: record.newAuthority.gitRemoteUrl,
            oldRemoteUrl: record.oldAuthority.gitRemoteUrl,
            projectId: record.projectId,
            repositoryPath,
          },
        ),
      },
      projects: foundation.local.projects,
      readiness,
      workspace: foundation.local.workspace,
    }),
    transitions,
  });
  const cloudBootstrap = new CloudBootstrapService({
    createCoordinator: ({ developmentActorId, serverUrl }) => (
      new CloudBootstrapCoordinator({
        binding,
        cloud: new DevelopmentBootstrapCloudClient({
          developmentActorId,
          serverUrl,
        }),
        createFenceId: () => `bootstrap-fence-${randomUUID().replaceAll('-', '')}`,
        formerHost: {
          stopAndDrain: async projectId => {
            const stopped = await foundation.lanHost.stopProject(projectId);
            const membership = await foundation.local.projects.loadMembership(projectId);
            if (
              stopped.status !== 'stopped'
              || foundation.lanHost.isProjectRunning(projectId)
              || !membership
              || !isCollabLocalLanMembership(membership)
              || membership.project.id !== projectId
              || !membership.hostOwnership.ownsAuthority
              || membership.hostOwnership.autoStart !== false
            ) {
              throw bootstrapCompositionError('cloud-bootstrap-host-stop-not-durable');
            }
            return {
              autoStartDisabled: true,
              resourcesDrained: true,
              routeUnregistered: true,
              stoppedAt: new Date().toISOString(),
            };
          },
        },
        localIdentity: {
          load: async projectId => {
            const membership = await foundation.local.projects.loadMembership(projectId);
            if (
              !membership
              || !isCollabLocalLanMembership(membership)
              || !membership.authority.endpoint
              || !membership.authority.gitRemoteUrl
              || !membership.authority.hostCaFingerprint
            ) {
              throw bootstrapCompositionError('cloud-bootstrap-local-identity-unavailable');
            }
            return {
              authorityKind: 'lan',
              caFingerprint: normalizedFingerprint(
                membership.authority.hostCaFingerprint,
              ),
              endpoint: membership.authority.endpoint,
              gitRemoteUrl: membership.authority.gitRemoteUrl,
              memberId: membership.member.id,
              ownsAuthority: membership.hostOwnership.ownsAuthority,
              projectId: membership.project.id,
            };
          },
        },
        readiness,
        source,
        transitions,
        workSessions: bootstrapWorkSessions,
      })
    ),
    fenceUncertainProject: projectId => bootstrapWorkSessions.closeAndDrain(projectId),
    projectRecoveryAdmission: (projectId, operation) => requireLifecycle().runExclusive(
      projectId,
      'cloud-bootstrap',
      'recovery',
      operation,
    ),
    recoverLocalArtifacts: projectRecoveryAdmission => source.recoverArtifacts(
      async manifest => {
        const record = await transitions.load(manifest.comparison.projectId);
        return record?.attemptId === manifest.attemptId
          && record.manifestSha256 === developmentBootstrapManifestSha256(manifest);
      },
      projectRecoveryAdmission,
    ),
    transitions,
  });
  const lifecycleCloudBootstrap = lifecycle.bindCloudBootstrap(cloudBootstrap);
  const lifecycleMembership = lifecycle.bindMembership(membership);

  const feature: CollabFeatureService = new CollabFeatureService(foundation, projectSetup, {
    cloudBootstrap: lifecycleCloudBootstrap,
    hostTransfer: lifecycle.hostTransfer,
    join: foundation.join,
    lanHost: foundation.lanHost,
    lifecycleRecovery: lifecycle.lifecycleRecovery,
    localExit: lifecycle.localExit,
    membership: lifecycleMembership,
    publication,
    retirement: lifecycle.retirement,
    vaultRoot,
  });
  lifecycle.bindProjection({
    closeProjectAdmission: projectId => feature.closeProjectAdmission(projectId),
    refreshLifecycleProjection: () => feature.refreshLifecycleProjection(),
  });

  const authorityTransferLocalFence = new AuthorityTransferLocalFence({
    admission: {
      drainAdmittedOperations: () => feature.drainAdmittedOperations(),
      resumeProjectAdmission: suspension => feature.resumeProjectAdmission(suspension),
      suspendProjectAdmission: projectId => feature.suspendProjectAdmission(projectId),
    },
    workSessions: {
      resumeProject: suspension => requirePublication().resumeProject(suspension),
      suspendProject: projectId => requirePublication().suspendProject(projectId),
    },
  });
  const authorityTransferConvergence = new AuthorityTransferLocalConvergence({
    activity: {
      transitionProject: (projectId, operation) => (
        authorityTransferLocalFence.run(projectId, operation)
      ),
    },
    git: {
      rotate: async input => rotateAuthorityTransferOrigin(
        (await foundation.requireGitFoundation()).repositories,
        input,
      ),
    },
    projects: foundation.local.projects,
    workspace: foundation.local.workspace,
  });
  const claimantBindingResolver = new AuthorityTransferClaimantBindingResolver({
    createCloudLifecycle: binding => cloudAuthority.createLifecycle(binding),
    loadMembership: projectId => foundation.local.projects.loadMembership(projectId),
  });
  const authorityTransfer = new AuthorityTransferModule({
    activateLanToCloudSourceRoute: (projectId, expectedEndpoint) => (
      foundation.activateAuthorityTransferSourceRoute(projectId, expectedEndpoint)
    ),
    claimantStore: foundation.local.projects.authorityTransferClaimants,
    convergence: authorityTransferConvergence,
    createCloudToLanTarget: (projectId, cloudSession) => (
      new ProductionCloudToLanTargetEffects({
        cloudSession,
        convergence: authorityTransferConvergence,
        foundation,
        persistence: foundation.authorityTransfers,
        projectId,
      })
    ),
    createLanToCloudSource: (projectId, cloudSession) => (
      new ProductionLanToCloudSourceEffects({
        cloudSession,
        convergence: authorityTransferConvergence,
        foundation,
        persistence: foundation.authorityTransfers,
        projectId,
      })
    ),
    lifecycle,
    persistence: foundation.authorityTransfers,
    recoverCloudSession: async record => {
      const membership = await foundation.local.projects.loadMembership(record.projectId);
      if (!membership) {
        throw bootstrapCompositionError('authority-transfer-membership-missing');
      }
      if (record.localRole === 'source') {
        if (!isCollabLocalLanMembership(membership)) {
          throw bootstrapCompositionError('authority-transfer-source-membership-invalid');
        }
        return cloudAuthority.createLifecycle({
          developmentActorId: membership.member.id,
          projectId: record.projectId,
          serverUrl: record.status.targetUrl,
        });
      }
      if (!isCollabLocalCloudMembership(membership)) {
        throw bootstrapCompositionError('authority-transfer-target-membership-invalid');
      }
      return cloudAuthority.createLifecycle({
        developmentActorId: membership.authority.developmentActorId,
        projectId: record.projectId,
        serverUrl: membership.authority.serverUrl,
      });
    },
    recoverClaimant: record => claimantBindingResolver.resolve(record),
    terminalResolver: {
      resolve: async record => {
        if (
          record.localRole === 'target'
          && record.status.direction === 'cloud-to-lan'
          && record.status.state === 'completed'
          && record.status.relinquishmentProof !== null
        ) {
          return {
            resume: async () => {
              await new ProductionCloudToLanTargetEffects({
                cloudSession: null,
                convergence: authorityTransferConvergence,
                foundation,
                persistence: foundation.authorityTransfers,
                projectId: record.projectId,
              }).restoreCompleted(record);
            },
          };
        }
        if (
          record.localRole !== 'source'
          || record.status.direction !== 'lan-to-cloud'
          || record.status.state !== 'completed'
          || record.status.relinquishmentProof === null
          || record.terminalResponder === null
        ) return null;
        return {
          resume: async () => {
            const membership = await foundation.local.projects.loadMembership(
              record.projectId,
            );
            if (!membership) {
              throw bootstrapCompositionError('authority-transfer-terminal-membership-missing');
            }
            const cloudSession = isAuthorityTransferTerminalResponderExpired(
              record,
              new Date(),
            )
              ? null
              : await cloudAuthority.createLifecycle({
                  developmentActorId: isCollabLocalCloudMembership(membership)
                    ? membership.authority.developmentActorId
                    : membership.member.id,
                  projectId: record.projectId,
                  serverUrl: isCollabLocalCloudMembership(membership)
                    ? membership.authority.serverUrl
                    : record.status.targetUrl,
                });
            try {
              await new ProductionLanToCloudSourceEffects({
                cloudSession,
                convergence: authorityTransferConvergence,
                foundation,
                persistence: foundation.authorityTransfers,
                projectId: record.projectId,
              }).restoreCompleted(record);
            } finally {
              cloudSession?.dispose();
            }
          },
        };
      },
    },
  });
  foundation.bindAuthorityTransferModule(authorityTransfer);

  return Object.freeze({
    authorityTransfer,
    feature,
  });
}
