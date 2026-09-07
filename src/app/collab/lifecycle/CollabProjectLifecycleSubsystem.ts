import { type CollabProjectId } from '@claudian-collab/protocol';

import type {
  CollabCloudBootstrapPort,
  CollabHostTransferPort,
  CollabLifecycleRecoveryPort,
  CollabLocalExitPort,
  CollabMembershipPort,
  CollabRetirementPort,
} from '@/app/collab/CollabFeatureService';
import { type CollabOperationOptions } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CollabProjectLifecycleProjectionPort {
  closeProjectAdmission(projectId: CollabProjectId): void;
  refreshLifecycleProjection(): Promise<void>;
}

export interface CollabProjectLifecycleRecoveryStage {
  readonly name: string;
  run(options: CollabOperationOptions): Promise<void>;
}

export type CollabProjectLifecycleDurableState =
  | 'absent'
  | 'nonterminal'
  | 'proposal'
  | 'terminal';

export interface CollabProjectLifecycleDurableOwner {
  readonly name: string;
  inspect(projectId: CollabProjectId): Promise<CollabProjectLifecycleDurableState>;
}

export type CollabProjectLifecycleAdmissionMode = 'continuation' | 'operation' | 'recovery';

export interface CollabProjectLifecycleSubsystemOptions {
  readonly closeRecovery: () => Promise<void> | void;
  readonly durableOwners: readonly CollabProjectLifecycleDurableOwner[];
  readonly hostTransfer: CollabHostTransferPort;
  readonly localExit: CollabLocalExitPort;
  readonly recoveryStages: readonly CollabProjectLifecycleRecoveryStage[];
  readonly retirement: CollabRetirementPort;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new CollabError({ code: 'cancelled' });
}

export class CollabProjectLifecycleSubsystem {
  readonly hostTransfer: CollabHostTransferPort;
  readonly lifecycleRecovery: CollabLifecycleRecoveryPort;
  readonly localExit: CollabLocalExitPort;
  readonly retirement: CollabRetirementPort;
  private readonly activeRecoveryRuns = new Set<Promise<void>>();
  private readonly closeRecovery: () => Promise<void> | void;
  private readonly durableOwners = new Map<string, CollabProjectLifecycleDurableOwner>();
  private readonly projectQueues = new Map<CollabProjectId, Promise<void>>();
  private readonly recoveryStages: CollabProjectLifecycleRecoveryStage[];
  private cloudBootstrapBound = false;
  private closePromise: Promise<void> | null = null;
  private closed = false;
  private membershipBound = false;
  private projection: CollabProjectLifecycleProjectionPort | null = null;
  private started = false;

  constructor(options: CollabProjectLifecycleSubsystemOptions) {
    this.closeRecovery = options.closeRecovery;
    for (const owner of options.durableOwners) this.registerDurableOwner(owner);
    this.hostTransfer = Object.freeze<CollabHostTransferPort>({
      acceptHostTransfer: (request, operationOptions) => this.runExclusive(
        request.projectId,
        'host-transfer',
        'continuation',
        () => options.hostTransfer.acceptHostTransfer(request, operationOptions),
      ),
      // Cancellation mutates source authority only inside its trusted Host
      // listener. The initiating client holds no separate durable local phase.
      cancelHostTransfer: (request, operationOptions) => (
        options.hostTransfer.cancelHostTransfer(request, operationOptions)
      ),
      close: () => options.hostTransfer.close(),
      createHostTransfer: (request, operationOptions) => this.runExclusive(
        request.projectId,
        'host-transfer',
        'operation',
        () => options.hostTransfer.createHostTransfer(request, operationOptions),
      ),
      declineHostTransfer: (request, operationOptions) => this.runExclusive(
        request.projectId,
        'host-transfer',
        'operation',
        () => options.hostTransfer.declineHostTransfer(request, operationOptions),
      ),
    });
    this.localExit = Object.freeze<CollabLocalExitPort>({
      leaveProject: (request, operationOptions) => this.runExclusiveWithPredecessor(
        request.projectId,
        'local-exit',
        'manager-responsibility',
        'continuation',
        () => options.localExit.leaveProject(request, operationOptions),
      ),
    });
    this.retirement = Object.freeze<CollabRetirementPort>({
      close: () => options.retirement.close(),
      finalizeRetiredProject: (request, operationOptions) => this.runExclusive(
        request.projectId,
        'retirement',
        'continuation',
        () => options.retirement.finalizeRetiredProject(request, operationOptions),
      ),
      // The trusted authority listener arbitrates the remote retirement commit.
      // This client adapter acquires local ownership only when it adopts the
      // returned terminal result, avoiding a same-process client/listener lock.
      retireProject: (request, operationOptions) => (
        options.retirement.retireProject(request, operationOptions)
      ),
      retryProjectCleanup: (projectId, operationOptions) => this.runExclusive(
        projectId,
        'retirement',
        'continuation',
        () => options.retirement.retryProjectCleanup(projectId, operationOptions),
      ),
    });
    this.recoveryStages = [...options.recoveryStages];
    this.lifecycleRecovery = {
      close: () => this.close(),
      resume: recoveryOptions => this.startRecovery(recoveryOptions),
    };
  }

