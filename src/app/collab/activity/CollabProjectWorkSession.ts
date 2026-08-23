import { type CollabProjectId } from '@claudian-collab/protocol';

import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import type { CollabProjectSnapshot } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CollabProjectResource {
  dispose(): void;
}

export interface CollabProjectInspectionLease {
  readonly precedingSynchronization: Promise<void> | null;
  release(): void;
}

interface BackgroundSynchronization {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
}

function closedError(projectId: CollabProjectId): CollabError {
  return new CollabError({
    code: 'project-retired',
    safeContext: { projectId, reason: 'project-activity-closed' },
  });
}

function registryClosedError(): CollabError {
  return new CollabError({
    code: 'cancelled',
    safeContext: { reason: 'project-work-session-registry-closed' },
  });
}

function generationChangedError(): CollabError {
  return new CollabError({
    code: 'cancelled',
    safeContext: { reason: 'projection-project-connection-reset' },
  });
}

export class CollabProjectWorkSession {
  private authoritySession: Promise<CollabProjectResource> | null = null;
  private autoReconnectTask: Promise<boolean> | null = null;
  private backgroundSynchronization: BackgroundSynchronization | null = null;
  private readonly cacheUpdateQueue = new SerialTaskQueue();
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private eventConnection: CollabProjectResource | null = null;
  private coordinationSubscription: Promise<CollabProjectResource> | null = null;
  private readonly detachedTasks = new Set<Promise<unknown>>();
  private eventRefresh: Promise<number> | null = null;
  private inspections = new Set<Promise<void>>();
  private readonly mutationQueue = new SerialTaskQueue();
  private projectionGeneration = 0;
  private snapshotRead: Promise<CollabProjectSnapshot> | null = null;

  observedAcceptedMainOid: string | null = null;

  constructor(readonly projectId: CollabProjectId) {}

  get generation(): number {
    return this.projectionGeneration;
  }

  beginInspection(): CollabProjectInspectionLease {
    this.assertOpen();
    const precedingSynchronization = this.backgroundSynchronization?.settled ?? null;
    let complete!: () => void;
    const completion = new Promise<void>(resolve => { complete = resolve; });
    this.inspections.add(completion);
    let released = false;
    return {
      precedingSynchronization,
      release: () => {
        if (released) return;
        released = true;
        this.inspections.delete(completion);
        complete();
      },
    };
  }

  scheduleSynchronization(
    synchronize: (signal: AbortSignal) => Promise<unknown>,
  ): void {
    if (this.closed) return;
    const preceding = this.backgroundSynchronization;
    preceding?.controller.abort();
    const controller = new AbortController();
    const prerequisites = [
      ...(preceding ? [preceding.settled] : []),
      ...this.inspections,
    ];
    const settled = Promise.all(prerequisites)
      .then(() => controller.signal.aborted ? undefined : synchronize(controller.signal))
      .then(() => undefined, () => undefined);
    const task = { controller, settled };
    this.backgroundSynchronization = task;
    void settled.then(() => {
      if (this.backgroundSynchronization === task) this.backgroundSynchronization = null;
    });
  }

  abortBackgroundSynchronization(): void {
    this.backgroundSynchronization?.controller.abort();
  }

  coalesceAutoReconnect(start: () => Promise<boolean>): Promise<boolean> {
    this.assertOpen();
    if (this.autoReconnectTask) return this.autoReconnectTask;
    const pending = start();
    this.autoReconnectTask = pending;
    this.clearWhenSettled(
      pending,
      () => this.autoReconnectTask === pending,
      () => { this.autoReconnectTask = null; },
    );
    return pending;
  }

  currentAutoReconnect(): Promise<boolean> | null {
    return this.autoReconnectTask;
  }

  coalesceEventRefresh(
    requiredSequence: number,
    start: () => Promise<number>,
  ): Promise<number> {
    this.assertOpen();
    return this.ensureEventRefreshSequence(requiredSequence, start, true);
  }

  currentEventRefresh(): Promise<number> | null {
    return this.eventRefresh;
  }

  coalesceSnapshot(start: () => Promise<CollabProjectSnapshot>): Promise<CollabProjectSnapshot> {
    this.assertOpen();
    if (this.snapshotRead) return this.snapshotRead;
    const pending = start();
    this.snapshotRead = pending;
    this.clearWhenSettled(
      pending,
      () => this.snapshotRead === pending,
      () => { this.snapshotRead = null; },
    );
    return pending;
  }

