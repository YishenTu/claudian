import { createHarness, deferred } from '@test/helpers/ChatExecutionHarness';
import { createSessionModelStub } from '@test/helpers/ConversationPorts';

import { ConversationLifecycle } from '@/features/chat/conversation/ConversationLifecycle';
import { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
import { SessionRuntimePool } from '@/features/chat/sessions/SessionRuntimePool';

describe('session ownership across presentations', () => {
  function setup() {
    const harness = createHarness();
    const pool = new SessionRuntimePool({
      createRuntime: identity => new ChatSessionRuntime(identity, harness.coordinator, session => createSessionModelStub(session)),
      releaseHistory: async () => true,
      onChanged: () => undefined,
      onError: error => { throw error; },
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
      setConversationsPinned: jest.fn(async () => undefined),
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
});
