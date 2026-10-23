import { createHarness, deferred } from '@test/helpers/ChatExecutionHarness';
import { createSessionModelStub } from '@test/helpers/ConversationPorts';

import { ConversationLifecycle } from '@/features/chat/conversation/ConversationLifecycle';
import { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
import { SessionRuntimePool } from '@/features/chat/sessions/SessionRuntimePool';

describe('session ownership across presentations', () => {
  function setup(options: {
    retainedDetachedSessions?: number;
    releaseHistory?: (id: string) => Promise<boolean>;
    onError?: (error: unknown) => void;
  } = {}) {
    const harness = createHarness();
    const pool = new SessionRuntimePool({
      createRuntime: identity => new ChatSessionRuntime(identity, harness.coordinator, session => createSessionModelStub(session)),
      releaseHistory: options.releaseHistory ?? (async () => true),
      retainedDetachedSessions: options.retainedDetachedSessions,
      onChanged: () => undefined,
      onError: options.onError ?? (error => { throw error; }),
    });
    return { pool, harness };
  }

  it('reserves one attachment before awaits, promotes a running draft in place, and ignores stale detach', async () => {
    const { pool } = setup();
    const owner = { reveal: jest.fn() };
    const first = pool.acquire({ conversationId: null, providerId: 'claude', draftModel: 'model' }, owner);
    const runtime = first.attachment.runtime;
    const held = deferred<void>();
    let signal!: AbortSignal;
    const turn = runtime.turns.run(async current => { signal = current; await held.promise; });
    pool.release(first.attachment);
    runtime.setConversationId('created');
    expect(pool.get('created')).toBe(runtime);
    expect(() => runtime.setConversationId('replacement')).toThrow('bound session');
    expect(() => runtime.bindConversation('created', 'codex')).toThrow('bound session');
    expect(pool.get('replacement')).toBeNull();
    expect(pool.get('created')).toBe(runtime);
    expect(pool.isRunning('created')).toBe(true);
    expect(signal.aborted).toBe(false);
    const store = {
      getConversationList: () => [],
      deleteConversation: jest.fn(async () => undefined),
      setConversationArchived: jest.fn(async () => undefined),
      setConversationsPlacement: jest.fn(async () => undefined),
      restoreConversations: jest.fn(async () => undefined),
      archiveConversationsIf: jest.fn(async () => 1),
    };
    const lifecycle = new ConversationLifecycle({ sessions: pool, conversations: store, views: { getAllViews: () => [] } });
    await lifecycle.setArchived('created', true);
    await lifecycle.delete(['created']);
    expect(store.archiveConversationsIf).not.toHaveBeenCalled();
    expect(store.deleteConversation).not.toHaveBeenCalled();

    const second = pool.acquire({ conversationId: 'created', providerId: 'claude', draftModel: null }, owner);
    expect(second.acquired).toBe(true);
    expect(second.attachment.runtime).toBe(runtime);
    pool.release(first.attachment);
    const duplicate = pool.acquire({ conversationId: 'created', providerId: 'claude', draftModel: null }, { reveal: jest.fn() });
    expect(duplicate.acquired).toBe(false);
    expect(duplicate.attachment).toBe(second.attachment);
    held.resolve();
    await turn;
    await lifecycle.setArchived('created', true);
    await lifecycle.delete(['created']);
    expect(store.archiveConversationsIf).toHaveBeenCalledWith(['created'], expect.any(Function));
    expect(store.deleteConversation).toHaveBeenCalledWith('created');
    await pool.dispose();
  });

  it('fences admissions synchronously and drains a session after its last view detached', async () => {
    const { pool, harness } = setup();
    const { attachment } = pool.acquire({ conversationId: 'running', providerId: 'claude', draftModel: null }, { reveal: jest.fn() });
    const runtime = attachment.runtime;
    const turn = runtime.turns.run(signal => new Promise<void>(resolve => signal.addEventListener('abort', () => resolve())));
    pool.release(attachment);
    pool.beginShutdown();
    expect(runtime.acceptsIntents).toBe(false);
    expect(() => pool.acquire({ conversationId: null, providerId: null, draftModel: null }, { reveal: jest.fn() })).toThrow();
    await pool.dispose();
    await turn;
    expect(harness.coordinator.state).toBe('disposed');
  });

  it('joins a retired session whose provider cleanup is still running after removal', async () => {
    const { pool, harness } = setup();
    const { attachment } = pool.acquire({ conversationId: 'deleted', providerId: 'claude', draftModel: null }, { reveal: jest.fn() });
    await harness.coordinator.bindConversation({ conversationId: 'deleted', providerId: 'claude' });
    await harness.coordinator.prepare();
    const native = harness.backends.get('claude')!.sessions[0];
    const enteredCleanup = deferred<void>();
    const releaseCleanup = deferred<void>();
    const dispose = native.dispose.bind(native);
    jest.spyOn(native, 'dispose').mockImplementation(async () => {
      enteredCleanup.resolve();
      await releaseCleanup.promise;
      await dispose();
    });
    pool.release(attachment);
    const retiring = pool.retire('deleted');
    await enteredCleanup.promise;
    expect(pool.get('deleted')).toBeNull();
    expect(pool.getAll()).not.toContain(attachment.runtime);

    let shutdownFinished = false;
    const shutdown = pool.dispose().then(() => { shutdownFinished = true; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(shutdownFinished).toBe(false);
    } finally {
      releaseCleanup.resolve();
      await Promise.all([retiring, shutdown]);
      await harness.registry.dispose();
    }
    expect(native.disposeCalls).toBe(1);
    expect(shutdownFinished).toBe(true);
  });

  it('keeps a held detached draft reachable by its key, through promotion, until the hold ends', async () => {
    const { pool } = setup();
    const owner = { reveal: jest.fn() };
    const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };
    const draft = pool.acquire({ conversationId: null, providerId: 'claude', draftModel: 'model' }, owner).attachment;
    const runtime = draft.runtime;
    runtime.providerSelections.set('claude', { permissionMode: 'normal', serviceTier: 'default' });
    const hold = pool.holdDraft(runtime);
    pool.release(draft);
    await flush();
    expect(runtime.isDisposed).toBe(false);

    const again = pool.acquire({ conversationId: null, providerId: 'claude', draftModel: 'model', draftSessionKey: hold.key }, owner);
    expect(again.attachment.runtime).toBe(runtime);
    pool.release(again.attachment);
    runtime.setConversationId('created');
    const promoted = pool.acquire({ conversationId: null, providerId: 'claude', draftModel: null, draftSessionKey: hold.key }, owner);
    expect(promoted.attachment.runtime).toBe(runtime);
    pool.release(promoted.attachment);
    hold.release();

    const unheld = pool.acquire({ conversationId: null, providerId: 'claude', draftModel: 'model' }, owner).attachment;
    const released = pool.holdDraft(unheld.runtime);
    pool.release(unheld);
    released.release();
    released.release();
    await flush();
    expect(unheld.runtime.isDisposed).toBe(true);
    expect(pool.acquire({ conversationId: null, providerId: 'claude', draftModel: 'model', draftSessionKey: released.key }, owner)
      .attachment.runtime).not.toBe(unheld.runtime);
  });

  it('keeps the most recently viewed idle sessions loaded and releases the least recent beyond the limit', async () => {
    const released: string[] = [];
    const { pool } = setup({ retainedDetachedSessions: 2, releaseHistory: async id => { released.push(id); return true; } });
    const owner = { reveal: jest.fn() };
    const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
    const view = (id: string) => {
      const { attachment } = pool.acquire({ conversationId: id, providerId: 'claude', draftModel: null }, owner);
      const model = attachment.runtime.model;
      return { attachment, model };
    };

    const a = view('a');
    pool.release(a.attachment);
    const b = view('b');
    pool.release(b.attachment);
    await flush();
    expect(released).toEqual([]);
    expect(a.attachment.runtime.peekModel).toBe(a.model);

    // Viewing a third session pushes the least recently viewed one out.
    const c = view('c');
    pool.release(c.attachment);
    await flush();
    expect(released).toEqual(['a']);
    expect(a.attachment.runtime.peekModel).toBeNull();

    // Returning to a retained session reuses its loaded model and refreshes its recency.
    const again = view('b');
    expect(again.model).toBe(b.model);
    pool.release(again.attachment);
    const d = view('d');
    pool.release(d.attachment);
    await flush();
    expect(released).toEqual(['a', 'c']);
    expect(b.attachment.runtime.peekModel).toBe(b.model);
    expect(d.attachment.runtime.peekModel).toBe(d.model);
    await pool.dispose();
  });

  it('flushes a retained session\'s pending save on detach and reports a failed retry, keeping its history', async () => {
    const released: string[] = [];
    const onError = jest.fn();
    const { pool } = setup({ retainedDetachedSessions: 2, onError, releaseHistory: async id => { released.push(id); return true; } });
    const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
    const { attachment } = pool.acquire({ conversationId: 'unsaved', providerId: 'claude', draftModel: null }, { reveal: jest.fn() });
    const model = attachment.runtime.model;
    // A save that failed at the end of a turn left the conversation dirty.
    const state = { isRewinding: false, hasPendingConversationSave: true };
    Object.defineProperty(model, 'state', { get: () => state });
    const failure = new Error('Vault unavailable');
    const save = jest.spyOn(model.conversationController, 'save').mockRejectedValueOnce(failure);

    pool.release(attachment);
    await flush();
    expect(save).toHaveBeenCalledWith(false);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(released).toEqual([]);
    expect(attachment.runtime.peekModel).toBe(model);

    // Viewing another session does not retry this session's failing save again.
    save.mockRejectedValue(failure);
    const other = pool.acquire({ conversationId: 'other', providerId: 'claude', draftModel: null }, { reveal: jest.fn() });
    void other.attachment.runtime.model;
    pool.release(other.attachment);
    await flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    save.mockResolvedValue(undefined);
    await pool.dispose();
  });
});