  ensureAuthoritySession<T extends CollabProjectResource>(
    create: () => Promise<T>,
  ): Promise<T> {
    this.assertOpen();
    if (this.authoritySession) return this.authoritySession as Promise<T>;
    const generation = this.projectionGeneration;
    const pending = Promise.resolve().then(create).then(resource => {
      if (
        this.closed
        || this.projectionGeneration !== generation
        || this.authoritySession !== pending
      ) {
        resource.dispose();
        if (this.closed) throw closedError(this.projectId);
        throw generationChangedError();
      }
      return resource;
    });
    this.authoritySession = pending;
    void pending.catch(() => {
      if (this.authoritySession === pending) this.authoritySession = null;
    });
    return pending;
  }

  enqueueCacheUpdate(update: () => Promise<void>): Promise<void> {
    this.assertOpen();
    return this.cacheUpdateQueue.run(update);
  }

  drainCacheUpdates(): Promise<void> {
    return this.cacheUpdateQueue.drain();
  }

  runMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(closedError(this.projectId));
    return this.mutationQueue.run(operation);
  }

  setEventConnection(resource: CollabProjectResource): void {
    this.assertOpen();
    if (this.eventConnection && this.eventConnection !== resource) {
      this.eventConnection.dispose();
    }
    this.eventConnection = resource;
  }

  adoptEventConnection(
    resource: CollabProjectResource,
    expectedGeneration: number,
  ): void {
    try {
      this.assertOpen();
      this.assertGeneration(expectedGeneration);
      this.setEventConnection(resource);
    } catch (error: unknown) {
      resource.dispose();
      throw error;
    }
  }

  clearEventConnection(resource: CollabProjectResource): void {
    if (this.eventConnection !== resource) return;
    resource.dispose();
    this.eventConnection = null;
  }

  getEventConnection<T extends CollabProjectResource>(): T | null {
    return this.eventConnection as T | null;
  }

  ensureCoordinationSubscription(
    create: () => Promise<CollabProjectResource>,
  ): Promise<CollabProjectResource> {
    this.assertOpen();
    if (this.coordinationSubscription) return this.coordinationSubscription;
    const pending = create();
    this.coordinationSubscription = pending;
    void pending.catch(() => {
      if (this.coordinationSubscription === pending) this.coordinationSubscription = null;
    });
    return pending;
  }

  resetProjection(): void {
    this.assertOpen();
    this.projectionGeneration += 1;
    this.observedAcceptedMainOid = null;
    this.eventConnection?.dispose();
    this.eventConnection = null;
    const authoritySession = this.authoritySession;
    this.authoritySession = null;
    if (authoritySession) {
      this.trackDetached(authoritySession.then(value => value.dispose(), () => undefined));
    }
    const subscription = this.coordinationSubscription;
    this.coordinationSubscription = null;
    if (subscription) {
      this.trackDetached(subscription.then(value => value.dispose(), () => undefined));
    }
    if (this.snapshotRead) this.trackDetached(this.snapshotRead);
    if (this.eventRefresh) this.trackDetached(this.eventRefresh);
    this.snapshotRead = null;
    this.eventRefresh = null;
  }

  assertGeneration(generation: number): void {
    if (this.projectionGeneration !== generation) {
      throw generationChangedError();
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.backgroundSynchronization?.controller.abort();
    this.eventConnection?.dispose();
    this.eventConnection = null;
    const authoritySession = this.authoritySession;
    this.authoritySession = null;
    const coordinationSubscription = this.coordinationSubscription;
    this.coordinationSubscription = null;
    if (coordinationSubscription) {
      void coordinationSubscription.then(value => value.dispose(), () => undefined);
    }
    this.projectionGeneration += 1;
    const close = Promise.allSettled([
      this.mutationQueue.drain(),
      this.cacheUpdateQueue.drain(),
      this.backgroundSynchronization?.settled ?? Promise.resolve(),
      this.autoReconnectTask ?? Promise.resolve(),
      this.eventRefresh ?? Promise.resolve(),
      this.snapshotRead ?? Promise.resolve(),
      coordinationSubscription ?? Promise.resolve(),
      authoritySession?.then(value => value.dispose(), () => undefined) ?? Promise.resolve(),
      ...this.detachedTasks,
      ...this.inspections,
    ]).then(() => undefined);
    this.closePromise = close;
    return close;
  }

  private assertOpen(): void {
    if (this.closed) throw closedError(this.projectId);
  }

  private ensureEventRefreshSequence(
    requiredSequence: number,
    start: () => Promise<number>,
    allowCatchUp: boolean,
  ): Promise<number> {
    const pending = this.eventRefresh ?? this.startEventRefresh(start);
    return pending.then(sequence => (
      allowCatchUp
      && Number.isSafeInteger(sequence)
      && sequence >= 0
      && sequence < requiredSequence
        ? this.ensureEventRefreshSequence(requiredSequence, start, false)
        : sequence
    ));
  }

  private startEventRefresh(start: () => Promise<number>): Promise<number> {
    const started = start();
    const pending = started.finally(() => {
      if (this.eventRefresh === pending) this.eventRefresh = null;
    });
    this.eventRefresh = pending;
    return pending;
  }

  private clearWhenSettled<T>(
    pending: Promise<T>,
    isCurrent: () => boolean,
    clearCurrent: () => void,
  ): void {
    const clear = () => {
      if (isCurrent()) clearCurrent();
    };
    void pending.then(clear, clear);
  }

  private trackDetached(pending: Promise<unknown>): void {
    this.detachedTasks.add(pending);
    const clear = () => this.detachedTasks.delete(pending);
    void pending.then(clear, clear);
  }
}

