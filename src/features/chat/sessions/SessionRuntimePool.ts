import type { ChatSessionRuntime, SessionIdentity } from './ChatSessionRuntime';

export interface SessionRevealOptions {
  /** Navigation may wait for a closing presentation to release its attachment before choosing another owner. */
  awaitClose?: boolean;
}

export interface SessionAttachmentOwner {
  reveal(isCurrent?: () => boolean, options?: SessionRevealOptions): void | Promise<void>;
}

/** Object identity is the attachment generation; only the pool can issue a current handle. */
export interface SessionAttachment {
  readonly runtime: ChatSessionRuntime;
  readonly owner: SessionAttachmentOwner;
}

/** Keeps a detached draft session alive and reattachable by `key`; `release` is idempotent. */
export interface DraftSessionHold {
  readonly key: string;
  readonly runtime: ChatSessionRuntime;
  release(): void;
}

export class SessionAlreadyAttached extends Error {
  constructor(readonly attachment: SessionAttachment) { super('Session already attached'); }
}

/** What session lists and status indicators read; other runtime changes stay inside the session. */
interface SessionStatus {
  readonly conversationId: string | null;
  readonly isWorking: boolean;
  readonly isMainWorking: boolean;
  readonly attention: ChatSessionRuntime['statusAttention'];
}

/**
 * Whether a session's cached history and provider session match its native history. `current` holds the
 * revision they last matched: read when a presentation first loads them and whenever their own main work
 * settles. `stale` means it changed outside Claudian; only a completed reload clears it, from the revision
 * read just before that reload's hydration.
 */
type NativeHistoryFreshness =
  | { readonly state: 'unknown' }
  | { readonly state: 'current'; readonly revision: string }
  | { readonly state: 'stale'; readonly reloadRevision: Promise<string | null> | null };

interface SessionRecord {
  readonly runtime: ChatSessionRuntime;
  /** Last published projection; its conversation id is also this record's index key. */
  status: SessionStatus;
  attachment: SessionAttachment | null;
  eviction: Promise<void> | null;
  /** Its conversation was deleted; the session is disposed as soon as it is detached and idle. */
  retired: boolean;
  /** Holders that will reattach this session by its key; a held draft is never disposed as idle. */
  holds: number;
  settledWaiters: Array<(settled: boolean) => void>;
  /** When a presentation last detached it; 0 if none ever has. Orders retention of viewed sessions. */
  viewedAt: number;
  freshness: NativeHistoryFreshness;
  /** The latest baseline read while it is in flight; only it may set the baseline, and checks join it. */
  revisionRead: Promise<void> | null;
  /** Every opener joins the complete check, eviction and provider release. */
  revalidation: Promise<void> | null;
  unsubscribe(): void;
}

function readStatus(runtime: ChatSessionRuntime): SessionStatus {
  return { conversationId: runtime.conversationId, isWorking: runtime.isWorking, isMainWorking: runtime.isMainWorking, attention: runtime.statusAttention };
}

export class SessionRuntimePool {
  private readonly records = new Map<ChatSessionRuntime, SessionRecord>();
  private readonly conversations = new Map<string, SessionRecord>();
  private readonly keys = new Map<string, SessionRecord>();
  /** Removed sessions remain owned until their asynchronous cleanup finishes. */
  private readonly draining = new Set<Promise<void>>();
  private closing = false;
  private disposal: Promise<void> | null = null;
  private viewSequence = 0;

  constructor(private readonly deps: {
    createRuntime(identity: SessionIdentity): ChatSessionRuntime;
    releaseHistory(id: string, canRelease: () => boolean): Promise<boolean>;
    /** The provider's opaque revision of a conversation's native history; null when unknown. */
    readNativeHistoryRevision?(id: string): Promise<string | null>;
    /** Recently viewed idle conversation sessions that keep their loaded history; 0 when omitted. */
    retainedDetachedSessions?: number;
    onChanged(): void;
    /** A conversation's session finished its work: running turns, background work and side chat. */
    onSessionSettled?(conversationId: string): void;
    onError(error: unknown): void;
  }) {}

