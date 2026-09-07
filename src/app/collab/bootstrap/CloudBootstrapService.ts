import type {
  CollabMemberId,
  CollabProjectId,
  DevelopmentBootstrapManifest,
} from '@claudian-collab/protocol';

import {
  type CloudBootstrapCoordinator,
  type StartCloudBootstrapInput,
  type SubmitCloudBootstrapParticipantInput,
} from '@/app/collab/bootstrap/CloudBootstrapCoordinator';
import type {
  CloudBootstrapTransitionRecord,
} from '@/app/collab/bootstrap/CloudBootstrapTransitionRecord';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CloudBootstrapServiceOptions {
  readonly assertHostInstallationOwned: (projectId: CollabProjectId) => Promise<void>;
  readonly assertRecoveryOwner: (
    ownerInstallationKey: string | undefined,
    projectId: CollabProjectId,
  ) => Promise<void> | void;
  readonly createCoordinator: (input: {
    readonly developmentActorId: string;
    readonly serverUrl: string;
  }) => CloudBootstrapCoordinator;
  readonly fenceUncertainProject: (projectId: CollabProjectId) => Promise<void>;
  readonly projectRecoveryAdmission: (
    projectId: CollabProjectId,
    operation: () => Promise<void>,
  ) => Promise<void>;
  readonly recoverLocalArtifacts: (
    projectRecoveryAdmission: CloudBootstrapServiceOptions['projectRecoveryAdmission'],
  ) => Promise<void>;
  readonly scheduleRetry?: (
    retryKey: string,
    retry: () => Promise<void>,
    delayMs: number,
  ) => (() => void) | void;
  readonly transitions: {
    list(): Promise<{
      readonly blockedProjectIds: readonly CollabProjectId[];
      readonly records: readonly CloudBootstrapTransitionRecord[];
      readonly retryRequired: boolean;
    }>;
    load(projectId: CollabProjectId): Promise<CloudBootstrapTransitionRecord | null>;
  };
}

export interface StartCloudBootstrapServiceInput {
  readonly memberId: CollabMemberId;
  readonly projectId: CollabProjectId;
  readonly serverUrl: string;
}

export interface SubmitCloudBootstrapServiceParticipantInput
  extends StartCloudBootstrapServiceInput {
  readonly manifest: DevelopmentBootstrapManifest;
}

function serviceError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

export class CloudBootstrapService {
  private readonly active = new Set<Promise<unknown>>();
   #closePromise: Promise<void> | null = null;
   #closing = false;
   readonly #retryAttempts = new Map<string, number>();
   readonly #retryCancellations = new Map<string, () => void>();
   readonly #retryScheduled = new Set<string>();
   readonly #scheduleRetry: NonNullable<CloudBootstrapServiceOptions['scheduleRetry']>;

