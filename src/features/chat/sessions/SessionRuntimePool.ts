import type { ChatSessionRuntime, SessionIdentity } from './ChatSessionRuntime';

export interface SessionAttachmentOwner {
  reveal(isCurrent?: () => boolean): void | Promise<void>;
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
  readonly attention: ChatSessionRuntime['statusAttention'];
}

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
  unsubscribe(): void;
}

function readStatus(runtime: ChatSessionRuntime): SessionStatus {
  return { conversationId: runtime.conversationId, isWorking: runtime.isWorking, attention: runtime.statusAttention };
}

export class SessionRuntimePool {
  private readonly records = new Map<ChatSessionRuntime, SessionRecord>();
  private readonly conversations = new Map<string, SessionRecord>();
  private readonly keys = new Map<string, SessionRecord>();
  /** Removed sessions remain owned until their asynchronous cleanup finishes. */
  private readonly draining = new Set<Promise<void>>();
  private closing = false;
  private disposal: Promise<void> | null = null;

  constructor(private readonly deps: {
    createRuntime(identity: SessionIdentity): ChatSessionRuntime;
    releaseHistory(id: string, canRelease: () => boolean): Promise<boolean>;
    onChanged(): void;
    onError(error: unknown): void;
  }) {}

  get(id: string): ChatSessionRuntime | null { return this.conversations.get(id)?.runtime ?? null; }
  isRunning(id: string): boolean { return this.get(id)?.isWorking ?? false; }
  getAttachment(id: string): SessionAttachment | null { return this.conversations.get(id)?.attachment ?? null; }
  getAll(): readonly ChatSessionRuntime[] { return [...this.records.keys()]; }

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
    return { acquired: true, attachment };
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
      attachment: null, eviction: null, retired: false, holds: 0, settledWaiters: [], unsubscribe: () => undefined,
    };
    this.records.set(runtime, record);
    this.keys.set(runtime.sessionKey, record);
    if (record.status.conversationId) this.conversations.set(record.status.conversationId, record);
    record.unsubscribe = runtime.subscribe(() => this.changed(record));
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
    if (!status.isWorking) this.settleWaiters(record, true);
    if (record.retired) {
      if (this.isReleasable(record)) void this.disposeRecord(record).catch(error => this.deps.onError(error));
      return;
    }
    if (record.eviction || !this.canEvict(record)) return;
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

  /** Returns true when changing retention conditions interrupted the attempt. */
  private async evict(record: SessionRecord): Promise<boolean> {
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
    const released = await this.deps.releaseHistory(runtime.conversationId, eligible);
    if (!eligible()) return true;
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