  get(id: string): ChatSessionRuntime | null { return this.conversations.get(id)?.runtime ?? null; }
  isRunning(id: string): boolean { return this.get(id)?.isWorking ?? false; }
  getAttachment(id: string): SessionAttachment | null { return this.conversations.get(id)?.attachment ?? null; }
  getAll(): readonly ChatSessionRuntime[] { return [...this.records.keys()]; }

  /** Reads without a main model must not leave history outside the pool's retention budget. */
  async releaseUnownedHistory(id: string): Promise<void> {
    const canRelease = () => !this.closing && ![...this.records.keys()].some(
      runtime => runtime.conversationId === id && runtime.peekModel,
    );
    // Model hydration must not wait on a persistence queue just to decline cleanup.
    // Read runtime identities directly: a draft's promotion may not be published yet.
    if (!canRelease()) return;
    await this.deps.releaseHistory(id, canRelease);
  }

  /** Let first-turn shells adopt their draft runtime before another caller claims a published ID. */
  async awaitConversationCreations(): Promise<void> {
    await Promise.allSettled([...this.records.keys()]
      .filter(runtime => !runtime.conversationId)
      .map(runtime => runtime.peekModel?.conversationController.awaitCreation() ?? Promise.resolve()));
  }

  /** Reserves synchronously, before model hydration or any view construction can yield. */
  acquire(identity: SessionIdentity, owner: SessionAttachmentOwner): { acquired: boolean; attachment: SessionAttachment } {
    if (this.closing) throw new Error('Session runtime pool is shutting down');
    let record = (identity.conversationId ? this.conversations.get(identity.conversationId) : undefined)
      ?? (identity.draftSessionKey ? this.keys.get(identity.draftSessionKey) : undefined);
    if (record?.attachment) return { acquired: false, attachment: record.attachment };
    if (!record) {
      const { draftSessionKey: _unused, ...sessionIdentity } = identity;
      record = this.create(sessionIdentity);
    }
    const attachment = Object.freeze({ runtime: record.runtime, owner });
    record.attachment = attachment;
    // Read before the presentation hydrates, so a change landing during hydration counts as newer.
    if (record.freshness.state === 'unknown' && !record.revisionRead) this.observeNativeRevision(record);
    return { acquired: true, attachment };
  }

  /**
   * Before a presentation shows a conversation's idle session, drops its cached history and provider
   * session when native history changed outside Claudian since they last matched it, so the history is
   * read again and the next send resumes from it. Detached sessions are evicted; the presentation that
   * holds `attachment` keeps its model, whose hydration is reset for the caller to run, and its main sends
   * wait for the check and reload. A revision that can no longer be read after one was known counts as
   * changed; a change whose reload was declined is retried by the next check. Null, without yielding,
   * when there is nothing to check.
   */
  revalidate(conversationId: string, attachment?: SessionAttachment): Promise<void> | null {
    const record = this.conversations.get(conversationId);
    if (!record) return null;
    if (record.revalidation) return record.revalidation;
    if (record.freshness.state === 'unknown' && !record.revisionRead) return null;
    if (!this.canRevalidate(record, attachment)) return null;
    const model = record.runtime.peekModel;
    record.revalidation = (attachment && model
      ? model.refreshHistory(async () => await this.isStale(conversationId, record, attachment)
        && await this.reloadAttached(conversationId, record, attachment))
      : this.revalidateDetached(conversationId, record))
      .finally(() => { record.revalidation = null; });
    return record.revalidation;
  }

  private canRevalidate(record: SessionRecord, attachment: SessionAttachment | undefined): boolean {
    if (!attachment) return this.canEvict(record);
    const model = record.runtime.peekModel;
    return this.records.get(record.runtime) === record && !this.closing && record.attachment === attachment
      && record.runtime.isIdle && !!model && model.canRefreshHistory;
  }