  constructor(private readonly options: CloudBootstrapServiceOptions) {
    this.#scheduleRetry = options.scheduleRetry ?? ((_projectId, retry, delayMs) => {
      const timer = window.setTimeout(() => void retry().catch(() => undefined), delayMs);
      return () => window.clearTimeout(timer);
    });
  }

  startFormerHost(
    input: StartCloudBootstrapServiceInput,
  ): Promise<CloudBootstrapTransitionRecord> {
    const coordinatorInput: StartCloudBootstrapInput = {
      ...input,
      developmentActorId: input.memberId,
    };
    return this.run(signal => this.#runDirectTransition(
      input.projectId,
      async () => {
        await this.options.assertHostInstallationOwned(input.projectId);
        return this.options.createCoordinator(coordinatorInput)
          .startFormerHost(coordinatorInput, signal);
      },
    ));
  }

  submitParticipant(
    input: SubmitCloudBootstrapServiceParticipantInput,
  ): Promise<CloudBootstrapTransitionRecord> {
    const coordinatorInput: SubmitCloudBootstrapParticipantInput = {
      ...input,
      developmentActorId: input.memberId,
    };
    return this.run(signal => this.#runDirectTransition(
      input.projectId,
      () => this.options.createCoordinator(coordinatorInput)
        .submitParticipant(coordinatorInput, signal),
    ));
  }

  cancel(projectId: CollabProjectId): Promise<CloudBootstrapTransitionRecord> {
    return this.run(signal => this.#cancelActive(projectId, signal));
  }

  recoverPending(): Promise<void> {
    return this.run(signal => this.#recoverActive(signal));
  }

  prepareLocalRecovery(): Promise<void> {
    return this.run(async signal => {
      await this.#prepareLocalRecoveryActive(signal);
    });
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    for (const controller of this.controllers) controller.abort();
    for (const cancel of this.#retryCancellations.values()) cancel();
    this.#retryCancellations.clear();
    this.#retryScheduled.clear();
    this.#retryAttempts.clear();
    this.#closePromise = Promise.allSettled([...this.active]).then(() => undefined);
    return this.#closePromise;
  }

   async #cancelActive(
    projectId: CollabProjectId,
    signal: AbortSignal,
  ): Promise<CloudBootstrapTransitionRecord> {
    const record = await this.options.transitions.load(projectId);
    if (!record) throw serviceError('cloud-bootstrap-transition-not-found');
    await this.options.assertRecoveryOwner(record.ownerInstallationKey, projectId);
    this.#assertActorBinding(record);
    const result = await this.options.createCoordinator({
      developmentActorId: record.developmentActorId,
      serverUrl: record.newAuthority.serverUrl,
    }).cancel(projectId, signal);
    this.#clearProjectRetry(projectId);
    return result;
  }

   async #recoverActive(signal: AbortSignal): Promise<void> {
    let catalog: Awaited<ReturnType<CloudBootstrapServiceOptions['transitions']['list']>>;
    try {
      catalog = await this.#prepareLocalRecoveryActive(signal);
    } catch {
      if (!signal.aborted) this.#requestCatalogRetry();
      return;
    }
    let retryRequired = catalog.retryRequired;
    try {
      await this.options.recoverLocalArtifacts(this.options.projectRecoveryAdmission);
    } catch {
      retryRequired = true;
    }
    if (retryRequired) this.#requestCatalogRetry();
    else this.#clearRetry('catalog');
    await Promise.allSettled(
      catalog.records.map(record => this.options.projectRecoveryAdmission(
        record.projectId,
        () => this.#recoverRecord(record, signal),
      )),
    );
  }

   async #prepareLocalRecoveryActive(
    signal: AbortSignal,
  ): Promise<Awaited<ReturnType<CloudBootstrapServiceOptions['transitions']['list']>>> {
    let catalog: Awaited<ReturnType<CloudBootstrapServiceOptions['transitions']['list']>>;
    try {
      catalog = await this.options.transitions.list();
    } catch {
      throw serviceError('cloud-bootstrap-transition-catalog-unavailable');
    }
    if (signal.aborted) throw new CollabError({ code: 'cancelled' });
    const uncertainProjects = new Set<CollabProjectId>(catalog.blockedProjectIds);
    const ownedNonterminalRecords: CloudBootstrapTransitionRecord[] = [];
    for (const record of catalog.records) {
      if (!await this.#isCurrentRecoveryOwner(record)) continue;
      if (record.terminalCleanupCompleted) continue;
      uncertainProjects.add(record.projectId);
      ownedNonterminalRecords.push(record);
    }
    const fenceResults = await Promise.allSettled(
      [...uncertainProjects].map(projectId => (
        this.options.projectRecoveryAdmission(
          projectId,
          () => this.options.fenceUncertainProject(projectId),
        )
      )),
    );
    if (signal.aborted) throw new CollabError({ code: 'cancelled' });
    if (fenceResults.some(result => result.status === 'rejected')) {
      throw serviceError('cloud-bootstrap-local-recovery-fence-failed');
    }
    return { ...catalog, records: ownedNonterminalRecords };
  }

   async #isCurrentRecoveryOwner(
    record: CloudBootstrapTransitionRecord,
  ): Promise<boolean> {
    try {
      await this.options.assertRecoveryOwner(record.ownerInstallationKey, record.projectId);
      return true;
    } catch (error) {
      if (
        record.ownerInstallationKey !== undefined
        &&
        error instanceof CollabError
        && error.safeContext.reason === 'host-installation-recovery-owner-mismatch'
      ) return false;
      throw error;
    }
  }

   #requestCatalogRetry(): void {
    const retryKey = 'catalog';
    if (this.#closing || this.#retryScheduled.has(retryKey)) return;
    this.#retryScheduled.add(retryKey);
    const attempt = (this.#retryAttempts.get(retryKey) ?? 0) + 1;
    this.#retryAttempts.set(retryKey, attempt);
    const delayMs = Math.min(1_000 * (2 ** (attempt - 1)), 30_000);
    const cancellation = this.#scheduleRetry(retryKey, async () => {
      this.#retryCancellations.delete(retryKey);
      this.#retryScheduled.delete(retryKey);
      if (this.#closing) return;
      await this.run(signal => this.#recoverActive(signal));
    }, delayMs);
    if (cancellation) this.#retryCancellations.set(retryKey, cancellation);
  }

   async #recoverRecord(
    record: CloudBootstrapTransitionRecord,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.options.assertRecoveryOwner(record.ownerInstallationKey, record.projectId);
      this.#assertActorBinding(record);
      const recovered = await this.options.createCoordinator({
        developmentActorId: record.developmentActorId,
        serverUrl: record.newAuthority.serverUrl,
      }).recoverProject(record.projectId, signal);
      if (recovered?.attemptState === 'pending') this.#requestRetry(recovered);
      else this.#clearProjectRetry(record.projectId);
    } catch {
      await this.#scheduleIncompleteTransitionRecovery(record.projectId);
    }
  }

   async #runDirectTransition(
    projectId: CollabProjectId,
    operation: () => Promise<CloudBootstrapTransitionRecord>,
  ): Promise<CloudBootstrapTransitionRecord> {
    try {
      const record = await operation();
      this.#trackTransition(record);
      return record;
    } catch (error: unknown) {
      await this.#scheduleIncompleteTransitionRecovery(projectId);
      throw error;
    }
  }

   async #scheduleIncompleteTransitionRecovery(
    projectId: CollabProjectId,
  ): Promise<void> {
    if (this.#closing) return;
    let durable: CloudBootstrapTransitionRecord | null;
    try {
      durable = await this.options.transitions.load(projectId);
    } catch {
      this.#requestCatalogRetry();
      return;
    }
    if (!durable) return;
    try {
      await this.options.assertRecoveryOwner(durable.ownerInstallationKey, projectId);
      this.#assertActorBinding(durable);
    } catch {
      return;
    }
    if (durable.terminalCleanupCompleted) {
      this.#clearProjectRetry(projectId);
      return;
    }
    this.#requestRetry(durable);
  }

   #requestRetry(record: CloudBootstrapTransitionRecord): void {
    const retryKey = `project:${record.projectId}`;
    if (this.#closing || this.#retryScheduled.has(retryKey)) return;
    this.#retryScheduled.add(retryKey);
    const attempt = (this.#retryAttempts.get(retryKey) ?? 0) + 1;
    this.#retryAttempts.set(retryKey, attempt);
    const delayMs = Math.min(1_000 * (2 ** (attempt - 1)), 30_000);
    const cancellation = this.#scheduleRetry(record.projectId, async () => {
      this.#retryCancellations.delete(retryKey);
      this.#retryScheduled.delete(retryKey);
      if (this.#closing) return;
      await this.run(signal => this.options.projectRecoveryAdmission(
        record.projectId,
        () => this.#recoverRecord(record, signal),
      ));
    }, delayMs);
    if (cancellation) this.#retryCancellations.set(retryKey, cancellation);
  }

   #trackTransition(record: CloudBootstrapTransitionRecord): void {
    if (record.attemptState === 'pending') this.#requestRetry(record);
    else this.#clearProjectRetry(record.projectId);
  }

   #clearProjectRetry(projectId: CollabProjectId): void {
    this.#clearRetry(`project:${projectId}`);
  }

   #clearRetry(retryKey: string): void {
    this.#retryCancellations.get(retryKey)?.();
    this.#retryCancellations.delete(retryKey);
    this.#retryScheduled.delete(retryKey);
    this.#retryAttempts.delete(retryKey);
  }

   #assertActorBinding(record: CloudBootstrapTransitionRecord): void {
    if (record.developmentActorId !== record.memberId) {
      throw serviceError('cloud-bootstrap-transition-actor-mismatch');
    }
  }

  private readonly controllers = new Set<AbortController>();

  private run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#closing) return Promise.reject(serviceError('cloud-bootstrap-service-closing'));
    const controller = new AbortController();
    this.controllers.add(controller);
    const active = Promise.resolve().then(() => operation(controller.signal));
    this.active.add(active);
    const remove = (): void => {
      this.active.delete(active);
      this.controllers.delete(controller);
    };
    void active.then(remove, remove);
    return active;
  }
}
