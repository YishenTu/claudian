import { randomUUID } from 'node:crypto';

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
import { CollabLifecycleJournalStore } from '@/app/collab/lifecycle/CollabLifecycleJournalStore';
import { CollabProjectLifecycleSubsystem } from '@/app/collab/lifecycle/CollabProjectLifecycleSubsystem';
import { CollabMembershipService } from '@/app/collab/membership/CollabMembershipService';
import {
  ManagerResponsibilityOperationCoordinator,
} from '@/app/collab/membership/ManagerResponsibilityOperationCoordinator';
import type { CollabProjectSetupService } from '@/app/collab/project/CollabProjectSetupService';
import { CollabPublicationService } from '@/app/collab/publish/CollabPublicationService';
import { RetirementAcknowledgementWorker } from '@/app/collab/retirement/RetirementAcknowledgementWorker';
import { RetirementClientHandler } from '@/app/collab/retirement/RetirementClientHandler';
import { RetirementLocalRecovery } from '@/app/collab/retirement/RetirementLocalRecovery';
import { type CollabFinalizeRetiredProjectRequest, type CollabLeaveProjectRequest, type CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CollabFeatureSubcompositionOptions {
  readonly foundation: ClaudianCollabService;
  readonly projectSetup: CollabProjectSetupService;
  readonly vaultRoot: string;
}

export interface CollabFeatureSubcomposition {
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
  const requirePublication = (): CollabPublicationService => {
    if (!publication) {
      throw new CollabError({
        code: 'not-initialized',
        safeContext: { reason: 'collab-publication-not-composed' },
      });
    }
    return publication;
  };
  const acknowledgementWorker = new RetirementAcknowledgementWorker(
    foundation.local.projects,
    {
      acknowledge: input => foundation.acknowledgeRetirement(input),
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
      managerReceipts,
      managerResponsibilityOperations,
      pendingLeaves,
    },
  );
  publication = new CollabPublicationService(foundation, {
    discovery: foundation.discovery,
    isLocalHostRunning: projectId => foundation.lanHost.isProjectRunning(projectId),
    managerResponsibility: {
      reconcileSnapshot: snapshot => membership
        .reconcileManagerResponsibilitySnapshot(snapshot),
    },
    reconnect: foundation.reconnect,
    retirement: retirementHandler,
    vaultRoot,
  });
  const hostTransfer = foundation.createHostTransferService(publication);
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
  });
  const retirementLocalRecovery = new RetirementLocalRecovery(
    foundation.local.projects,
    pendingLeaves,
    retiredCleanupRecords,
    retirementHandler,
    retiredFinalizer,
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
      const result = await foundation.retireProject(request, operationOptions?.signal);
      await retirementHandler.handle(result, 'response');
    },
    retryProjectCleanup: async (projectId, operationOptions): Promise<void> => {
      if (operationOptions?.signal?.aborted) throw cancelled();
      await retirementHandler.resume(projectId);
    },
  };
  lifecycle = new CollabProjectLifecycleSubsystem({
    closeRecovery: () => acknowledgementWorker.close(),
    hostTransfer,
    localExit,
    recoveryStages: [
      {
        name: 'retirement-responders',
        run: () => foundation.restoreRetirementResponders(),
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

  const bootstrapWorkSessions: CloudBootstrapLocalFence = new CloudBootstrapLocalFence({
    admission: {
      closeProjectAdmission: projectId => feature.closeProjectAdmission(projectId),
      drainAdmittedOperations: () => feature.drainAdmittedOperations(),
      resumeProjectAdmission: suspension => feature.resumeProjectAdmission(suspension),
      suspendProjectAdmission: projectId => feature.suspendProjectAdmission(projectId),
    },
    workSessions: {
      closeProject: projectId => requirePublication().closeProject(projectId),
      completeProjectSuspension: suspension => (
        requirePublication().completeProjectSuspension(suspension)
      ),
      drainProject: projectId => requirePublication().drainProject(projectId),
      resumeProject: suspension => requirePublication().resumeProject(suspension),
      suspendProject: projectId => requirePublication().suspendProject(projectId),
    },
  });
  const transitions = foundation.cloudBootstrapTransitions;
  const source = new LocalDevelopmentBootstrapSource({ foundation, vaultRoot });
  const readiness = new CloudBootstrapReadinessCollector(
    new LocalCloudBootstrapReadinessInspector({
      foundation,
      isProjectQuiesced: projectId => bootstrapWorkSessions.isProjectQuiesced(projectId),
      managerResponsibilityReceipts: managerReceipts,
      vaultRoot,
    }),
  );
  const cloudBootstrap = new CloudBootstrapService({
    createCoordinator: ({ developmentActorId, serverUrl }) => (
      new CloudBootstrapCoordinator({
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
              || membership.authority.kind !== 'lan'
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
    recoverLocalArtifacts: () => source.recoverArtifacts(async manifest => {
      const record = await transitions.load(manifest.comparison.projectId);
      return record?.attemptId === manifest.attemptId
        && record.manifestSha256 === developmentBootstrapManifestSha256(manifest);
    }),
    transitions,
  });

  const feature: CollabFeatureService = new CollabFeatureService(foundation, projectSetup, {
    cloudBootstrap,
    hostTransfer: lifecycle.hostTransfer,
    join: foundation.join,
    lanHost: foundation.lanHost,
    lifecycleRecovery: lifecycle.lifecycleRecovery,
    localExit: lifecycle.localExit,
    membership,
    publication,
    retirement: lifecycle.retirement,
    vaultRoot,
  });
  lifecycle.bindProjection({
    closeProjectAdmission: projectId => feature.closeProjectAdmission(projectId),
    refreshLifecycleProjection: () => feature.refreshLifecycleProjection(),
  });

  return Object.freeze({ feature });
}