  /** Compares a current baseline with native history, marking it stale on a change; true while stale. */
  private async isStale(conversationId: string, record: SessionRecord, attachment: SessionAttachment | undefined): Promise<boolean> {
    // The baseline may still be landing: a first read, a retry after hydration, or a settled turn's own writes.
    while (record.revisionRead) await record.revisionRead;
    const baseline = record.freshness;
    if (baseline.state !== 'current') return baseline.state === 'stale' && this.canRevalidate(record, attachment);
    if (!this.canRevalidate(record, attachment)) return false;
    const current = await this.readNativeRevision(conversationId);
    // A newer baseline supersedes this comparison.
    if (current === baseline.revision || record.freshness !== baseline || record.revisionRead) return false;
    record.freshness = { state: 'stale', reloadRevision: null };
    await record.eviction;
    if (!this.canRevalidate(record, attachment)) return false;
    // Opening the presentation must not fail on it; a session that cannot release stays marked stale.
    await record.runtime.executionCoordinator.releaseForChangedHistory().catch(error => this.deps.onError(error));
    return this.canRevalidate(record, attachment);
  }

  private async revalidateDetached(conversationId: string, record: SessionRecord): Promise<void> {
    if (!await this.isStale(conversationId, record, undefined)) return;
    record.eviction = this.evict(record, { retain: false }).then(interrupted => {
      record.eviction = null;
      if (interrupted) this.changed(record);
    }, error => {
      record.eviction = null;
      this.deps.onError(error);
    });
    await record.eviction;
    // Nothing cached remains to be stale; the next presentation hydrates afresh and reads a new baseline.
    if (!record.runtime.peekModel) record.freshness = { state: 'unknown' };
  }

  /** Drops the cached history under its presentation; true when it did, so the presentation hydrates it again. */
  private async reloadAttached(conversationId: string, record: SessionRecord, attachment: SessionAttachment): Promise<boolean> {
    const model = record.runtime.peekModel;
    const freshness = record.freshness;
    if (!model || freshness.state !== 'stale') return false;
    const eligible = () => this.canRevalidate(record, attachment) && record.runtime.peekModel === model && record.freshness === freshness;
    try {
      // A dirty transcript is written before native history replaces it, as detached eviction does.
      if (model.state.hasPendingConversationSave) await model.conversationController.save(false);
      if (model.state.hasPendingConversationSave || !eligible()) return false;
      if (!await this.deps.releaseHistory(conversationId, eligible) || !eligible()) return false;
    } catch (error) {
      this.deps.onError(error);
      return false;
    }
    // Read before the presentation hydrates, so a change landing during hydration counts as newer.
    record.freshness = { state: 'stale', reloadRevision: this.readNativeRevision(conversationId) };
    return true;
  }

  private observeNativeRevision(record: SessionRecord): void {
    const id = record.runtime.conversationId;
    if (!id || !this.deps.readNativeHistoryRevision || record.freshness.state === 'stale') return;
    const read: Promise<void> = this.readNativeRevision(id).then(revision => {
      if (record.revisionRead !== read || record.freshness.state === 'stale' || this.records.get(record.runtime) !== record) return;
      record.freshness = revision ? { state: 'current', revision } : { state: 'unknown' };
    }).finally(() => {
      if (record.revisionRead === read) record.revisionRead = null;
    });
    record.revisionRead = read;
  }

  private async observeHydratedRevision(record: SessionRecord): Promise<void> {
    const freshness = record.freshness;
    if (freshness.state === 'stale') {
      if (!freshness.reloadRevision) return;
      const revision = await freshness.reloadRevision;
      if (record.freshness !== freshness || this.records.get(record.runtime) !== record) return;
      record.freshness = revision ? { state: 'current', revision } : { state: 'unknown' };
      if (revision) return;
    }
    while (record.revisionRead) await record.revisionRead;
    if (this.records.get(record.runtime) === record && record.freshness.state === 'unknown') this.observeNativeRevision(record);
  }

  private async readNativeRevision(id: string): Promise<string | null> {
    return await this.deps.readNativeHistoryRevision?.(id).catch(() => null) ?? null;
  }

  /**
   * Returns a conversation's session without attaching it, creating one if none exists. Creation
   * loads neither history nor provider resources; the session stays reachable by its conversation.
   */
  ensure(identity: SessionIdentity & { conversationId: string }): ChatSessionRuntime {
    if (this.closing) throw new Error('Session runtime pool is shutting down');
    return (this.conversations.get(identity.conversationId) ?? this.create(identity)).runtime;
  }