  registerDurableOwner(owner: CollabProjectLifecycleDurableOwner): void {
    this.assertRegistrationOpen();
    if (!owner.name || this.durableOwners.has(owner.name)) {
      throw new Error('Collab lifecycle durable owner is already registered');
    }
    this.durableOwners.set(owner.name, owner);
  }

  registerRecoveryStage(stage: CollabProjectLifecycleRecoveryStage): void {
    this.assertRegistrationOpen();
    if (!stage.name || this.recoveryStages.some(existing => existing.name === stage.name)) {
      throw new Error('Collab lifecycle recovery stage is already registered');
    }
    this.recoveryStages.push(stage);
  }

  runExclusive<T>(
    projectId: CollabProjectId,
    ownerName: string,
    mode: CollabProjectLifecycleAdmissionMode,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runExclusiveWithPredecessor(
      projectId,
      ownerName,
      null,
      mode,
      operation,
    );
  }

  runRetirementAdoption<T>(
    projectId: CollabProjectId,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runExclusiveWithPredecessor(
      projectId,
      'retirement',
      'local-exit',
      'continuation',
      operation,
    );
  }

  private runExclusiveWithPredecessor<T>(
    projectId: CollabProjectId,
    ownerName: string,
    predecessorOwnerName: string | null,
    mode: CollabProjectLifecycleAdmissionMode,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['resume'],
        safeContext: { reason: 'lifecycle-subsystem-closed' },
      }));
    }
    this.started = true;
    const previous = this.projectQueues.get(projectId) ?? Promise.resolve();
    const result = previous.then(async () => {
      const pendingOwners: string[] = [];
      for (const owner of this.durableOwners.values()) {
        const state = await owner.inspect(projectId).catch(error => {
          throw new CollabError({
            cause: error,
            code: 'durable-progress-recovery-required',
            recoveryActions: ['resume'],
            safeContext: { reason: 'lifecycle-owner-inspection-failed' },
          });
        });
        if (
          state !== 'absent'
          && state !== 'nonterminal'
          && state !== 'proposal'
          && state !== 'terminal'
        ) {
          throw new CollabError({
            code: 'durable-progress-recovery-required',
            recoveryActions: ['resume'],
            safeContext: { reason: 'lifecycle-owner-inspection-invalid' },
          });
        }
        if (state === 'nonterminal') pendingOwners.push(owner.name);
      }
      if (pendingOwners.length > 1) {
        throw new CollabError({
          code: 'durable-progress-recovery-required',
          recoveryActions: ['resume'],
          safeContext: { reason: 'lifecycle-owner-ambiguous' },
        });
      }
      const pendingOwner = pendingOwners[0];
      if (
        pendingOwner !== undefined
        && pendingOwner !== ownerName
        && pendingOwner !== predecessorOwnerName
      ) {
        throw new CollabError({
          code: 'durable-progress-recovery-required',
          recoveryActions: ['resume'],
          safeContext: { reason: 'lifecycle-owner-pending' },
        });
      }
      if (pendingOwner === ownerName && mode === 'operation') {
        throw new CollabError({
          code: 'durable-progress-recovery-required',
          recoveryActions: ['resume'],
          safeContext: { reason: 'lifecycle-owner-recovery-required' },
        });
      }
      return operation();
    });
    const tail = result.then(() => undefined, () => undefined);
    this.projectQueues.set(projectId, tail);
    void tail.finally(() => {
      if (this.projectQueues.get(projectId) === tail) this.projectQueues.delete(projectId);
    });
    return result;
  }

  bindCloudBootstrap(cloudBootstrap: CollabCloudBootstrapPort): CollabCloudBootstrapPort {
    this.assertRegistrationOpen();
    if (this.cloudBootstrapBound) {
      throw new Error('Cloud bootstrap lifecycle port is already bound');
    }
    this.cloudBootstrapBound = true;
    return Object.freeze<CollabCloudBootstrapPort>({
      cancel: projectId => this.runExclusive(
        projectId,
        'cloud-bootstrap',
        'continuation',
        () => cloudBootstrap.cancel(projectId),
      ),
      close: () => cloudBootstrap.close(),
      prepareLocalRecovery: () => cloudBootstrap.prepareLocalRecovery(),
      recoverPending: () => cloudBootstrap.recoverPending(),
      startFormerHost: input => this.runExclusive(
        input.projectId,
        'cloud-bootstrap',
        'operation',
        () => cloudBootstrap.startFormerHost(input),
      ),
      submitParticipant: input => this.runExclusive(
        input.projectId,
        'cloud-bootstrap',
        'operation',
        () => cloudBootstrap.submitParticipant(input),
      ),
    });
  }

  bindMembership(membership: CollabMembershipPort): CollabMembershipPort {
    this.assertRegistrationOpen();
    if (this.membershipBound) {
      throw new Error('Manager responsibility lifecycle port is already bound');
    }
    this.membershipBound = true;
    return Object.freeze<CollabMembershipPort>({
      cancelManagerResponsibilityOffer: (request, operationOptions) => this.runExclusive(
        request.projectId,
        'manager-responsibility',
        'operation',
        () => membership.cancelManagerResponsibilityOffer(request, operationOptions),
      ),
      createInvitation: (projectId, operationOptions) => (
        membership.createInvitation(projectId, operationOptions)
      ),
      createManagerResponsibilityOffer: (request, operationOptions) => this.runExclusive(
        request.projectId,
        'manager-responsibility',
        'operation',
        () => membership.createManagerResponsibilityOffer(request, operationOptions),
      ),
      demoteManager: (request, operationOptions) => (
        membership.demoteManager(request, operationOptions)
      ),
      promoteManager: (request, operationOptions) => (
        membership.promoteManager(request, operationOptions)
      ),
      removeMember: (request, operationOptions) => (
        membership.removeMember(request, operationOptions)
      ),
      revokeInvitation: (projectId, operationOptions) => (
        membership.revokeInvitation(projectId, operationOptions)
      ),
    });
  }

  bindProjection(projection: CollabProjectLifecycleProjectionPort): void {
    if (this.projection) {
      throw new Error('Collab lifecycle projection is already bound');
    }
    this.projection = projection;
  }

  closeProjectAdmission(projectId: CollabProjectId): void {
    this.projection?.closeProjectAdmission(projectId);
  }

  refreshLifecycleProjection(): Promise<void> {
    return this.projection?.refreshLifecycleProjection() ?? Promise.resolve();
  }

  private async resume(
    stages: readonly CollabProjectLifecycleRecoveryStage[],
    options: CollabOperationOptions = {},
  ): Promise<void> {
    let firstError: unknown;
    for (const stage of stages) {
      throwIfCancelled(options.signal);
      await stage.run(options).catch(error => {
        firstError ??= error;
      });
    }
    throwIfCancelled(options.signal);
    if (firstError instanceof Error) throw firstError;
    if (firstError !== undefined) {
      throw new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['resume'],
        safeContext: { reason: 'collab-lifecycle-recovery-incomplete' },
      });
    }
  }

  private startRecovery(options: CollabOperationOptions = {}): Promise<void> {
    if (this.closed) {
      return Promise.reject(new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['resume'],
        safeContext: { reason: 'lifecycle-subsystem-closed' },
      }));
    }
    this.started = true;
    const recovery = this.resume(this.recoveryStages, options);
    this.activeRecoveryRuns.add(recovery);
    void recovery.then(
      () => this.activeRecoveryRuns.delete(recovery),
      () => this.activeRecoveryRuns.delete(recovery),
    );
    return recovery;
  }

  private close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      let closeFailure: unknown;
      await Promise.resolve().then(() => this.closeRecovery()).catch(error => {
        closeFailure = error;
      });
      const recoveryResults = await Promise.allSettled([...this.activeRecoveryRuns]);
      await Promise.all([...this.projectQueues.values()]);
      if (closeFailure instanceof Error) throw closeFailure;
      if (closeFailure !== undefined) {
        throw new CollabError({
          code: 'durable-progress-recovery-required',
          recoveryActions: ['resume'],
          safeContext: { reason: 'collab-lifecycle-recovery-close-failed' },
        });
      }
      const failure = recoveryResults.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    })();
    return this.closePromise;
  }

  private assertRegistrationOpen(): void {
    if (this.closed) throw new Error('Collab lifecycle subsystem is closed');
    if (this.started) throw new Error('Collab lifecycle subsystem has already started');
  }
}
