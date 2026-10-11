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
});