  private create(identity: SessionIdentity): SessionRecord {
    const runtime = this.deps.createRuntime(identity);
    const record: SessionRecord = {
      runtime, status: readStatus(runtime),
      attachment: null, eviction: null, retired: false, holds: 0, settledWaiters: [], viewedAt: 0,
      freshness: { state: 'unknown' }, revisionRead: null, revalidation: null,
      unsubscribe: () => undefined,
    };
    this.records.set(runtime, record);
    this.keys.set(runtime.sessionKey, record);
    if (record.status.conversationId) this.conversations.set(record.status.conversationId, record);
    const unsubscribeChanged = runtime.subscribe(() => this.changed(record));
    const unsubscribeHydrated = runtime.subscribeHydrated(() => {
      // Hydration can start a native host that was unavailable at the initial read.
      void this.observeHydratedRevision(record);
    });
    record.unsubscribe = () => { unsubscribeChanged(); unsubscribeHydrated(); };
    return record;
  }

  /**
   * Holds a session for a presentation that will reattach it by key. Only a draft depends on
   * the hold: a session bound to a conversation stays reachable by its conversation anyway.
   */
  holdDraft(runtime: ChatSessionRuntime): DraftSessionHold {
    const record = this.records.get(runtime);
    if (!record) throw new Error('Session is not owned by this pool');
    record.holds += 1;
    let held = true;
    return {
      key: runtime.sessionKey,
      runtime,
      release: () => {
        if (!held) return;
        held = false;
        record.holds -= 1;
        if (this.records.get(runtime) === record) this.changed(record);
      },
    };
  }

  release(attachment: SessionAttachment): void {
    const record = this.records.get(attachment.runtime);
    if (!record || record.attachment !== attachment) return;
    record.runtime.peekModel?.detach();
    record.attachment = null;
    record.viewedAt = ++this.viewSequence;
    this.changed(record);
  }

  private changed(record: SessionRecord): void {
    const previous = record.status;
    const status = readStatus(record.runtime);
    const promoted = status.conversationId !== previous.conversationId;
    if (promoted) {
      const existing = status.conversationId ? this.conversations.get(status.conversationId) : undefined;
      if (existing && existing !== record) throw new Error('Conversation already owns a session runtime');
      if (previous.conversationId) this.conversations.delete(previous.conversationId);
      if (status.conversationId) this.conversations.set(status.conversationId, record);
    }
    record.status = status;
    // Streaming, usage and presentation changes leave session lists untouched.
    if (promoted || status.isWorking !== previous.isWorking || status.attention !== previous.attention) this.deps.onChanged();
    // Only main work reconciles the cached main transcript and provider context.
    if (previous.isMainWorking && !status.isMainWorking && status.conversationId) this.observeNativeRevision(record);
    if (previous.isWorking && !status.isWorking && status.conversationId) this.deps.onSessionSettled?.(status.conversationId);
    if (!status.isWorking) this.settleWaiters(record, true);
    if (record.retired) {
      if (this.isReleasable(record)) void this.disposeRecord(record).catch(error => this.deps.onError(error));
      return;
    }
    if (record.eviction || !this.canEvict(record)) return;
    if (record.viewedAt > 0 && this.deps.retainedDetachedSessions) {
      // A newly retained session can push the least recently viewed one past the limit. A session with
      // a pending save retries it on its own changes, not on every other session's detach.
      for (const other of this.records.values()) {
        if (other !== record && !other.runtime.peekModel?.state.hasPendingConversationSave) this.scheduleEviction(other);
      }
    }
    this.scheduleEviction(record);
  }

  private scheduleEviction(record: SessionRecord): void {
    if (record.eviction || !this.canEvict(record)) return;
    // Retention keeps history loaded; a pending save is still flushed on detach.
    if (this.isRetained(record) && !record.runtime.peekModel?.state.hasPendingConversationSave) return;
    // Let the initiating operation publish all of its state before examining retention.
    record.eviction = Promise.resolve().then(() => this.evict(record))
      .then(interrupted => {
        record.eviction = null;
        // Work may have settled while this attempt was yielding. Its notification could not
        // schedule another attempt until this one released ownership.
        if (interrupted) this.changed(record);
      }, error => {
        record.eviction = null;
        this.deps.onError(error);
      });
  }

  private canEvict(record: SessionRecord): boolean {
    const { runtime } = record;
    return this.records.get(runtime) === record && !this.closing && !record.attachment
      && runtime.isIdle && (!runtime.peekModel || runtime.peekModel.canEvict);
  }

