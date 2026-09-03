import {
  COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES,
  type CollabProjectId,
} from '@claudian-collab/protocol';

import type {
  CollabProjectWorkSessionSuspension,
} from '@/app/collab/activity/CollabProjectWorkSession';
import { AuthorityTransferEntryService } from '@/app/collab/authority-transfer/AuthorityTransferEntryService';
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
  rotateAuthorityTransferOrigin,
} from '@/app/collab/git/CollabGitOriginPolicy';
import { CollabLifecycleJournalStore } from '@/app/collab/lifecycle/CollabLifecycleJournalStore';
import {
  createCollabProjectLifecycleDurableOwners,
} from '@/app/collab/lifecycle/CollabProjectLifecycleOwners';
import { CollabProjectLifecycleSubsystem } from '@/app/collab/lifecycle/CollabProjectLifecycleSubsystem';
import { decodeCloudManagementIntent } from '@/app/collab/membership/CloudManagementIntent';
import { CollabMembershipService } from '@/app/collab/membership/CollabMembershipService';
import {
  ManagerResponsibilityOperationCoordinator,
} from '@/app/collab/membership/ManagerResponsibilityOperationCoordinator';
import { decodeCollabPendingProjectOperation } from '@/app/collab/PendingProjectOperation';
import { CloudProjectEntryCoordinator } from '@/app/collab/project/CloudProjectEntryCoordinator';
import type { CollabProjectSetupService } from '@/app/collab/project/CollabProjectSetupService';
import {
  ProjectOperationAdmission,
  type ProjectOperationSuspension,
} from '@/app/collab/ProjectOperationAdmission';
import { CollabPublicationService } from '@/app/collab/publish/CollabPublicationService';
import { CloudAuthorityAdapter } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { CloudRetirementClient } from '@/app/collab/retirement/CloudRetirementClient';
import { decodeCloudRetirementIntent } from '@/app/collab/retirement/CloudRetirementIntent';
import { RetirementAcknowledgementWorker } from '@/app/collab/retirement/RetirementAcknowledgementWorker';
import { RetirementClientHandler } from '@/app/collab/retirement/RetirementClientHandler';
import { RetirementLocalRecovery } from '@/app/collab/retirement/RetirementLocalRecovery';
import { type CollabFinalizeRetiredProjectRequest, type CollabLeaveProjectRequest, type CollabOperationOptions, isCollabCloudProjectSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import { toError } from '@/utils/error';

export interface CollabFeatureSubcompositionOptions {
  readonly cloudAuthority?: Pick<
  CloudAuthorityAdapter,
  'authorityKind' | 'connect' | 'connectAuthorityTransfer' | 'create'
  > & Partial<Pick<CloudAuthorityAdapter, 'connectPendingLeave' | 'connectPendingRetirement'>>;
  readonly foundation: ClaudianCollabService;
  readonly getProjectsFolder?: () => string;
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

function compositionError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

export function createCollabFeatureSubcomposition(
  options: CollabFeatureSubcompositionOptions,
): CollabFeatureSubcomposition {
  const { foundation, projectSetup, vaultRoot } = options;
  const journals = new CollabLifecycleJournalStore(vaultRoot);
  const pendingLeaves = journals.pendingLeaves;
  const operationAdmission = new ProjectOperationAdmission();
  const cloudAuthority = options.cloudAuthority ?? new CloudAuthorityAdapter();
  const connectPendingLeave = cloudAuthority.connectPendingLeave?.bind(cloudAuthority);
  const pendingLeaveAuthority = new PendingLeaveAuthorityService({
    ...(connectPendingLeave ? {
      createCloudClient: (record, requestOptions) => connectPendingLeave({
        authorityGeneration: record.authorityGeneration,
        memberId: record.memberId,
        personalRef: record.personalRef,
        projectId: record.projectId,
        serverUrl: record.serverUrl,
      }, requestOptions),
    } : {}),
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
  let feature: CollabFeatureService | null = null;
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
  const requireFeature = (): CollabFeatureService => {
    if (!feature) {
      throw new CollabError({
        code: 'not-initialized',
        safeContext: { reason: 'collab-feature-not-composed' },
      });
    }
    return feature;
  };
  type CloudRetirementSuspension = {
    readonly admission: ProjectOperationSuspension;
    readonly workSession: CollabProjectWorkSessionSuspension;
  };
  const cloudRetirementSuspensions = new Map<CollabProjectId, CloudRetirementSuspension>();
  const cloudRetirementActivity = {
    complete: async (projectId: CollabProjectId): Promise<void> => {
      const suspension = cloudRetirementSuspensions.get(projectId);
      if (!suspension) return;
      cloudRetirementSuspensions.delete(projectId);
      await requirePublication().completeProjectSuspension(suspension.workSession);
      requireFeature().closeProjectAdmission(projectId);
    },
    resume: async (projectId: CollabProjectId): Promise<void> => {
      const suspension = cloudRetirementSuspensions.get(projectId);
      if (!suspension) return;
      await requirePublication().resumeProject(suspension.workSession);
      if (!requireFeature().resumeProjectAdmission(suspension.admission)) {
        throw new CollabError({
          code: 'durable-progress-recovery-required',
          recoveryActions: ['retry', 'open-diagnostics'],
          safeContext: { reason: 'cloud-retirement-admission-resume-failed' },
        });
      }
      cloudRetirementSuspensions.delete(projectId);
    },
    suspend: async (projectId: CollabProjectId): Promise<void> => {
      if (cloudRetirementSuspensions.has(projectId)) return;
      const admission = requireFeature().suspendProjectAdmission(projectId);
      try {
        const workSession = await requirePublication().suspendProject(projectId);
        cloudRetirementSuspensions.set(projectId, { admission, workSession });
      } catch (error) {
        requireFeature().resumeProjectAdmission(admission);
        throw error;
      }
    },
  };
  type CloudRelocationSuspension = {
    readonly admission: ProjectOperationSuspension;
    workSession: CollabProjectWorkSessionSuspension | null;
  };
  const cloudRelocationSuspensions = new Map<CollabProjectId, CloudRelocationSuspension>();
  const cloudRelocationActivity = {
    activate: async (
      projectId: CollabProjectId,
      operationOptions: CollabOperationOptions = {},
    ): Promise<void> => {
      const suspension = cloudRelocationSuspensions.get(projectId);
      if (!suspension) {
        throw new CollabError({
          code: 'durable-progress-recovery-required',
          recoveryActions: ['resume', 'open-diagnostics'],
          safeContext: { reason: 'cloud-relocation-suspension-missing' },
        });
      }
      if (suspension.workSession) {
        await requirePublication().resumeProject(suspension.workSession);
        suspension.workSession = null;
      }
      requirePublication().resetProjectConnection(projectId);
      const [membership, authoritySnapshot] = await Promise.all([
        foundation.local.projects.loadMembership(projectId),
        requirePublication().readAuthoritySnapshot(projectId, operationOptions),
      ]);
      const snapshot = authoritySnapshot.snapshot;
      if (
        !membership
        || !isCollabLocalCloudMembership(membership)
        || !isCollabCloudProjectSnapshot(snapshot)
        || snapshot.project.id !== membership.project.id
        || snapshot.project.authorityGeneration
          !== membership.authority.authorityGeneration
        || snapshot.currentMember.id !== membership.member.id
        || snapshot.currentMember.personalRef !== membership.member.personalRef
        || snapshot.currentMember.status !== 'active'
      ) {
        throw new CollabError({
          code: 'authority-integrity-error',
          safeContext: { reason: 'cloud-relocation-activation-mismatch' },
        });
      }
    },
    resume: async (projectId: CollabProjectId): Promise<void> => {
      const suspension = cloudRelocationSuspensions.get(projectId);
      if (!suspension) return;
      if (suspension.workSession) {
        await requirePublication().resumeProject(suspension.workSession);
      }
      if (!requireFeature().resumeProjectAdmission(suspension.admission)) {
        throw new CollabError({
          code: 'durable-progress-recovery-required',
          recoveryActions: ['resume', 'open-diagnostics'],
          safeContext: { reason: 'cloud-relocation-admission-resume-failed' },
        });
      }
      cloudRelocationSuspensions.delete(projectId);
    },
    suspend: async (projectId: CollabProjectId): Promise<void> => {
      if (cloudRelocationSuspensions.has(projectId)) return;
      const admission = requireFeature().suspendProjectAdmission(projectId);
      try {
        await requireFeature().drainAdmittedOperations(projectId);
        const workSession = await requirePublication().suspendProject(projectId);
        cloudRelocationSuspensions.set(projectId, { admission, workSession });
      } catch (error) {
        requireFeature().resumeProjectAdmission(admission);
        throw error;
      }
    },
  };
  let terminalRetirementHandler: RetirementClientHandler | null = null;
  const retirementIntents = {
    listProjectIds: () => foundation.local.projects.listCloudRetirementIntentProjectIds(),
    load: (projectId: CollabProjectId) => foundation.local.projects.loadProjectDocument(
      projectId,
      'cloud-retirement-intent',
      decodeCloudRetirementIntent,
    ),
    loadRetirementRecord: (projectId: CollabProjectId) => (
      foundation.local.projects.loadRetirementRecord(projectId)
    ),
    remove: (projectId: CollabProjectId) => foundation.local.projects.removeProjectDocument(
      projectId,
      'cloud-retirement-intent',
    ),
    save: (intent: ReturnType<typeof decodeCloudRetirementIntent>) => (
      foundation.local.projects.saveProjectDocument(
        intent.projectId,
        'cloud-retirement-intent',
        intent,
      )
    ),
  };
  const connectPendingRetirement = cloudAuthority.connectPendingRetirement?.bind(cloudAuthority);
  const cloudRetirement = new CloudRetirementClient({
    activity: cloudRetirementActivity,
    connect: binding => cloudAuthority.connect(binding),
    connectRetirement: (binding, requestOptions) => {
      if (!connectPendingRetirement) {
        throw new CollabError({
          code: 'not-initialized',
          safeContext: { reason: 'cloud-retirement-connection-unavailable' },
        });
      }
      return connectPendingRetirement(binding, requestOptions);
    },
    intents: retirementIntents,
    terminal: {
      handle: (result, source) => {
        if (!terminalRetirementHandler) {
          throw new CollabError({
            code: 'not-initialized',
            safeContext: { reason: 'cloud-retirement-handler-not-composed' },
          });
        }
        return terminalRetirementHandler.handle(result, source);
      },
      resume: projectId => {
        if (!terminalRetirementHandler) {
          throw new CollabError({
            code: 'not-initialized',
            safeContext: { reason: 'cloud-retirement-handler-not-composed' },
          });
        }
        return terminalRetirementHandler.resume(projectId);
      },
    },
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
  terminalRetirementHandler = retirementHandler;
  foundation.setRetirementHandler(retirementHandler);
  publication = new CollabPublicationService(foundation, {
    cloudAuthority,
    discovery: foundation.discovery,
    inspectHostInstallation: projectId => foundation.hostInstallations.inspect(projectId),
    readActiveLocalRoute: projectId => foundation.lanHost.getActiveProjectRoute(projectId),
    managerResponsibility: {
      reconcileSnapshot: (snapshot, assertCurrent) => {
        void requireFeature().runProjectLifecycleTransition(
          snapshot.project.id,
          () => requireLifecycle().runManagerResponsibility(
            snapshot.project.id,
            'continuation',
            async () => {
              assertCurrent();
              await membership.reconcileManagerResponsibilitySnapshot(snapshot);
              assertCurrent();
            },
          ),
        ).catch(() => undefined);
      },
    },
    reconnect: foundation.reconnect,
    retirement: retirementHandler,
    retirementAdmission: (projectId, operation) => requireLifecycle().runRetirementAdoption(
      projectId,
      operation,
    ),
    vaultRoot,
  });
  const membership = new CollabMembershipService(
    publication.membershipControl,
    {
      readCoordinationSnapshot: (...args) => publication.readCoordinationSnapshot(...args),
      readAuthoritySnapshot: (...args) => publication.readAuthoritySnapshot(...args),
    },
    {},
    {
      cloudManagementAdmission: (projectId, operation) => (
        requireLifecycle().runCloudManagement(
          projectId,
          operation,
        )
      ),
      managerLeaveCloudManagementAdmission: (projectId, operation) => (
        requireLifecycle().runCloudManagerLeaveManagement(
          projectId,
          operation,
        )
      ),
      managerResponsibilityAdmission: (projectId, operation) => (
        requireLifecycle().runManagerResponsibility(
          projectId,
          'operation',
          operation,
        )
      ),
      managerReceipts,
      managerResponsibilityOperations,
      pendingLeaves,
      projects: foundation.local.projects,
    },
  );
  foundation.lanHost.bindConnectionProjection({
    resetProjectConnection: projectId => requirePublication().resetProjectConnection(projectId),
  });
  const hostTransfer = foundation.createHostTransferService(
    {
      readCoordinationSnapshot: (...args) => (
        requirePublication().readAuthoritySnapshot(...args)
      ),
    },
    (projectId, operation) => requireLifecycle().runExclusive(
      projectId,
      'host-transfer',
      'recovery',
      operation,
    ),
    () => {
      void requireLifecycle().refreshLifecycleProjection().catch(() => undefined);
    },
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
          recoverRejectedLeave: input => pendingLeaveAuthority.recoverRejected({
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
    resumeLeave: async (
      projectId: CollabProjectId,
      operationOptions?: CollabOperationOptions,
    ): Promise<void> => {
      const result = await (await requireExitCoordinator()).resume(
        projectId,
        operationOptions,
      );
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
      if (localMembership && isCollabLocalCloudMembership(localMembership)) {
        await requireLifecycle().runExclusive(
          request.projectId,
          'retirement',
          'operation',
          () => cloudRetirement.retire(localMembership, request, operationOptions),
        );
        return;
      }
      const result = await foundation.retireProject(request, operationOptions?.signal);
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
    durableOwners: createCollabProjectLifecycleDurableOwners(
      {
        cloudManagementIntents: {
          load: projectId => foundation.local.projects.loadProjectDocument(
            projectId,
            'cloud-management-intent',
            decodeCloudManagementIntent,
          ),
        },
        cloudRetirementIntents: retirementIntents,
        hostTransferRecovery: foundation.local.projects.hostTransferRecovery,
        localCleanup: foundation.local.projects.localCleanup,
        managerReceipts,
        pendingLeaves,
        retiredCleanups: retiredCleanupRecords,
        retirements: foundation.local.projects,
        retirementTombstones: foundation.local.projects,
      },
      ownerInstallationKey => foundation.hostInstallations.isRecoveryOwner(
        ownerInstallationKey,
      ),
    ),
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
        name: 'cloud-relocations',
        run: operationOptions => foundation.reconnect.resumeCloudRelocations(
          operationOptions,
        ),
      },
      {
        name: 'cloud-retirement-intents',
        run: async operationOptions => {
          const projectIds = await retirementIntents.listProjectIds();
          let firstFailure: unknown = null;
          for (const projectId of projectIds) {
            if (operationOptions.signal?.aborted) throw cancelled();
            try {
              await requireLifecycle().runExclusive(
                projectId,
                'retirement',
                'recovery',
                () => cloudRetirement.resume(projectId, operationOptions),
              );
            } catch (error) {
              if (operationOptions.signal?.aborted) throw error;
              firstFailure ??= error;
            }
          }
          if (firstFailure !== null) {
            throw toError(firstFailure, 'Cloud retirement intent recovery failed.');
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
  lifecycle.registerDurableOwner({
    name: 'cloud-relocation',
    inspect: async projectId => {
      const pending = await foundation.local.projects.loadProjectDocument(
        projectId,
        'pending-operation',
        decodeCollabPendingProjectOperation,
      );
      return pending?.kind === 'cloud-relocation' ? 'nonterminal' : 'absent';
    },
  });
  foundation.reconnect.bindCloudRelocation({
    activity: cloudRelocationActivity,
    admit: (projectId, mode, operation) => requireLifecycle().runExclusive(
      projectId,
      'cloud-relocation',
      mode,
      operation,
    ),
    connect: (input, operationOptions) => cloudAuthority.connect(
      input,
      operationOptions,
    ),
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

  const lifecycleMembership = lifecycle.bindMembership(membership);

  const cloudEntry = new CloudProjectEntryCoordinator(foundation, {
    activateProject: async (membership, operationOptions) => { await requirePublication().readSnapshot(membership.project.id, operationOptions); },
    cloudAuthority,
    getProjectsFolder: options.getProjectsFolder ?? (() => 'workspace'),
    vaultRoot,
  });
  lifecycle.registerDurableOwner({
    name: 'cloud-project-entry',
    inspect: async projectId => {
      const pending = await foundation.local.projects.loadProjectDocument(projectId, 'pending-operation', decodeCollabPendingProjectOperation);
      return pending?.kind === 'cloud-entry' ? 'nonterminal' : 'absent';
    },
  });
  const authorityTransferLocalFence = new AuthorityTransferLocalFence({
    admission: {
      drainAdmittedOperations: projectId => operationAdmission.drainAdmittedOperations(projectId),
      resumeProjectAdmission: suspension => operationAdmission.resumeProject(suspension),
      suspendProjectAdmission: projectId => operationAdmission.suspendProject(projectId),
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
    authorityProjectionTransitions: {
      run: (projectId, operation) => foundation.runAuthorityProjectionTransition(
        projectId,
        operation,
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
    createCloudConnection: binding => cloudAuthority.connect(binding),
    loadMembership: projectId => foundation.local.projects.loadMembership(projectId),
  });
  const authorityTransfer = new AuthorityTransferModule({
    activateLanToCloudSourceRoute: (projectId, expectedEndpoint, operationOptions) => (
      foundation.activateAuthorityTransferSourceRoute(
        projectId,
        expectedEndpoint,
        operationOptions,
      )
    ),
    assertLanToCloudSourceOwner: (projectId, expectedAuthorityGeneration) => (
      foundation.assertLanToCloudSourceOwner(projectId, expectedAuthorityGeneration)
    ),
    assertRecoveryOwner: (ownerInstallationKey, projectId) => (
      foundation.hostInstallations.assertRecoveryOwner(
        ownerInstallationKey,
        projectId,
        'authority-transfer',
      )
    ),
    claimantStore: foundation.local.projects.authorityTransferClaimants,
    createManagerReissuedClaimConnection: (binding, operationOptions) => (
      cloudAuthority.connect(binding, operationOptions)
    ),
    convergence: authorityTransferConvergence,
    createCloudToLanConnection: async (projectId, operationOptions) => {
      const membership = await foundation.local.projects.loadMembership(projectId);
      if (!membership || !isCollabLocalCloudMembership(membership)) {
        throw compositionError('authority-transfer-target-membership-invalid');
      }
      return cloudAuthority.connectAuthorityTransfer({
        authorityGeneration: membership.authority.authorityGeneration,
        memberId: membership.member.id,
        personalRef: membership.member.personalRef,
        projectId,
        serverUrl: membership.authority.serverUrl,
      }, operationOptions);
    },
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
    loadClaimantMembership: projectId => foundation.local.projects.loadMembership(projectId),
    installationKey: foundation.installationKey,
    persistence: foundation.authorityTransfers,
    recoverCloudSession: async (record, operationOptions) => {
      const membership = await foundation.local.projects.loadMembership(record.projectId);
      if (!membership) {
        throw compositionError('authority-transfer-membership-missing');
      }
      if (record.localRole !== 'source' || !isCollabLocalLanMembership(membership)) {
        throw compositionError('authority-transfer-source-membership-invalid');
      }
      return cloudAuthority.connect({
        projectId: record.projectId,
        serverUrl: record.status.targetUrl,
      }, operationOptions);
    },
    recoverClaimant: record => claimantBindingResolver.resolve(record),
    terminalResolver: {
      resolve: async record => {
        const sourceEntry = record.localRole === 'source'
          && record.status.direction === 'lan-to-cloud'
          ? await foundation.authorityTransfers.loadSourceEntry(record.projectId)
          : null;
        const locallyProvedCancellation = sourceEntry?.cancellation !== null
          && sourceEntry?.cancellation !== undefined
          && sourceEntry.beginSubmission !== 'possibly-sent'
          && (
            record.status.phase === 'collecting-readiness'
            || COLLAB_AUTHORITY_TRANSFER_CANCELLATION_PHASES.includes(
              record.status.phase as never,
            )
          );
        if (
          record.localRole === 'source'
          && record.status.direction === 'lan-to-cloud'
          && (record.status.state === 'cancelled' || locallyProvedCancellation)
        ) {
          return {
            resume: async () => {
              const sourceEffects = new ProductionLanToCloudSourceEffects({
                cloudSession: null,
                convergence: authorityTransferConvergence,
                foundation,
                persistence: foundation.authorityTransfers,
                projectId: record.projectId,
              });
              let settled = record;
              if (record.status.state !== 'cancelled') {
                const cancellation = sourceEntry?.cancellation;
                if (!cancellation) {
                  throw compositionError(
                    'authority-transfer-cancellation-intent-missing',
                  );
                }
                const prepared = record.status.phase === 'collecting-readiness'
                  ? await foundation.authorityTransfers.cancelUnbegunLanToCloudSource(cancellation)
                  : await foundation.authorityTransfers
                    .resumeUnbegunLanToCloudCancellation(record);
                await sourceEffects.reopenAfterCancellation(prepared);
                settled = await foundation.authorityTransfers
                  .completeUnbegunLanToCloudCancellation(prepared);
              } else {
                await sourceEffects.reopenAfterCancellation(record);
              }
              await foundation.authorityTransfers.completeTerminalCleanup({
                operationIntentId: settled.operationIntentId,
                projectId: settled.projectId,
                stagingDirectoryName: settled.stagingDirectoryName,
                transferId: settled.transferId,
              });
            },
          };
        }
        if (
          record.localRole === 'target'
          && record.status.direction === 'cloud-to-lan'
          && record.status.state === 'cancelled'
        ) {
          return {
            resume: async () => {
              await new ProductionCloudToLanTargetEffects({
                cloudSession: null,
                convergence: authorityTransferConvergence,
                foundation,
                persistence: foundation.authorityTransfers,
                projectId: record.projectId,
              }).cancelStaging(record);
              await foundation.authorityTransfers.completeTerminalCleanup({
                operationIntentId: record.operationIntentId,
                projectId: record.projectId,
                stagingDirectoryName: record.stagingDirectoryName,
                transferId: record.transferId,
              });
            },
          };
        }
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
          resume: async (_projectId, operationOptions = {}) => {
            const membership = await foundation.local.projects.loadMembership(
              record.projectId,
            );
            if (!membership) {
              throw compositionError('authority-transfer-terminal-membership-missing');
            }
            const cloudSession = isAuthorityTransferTerminalResponderExpired(
              record,
              new Date(),
            )
              ? null
              : await cloudAuthority.connect({
                  projectId: record.projectId,
                  serverUrl: isCollabLocalCloudMembership(membership)
                    ? membership.authority.serverUrl
                    : record.status.targetUrl,
                }, operationOptions);
            try {
              await new ProductionLanToCloudSourceEffects({
                cloudSession,
                convergence: authorityTransferConvergence,
                foundation,
                persistence: foundation.authorityTransfers,
                projectId: record.projectId,
              }).restoreCompleted(record, operationOptions);
            } finally {
              cloudSession?.dispose();
            }
          },
        };
      },
    },
  });
  foundation.bindAuthorityTransferModule(authorityTransfer);
  const authorityTransferEntry = new AuthorityTransferEntryService({
    connectCloud: (input, operationOptions) => cloudAuthority.connect(input, operationOptions),
    loadMembership: projectId => foundation.local.projects.loadMembership(projectId),
    module: authorityTransfer,
  });
  feature = new CollabFeatureService(foundation, projectSetup, {
    authorityTransfer: authorityTransferEntry,
    cloudEntry: {
      close: () => cloudEntry.close(),
      createProject: (request, operationOptions) => cloudEntry.createProject(request, operationOptions),
      joinProject: (request, operationOptions) => requireLifecycle().runExclusive(
        'projectId' in request ? request.projectId : request.invitation.invitation.projectId,
        'cloud-project-entry', 'operation', () => cloudEntry.joinProject(request, operationOptions),
      ),
      resumeSetup: (request, operationOptions) => requireLifecycle().runExclusive(
        request.projectId, 'cloud-project-entry', 'recovery', () => cloudEntry.resumeSetup(request, operationOptions),
      ),
    },
    hostTransfer: lifecycle.hostTransfer,
    hostInstallation: foundation.hostInstallations,
    join: foundation.join,
    lanHost: foundation.lanHost,
    lifecycleRecovery: lifecycle.lifecycleRecovery,
    localExit: lifecycle.localExit,
    membership: lifecycleMembership,
    cloudRetirementIntents: retirementIntents,
    pendingLeaves,
    publication,
    retirement: lifecycle.retirement,
    vaultRoot,
  }, operationAdmission);
  lifecycle.bindProjection({
    closeProjectAdmission: projectId => requireFeature().closeProjectAdmission(projectId),
    refreshLifecycleProjection: () => requireFeature().refreshLifecycleProjection(),
  });

  return Object.freeze({
    authorityTransfer,
    feature: requireFeature(),
  });
}