export type CollabProjectWorkSessionFactory = (
  projectId: CollabProjectId,
) => CollabProjectWorkSession;

export interface CollabProjectWorkSessionSuspension {
  readonly projectId: CollabProjectId;
  readonly token: symbol;
}

export class CollabProjectWorkSessionRegistry {
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private readonly closedProjects = new Set<CollabProjectId>();
  private readonly closeTasks = new Map<CollabProjectId, Promise<void>>();
  private readonly sessions = new Map<CollabProjectId, CollabProjectWorkSession>();
  private readonly suspensions = new Map<
    CollabProjectId,
    CollabProjectWorkSessionSuspension
  >();

  constructor(
    private readonly create: CollabProjectWorkSessionFactory = (
      projectId => new CollabProjectWorkSession(projectId)
    ),
  ) {}

  acquire(projectId: CollabProjectId): CollabProjectWorkSession {
    if (this.closed) throw registryClosedError();
    if (this.closedProjects.has(projectId) || this.suspensions.has(projectId)) {
      throw closedError(projectId);
    }
    const existing = this.sessions.get(projectId);
    if (existing) return existing;
    const session = this.create(projectId);
    this.sessions.set(projectId, session);
    return session;
  }

  async closeProject(projectId: CollabProjectId): Promise<void> {
    if (this.closed) {
      await this.closePromise;
      return;
    }
    this.closedProjects.add(projectId);
    this.suspensions.delete(projectId);
    const existing = this.closeTasks.get(projectId);
    if (existing) return existing;
    const session = this.sessions.get(projectId);
    this.sessions.delete(projectId);
    const close = session?.close() ?? Promise.resolve();
    this.closeTasks.set(projectId, close);
    await close;
  }

  drainProject(projectId: CollabProjectId): Promise<void> {
    return this.closeProject(projectId);
  }

  resetProject(projectId: CollabProjectId): void {
    if (this.closed || this.closedProjects.has(projectId) || this.suspensions.has(projectId)) {
      return;
    }
    this.sessions.get(projectId)?.resetProjection();
  }

  async suspendProject(
    projectId: CollabProjectId,
  ): Promise<CollabProjectWorkSessionSuspension> {
    if (this.closed) throw registryClosedError();
    const existingSuspension = this.suspensions.get(projectId);
    if (existingSuspension) {
      await this.closeTasks.get(projectId);
      return existingSuspension;
    }
    const suspension = Object.freeze({ projectId, token: Symbol(projectId) });
    if (!this.closedProjects.has(projectId)) this.suspensions.set(projectId, suspension);
    const existingClose = this.closeTasks.get(projectId);
    if (existingClose) {
      await existingClose;
      return suspension;
    }
    const session = this.sessions.get(projectId);
    this.sessions.delete(projectId);
    const close = session?.close() ?? Promise.resolve();
    this.closeTasks.set(projectId, close);
    await close;
    return suspension;
  }

  async resumeProject(suspension: CollabProjectWorkSessionSuspension): Promise<boolean> {
    const { projectId } = suspension;
    const close = this.closeTasks.get(projectId);
    if (close) await close;
    if (this.closed) throw registryClosedError();
    if (
      this.closedProjects.has(projectId)
      || this.suspensions.get(projectId) !== suspension
    ) return false;
    this.suspensions.delete(projectId);
    if (this.closeTasks.get(projectId) === close) this.closeTasks.delete(projectId);
    return true;
  }

  async completeSuspension(suspension: CollabProjectWorkSessionSuspension): Promise<void> {
    const { projectId } = suspension;
    const close = this.closeTasks.get(projectId);
    if (close) await close;
    if (this.suspensions.get(projectId) !== suspension) return;
    this.suspensions.delete(projectId);
    this.closedProjects.add(projectId);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.closePromise = Promise.allSettled([
      ...this.closeTasks.values(),
      ...sessions.map(session => session.close()),
    ]).then(() => undefined);
    return this.closePromise;
  }
}