  /** Among loaded, evictable conversation sessions, only the most recently viewed keep their history. */
  private isRetained(record: SessionRecord): boolean {
    const limit = this.deps.retainedDetachedSessions ?? 0;
    if (limit <= 0 || record.viewedAt === 0 || !record.runtime.conversationId || !record.runtime.peekModel) return false;
    let newer = 0;
    for (const other of this.records.values()) {
      if (other !== record && other.viewedAt > record.viewedAt && other.runtime.conversationId
        && other.runtime.peekModel && this.canEvict(other) && ++newer >= limit) return false;
    }
    return true;
  }

  /** Returns true when changing retention conditions interrupted the attempt. */
  private async evict(record: SessionRecord, options: { retain: boolean } = { retain: true }): Promise<boolean> {
    const { runtime } = record;
    const model = runtime.peekModel;
    const eligible = () => this.canEvict(record) && runtime.peekModel === model;
    if (!eligible()) return true;
    if (!runtime.conversationId) {
      // A held draft is reattached by its key; otherwise nothing can acquire it again.
      if (record.holds > 0) return false;
      await this.disposeRecord(record);
      return false;
    }
    if (!model) return false;
    if (model.state.hasPendingConversationSave) {
      await model.conversationController.save(false);
      if (!eligible()) return true;
    }
    const retained = () => options.retain && this.isRetained(record);
    if (retained()) return false;
    const releasable = () => eligible() && !retained();
    const released = await this.deps.releaseHistory(runtime.conversationId, releasable);
    if (!releasable()) return true;
    if (released) runtime.releaseModel(model);
    return false;
  }

  private settleWaiters(record: SessionRecord, settled: boolean): void {
    for (const resolve of record.settledWaiters.splice(0)) resolve(settled);
  }

  private remove(record: SessionRecord): void {
    this.settleWaiters(record, false);
    record.unsubscribe();
    this.records.delete(record.runtime);
    this.keys.delete(record.runtime.sessionKey);
    if (record.status.conversationId) this.conversations.delete(record.status.conversationId);
  }

  /**
   * Resolves true once the conversation's session has no work, or has no session. Resolves false
   * when shutdown or removal supersedes the wait; shutdown then owns the session's drain.
   */
  whenSettled(id: string): Promise<boolean> {
    const record = this.conversations.get(id);
    if (this.closing) return Promise.resolve(false);
    if (!record?.runtime.isWorking) return Promise.resolve(true);
    return new Promise(resolve => record.settledWaiters.push(resolve));
  }

  /**
   * Disposes a deleted conversation's session without saving, once no view shows it and it has no
   * work. A view that still shows it, or work that outlived deletion, defers disposal until both end.
   */
  retire(id: string): Promise<void> {
    const record = this.conversations.get(id);
    if (!record) return Promise.resolve();
    record.retired = true;
    record.runtime.mailbox?.clear();
    return this.isReleasable(record) ? this.disposeRecord(record) : Promise.resolve();
  }

  private isReleasable(record: SessionRecord): boolean {
    return this.records.get(record.runtime) === record && !this.closing && !record.attachment && !record.runtime.isWorking;
  }

  private disposeRecord(record: SessionRecord): Promise<void> {
    this.remove(record);
    const disposal = (async () => {
      // Retirement joins any history release; draft eviction must not await itself.
      if (record.retired) await record.eviction;
      await record.runtime.dispose({ save: !record.retired });
    })().finally(() => { this.draining.delete(disposal); });
    this.draining.add(disposal);
    return disposal;
  }

  beginShutdown(): void {
    if (this.closing) return;
    this.closing = true;
    for (const record of this.records.values()) {
      this.settleWaiters(record, false);
      record.runtime.beginShutdown();
    }
  }

  dispose(): Promise<void> {
    this.beginShutdown();
    return this.disposal ??= (async () => {
      const records = [...this.records.values()];
      const draining = [...this.draining];
      await Promise.allSettled(records.flatMap(record => record.eviction ? [record.eviction] : []));
      const results = await Promise.allSettled([...draining, ...records.map(record => this.disposeRecord(record))]);
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason as unknown), 'Failed to drain session runtimes');
    })();
  }
}
