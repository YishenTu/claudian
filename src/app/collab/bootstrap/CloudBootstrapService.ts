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
  readonly createCoordinator: (input: {
    readonly developmentActorId: string;
    readonly serverUrl: string;
  }) => CloudBootstrapCoordinator;
  readonly fenceUncertainProject: (projectId: CollabProjectId) => Promise<void>;
  readonly recoverLocalArtifacts: () => Promise<void>;
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
  private closePromise: Promise<void> | null = null;
  private closing = false;
  private readonly retryAttempts = new Map<string, number>();
  private readonly retryCancellations = new Map<string, () => void>();
  private readonly retryScheduled = new Set<string>();
  private readonly scheduleRetry: NonNullable<CloudBootstrapServiceOptions['scheduleRetry']>;

  constructor(private readonly options: CloudBootstrapServiceOptions) {
    this.scheduleRetry = options.scheduleRetry ?? ((_projectId, retry, delayMs) => {
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
    return this.run(signal => this.runDirectTransition(
      input.projectId,
      () => this.options.createCoordinator(coordinatorInput)
        .startFormerHost(coordinatorInput, signal),
    ));
  }

  submitParticipant(
    input: SubmitCloudBootstrapServiceParticipantInput,
  ): Promise<CloudBootstrapTransitionRecord> {
    const coordinatorInput: SubmitCloudBootstrapParticipantInput = {
      ...input,
      developmentActorId: input.memberId,
    };
    return this.run(signal => this.runDirectTransition(
      input.projectId,
      () => this.options.createCoordinator(coordinatorInput)
        .submitParticipant(coordinatorInput, signal),
    ));
  }

  cancel(projectId: CollabProjectId): Promise<CloudBootstrapTransitionRecord> {
    return this.run(signal => this.cancelActive(projectId, signal));
  }

  recoverPending(): Promise<void> {
    return this.run(signal => this.recoverActive(signal));
  }

  prepareLocalRecovery(): Promise<void> {
    return this.run(async signal => {
      await this.prepareLocalRecoveryActive(signal);
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    for (const controller of this.controllers) controller.abort();
    for (const cancel of this.retryCancellations.values()) cancel();
    this.retryCancellations.clear();
    this.retryScheduled.clear();
    this.retryAttempts.clear();
    this.closePromise = Promise.allSettled([...this.active]).then(() => undefined);
    return this.closePromise;
  }

  private async cancelActive(
    projectId: CollabProjectId,
    signal: AbortSignal,
  ): Promise<CloudBootstrapTransitionRecord> {
    const record = await this.options.transitions.load(projectId);
    if (!record) throw serviceError('cloud-bootstrap-transition-not-found');
    this.assertActorBinding(record);
    const result = await this.options.createCoordinator({
      developmentActorId: record.developmentActorId,
      serverUrl: record.newAuthority.serverUrl,
    }).cancel(projectId, signal);
    this.clearProjectRetry(projectId);
    return result;
  }

  private async recoverActive(signal: AbortSignal): Promise<void> {
    let catalog: Awaited<ReturnType<CloudBootstrapServiceOptions['transitions']['list']>>;
    try {
      catalog = await this.prepareLocalRecoveryActive(signal);
    } catch {
      if (!signal.aborted) this.requestCatalogRetry();
      return;
    }
    let retryRequired = catalog.retryRequired;
    try {
      await this.options.recoverLocalArtifacts();
    } catch {
      retryRequired = true;
    }
    if (retryRequired) this.requestCatalogRetry();
    else this.clearRetry('catalog');
    await Promise.allSettled(
      catalog.records.map(record => this.recoverRecord(record, signal)),
    );
  }

  private async prepareLocalRecoveryActive(
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
    for (const record of catalog.records) {
      if (!record.terminalCleanupCompleted) {
        uncertainProjects.add(record.projectId);
      }
    }
    const fenceResults = await Promise.allSettled(
      [...uncertainProjects].map(projectId => (
        this.options.fenceUncertainProject(projectId)
      )),
    );
    if (signal.aborted) throw new CollabError({ code: 'cancelled' });
    if (fenceResults.some(result => result.status === 'rejected')) {
      throw serviceError('cloud-bootstrap-local-recovery-fence-failed');
    }
    return catalog;
  }

  private requestCatalogRetry(): void {
    const retryKey = 'catalog';
    if (this.closing || this.retryScheduled.has(retryKey)) return;
    this.retryScheduled.add(retryKey);
    const attempt = (this.retryAttempts.get(retryKey) ?? 0) + 1;
    this.retryAttempts.set(retryKey, attempt);
    const delayMs = Math.min(1_000 * (2 ** (attempt - 1)), 30_000);
    const cancellation = this.scheduleRetry(retryKey, async () => {
      this.retryCancellations.delete(retryKey);
      this.retryScheduled.delete(retryKey);
      if (this.closing) return;
      await this.run(signal => this.recoverActive(signal));
    }, delayMs);
    if (cancellation) this.retryCancellations.set(retryKey, cancellation);
  }

  private async recoverRecord(
    record: CloudBootstrapTransitionRecord,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      this.assertActorBinding(record);
      const recovered = await this.options.createCoordinator({
        developmentActorId: record.developmentActorId,
        serverUrl: record.newAuthority.serverUrl,
      }).recoverProject(record.projectId, signal);
      if (recovered?.attemptState === 'pending') this.requestRetry(recovered);
      else this.clearProjectRetry(record.projectId);
    } catch {
      await this.scheduleIncompleteTransitionRecovery(record.projectId);
    }
  }

  private async runDirectTransition(
    projectId: CollabProjectId,
    operation: () => Promise<CloudBootstrapTransitionRecord>,
  ): Promise<CloudBootstrapTransitionRecord> {
    try {
      const record = await operation();
      this.trackTransition(record);
      return record;
    } catch (error: unknown) {
      await this.scheduleIncompleteTransitionRecovery(projectId);
      throw error;
    }
  }

  private async scheduleIncompleteTransitionRecovery(
    projectId: CollabProjectId,
  ): Promise<void> {
    if (this.closing) return;
    let durable: CloudBootstrapTransitionRecord | null;
    try {
      durable = await this.options.transitions.load(projectId);
    } catch {
      this.requestCatalogRetry();
      return;
    }
    if (!durable) return;
    try {
      this.assertActorBinding(durable);
    } catch {
      return;
    }
    if (durable.terminalCleanupCompleted) {
      this.clearProjectRetry(projectId);
      return;
    }
    this.requestRetry(durable);
  }

  private requestRetry(record: CloudBootstrapTransitionRecord): void {
    const retryKey = `project:${record.projectId}`;
    if (this.closing || this.retryScheduled.has(retryKey)) return;
    this.retryScheduled.add(retryKey);
    const attempt = (this.retryAttempts.get(retryKey) ?? 0) + 1;
    this.retryAttempts.set(retryKey, attempt);
    const delayMs = Math.min(1_000 * (2 ** (attempt - 1)), 30_000);
    const cancellation = this.scheduleRetry(record.projectId, async () => {
      this.retryCancellations.delete(retryKey);
      this.retryScheduled.delete(retryKey);
      if (this.closing) return;
      await this.run(signal => this.recoverRecord(record, signal));
    }, delayMs);
    if (cancellation) this.retryCancellations.set(retryKey, cancellation);
  }

  private trackTransition(record: CloudBootstrapTransitionRecord): void {
    if (record.attemptState === 'pending') this.requestRetry(record);
    else this.clearProjectRetry(record.projectId);
  }

  private clearProjectRetry(projectId: CollabProjectId): void {
    this.clearRetry(`project:${projectId}`);
  }

  private clearRetry(retryKey: string): void {
    this.retryCancellations.get(retryKey)?.();
    this.retryCancellations.delete(retryKey);
    this.retryScheduled.delete(retryKey);
    this.retryAttempts.delete(retryKey);
  }

  private assertActorBinding(record: CloudBootstrapTransitionRecord): void {
    if (record.developmentActorId !== record.memberId) {
      throw serviceError('cloud-bootstrap-transition-actor-mismatch');
    }
  }

  private readonly controllers = new Set<AbortController>();

  private run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(serviceError('cloud-bootstrap-service-closing'));
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
