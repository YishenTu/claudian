import { deferred } from '@test/helpers/ChatExecutionHarness';
import { createSessionModelStub } from '@test/helpers/ConversationPorts';

import type { SessionMessage } from '@/core/session-tools/sessionMessageEnvelope';
import type { ChatExecutionCoordinator } from '@/features/chat/execution/ChatExecutionCoordinator';
import { SessionMailbox } from '@/features/chat/session-messaging/SessionMailbox';
import { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';

const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const message = (text: string): SessionMessage => ({ from: 'Sender', sessionId: 'sender', text });

function setup() {
  let available = true;
  let userQueued = false;
  const hydrate = deferred<void>();
  const sent: string[] = [];
  const completions: Array<ReturnType<typeof deferred<void>>> = [];
  const callbacks: Array<{ assertBeforeHandoff(): void; onUnsent(reason: 'deferred' | 'failed'): void }> = [];
  const coordinator = { hasBackgroundWork: false, cancel: jest.fn(), dispose: async () => undefined } as unknown as ChatExecutionCoordinator;
  const runtime = new ChatSessionRuntime({ conversationId: 'target', providerId: 'claude', draftModel: null }, coordinator, session => {
    const model = createSessionModelStub(session);
    model.hydrate = () => hydrate.promise;
    Object.assign(model.inputController, {
      sendSessionMessage: (entry: SessionMessage, options: typeof callbacks[number]) => runtime.turns.run(async () => {
        callbacks.push(options);
        options.assertBeforeHandoff();
        sent.push(entry.text);
        const done = deferred<void>();
        completions.push(done);
        await done.promise;
      }),
    });
    Object.defineProperty(model.inputController, 'canStartSessionMessage', { get: () => !userQueued && !runtime.turns.isActive });
    return model;
  });
  const discarded = jest.fn();
  const mailbox = new SessionMailbox({ runtime, isTargetAvailable: () => available, onDiscard: discarded });
  runtime.installMailbox(mailbox);
  return { runtime, mailbox, hydrate, sent, completions, callbacks, discarded,
    setAvailable: (value: boolean) => { available = value; },
    setUserQueued: (value: boolean) => { userQueued = value; runtime.notifyChanged(); },
  };
}

describe('session mailbox lifetime and dispatch', () => {
  it('hydrates headlessly once and delivers FIFO with user work taking precedence', async () => {
    const h = setup();
    expect(h.mailbox.admit(message('first'))).toBe('started');
    expect(h.mailbox.admit(message('second'))).toBe('queued');
    expect(h.runtime.isIdle).toBe(false);
    expect(h.runtime.isWorking).toBe(false);
    h.setUserQueued(true);
    h.hydrate.resolve();
    await flush();
    expect(h.sent).toEqual([]);
    h.setUserQueued(false);
    await flush();
    expect(h.sent).toEqual(['first']);
    h.completions[0].resolve();
    await flush();
    expect(h.sent).toEqual(['first', 'second']);
    h.completions[1].resolve();
    await flush();
    expect(h.runtime.isIdle).toBe(true);
    await h.runtime.dispose();
  });

  it.each(['stop', 'shutdown', 'archived'] as const)('fences pending hydration after %s', async action => {
    const h = setup();
    h.mailbox.admit(message('pending'));
    if (action === 'stop') h.runtime.cancelTurn('user');
    else if (action === 'shutdown') h.runtime.beginShutdown();
    else { h.setAvailable(false); h.runtime.notifyChanged(); }
    h.hydrate.resolve();
    await flush();
    expect(h.sent).toEqual([]);
    expect(h.mailbox.hasPending).toBe(false);
    expect(h.discarded).toHaveBeenCalledWith([message('pending')]);
    await h.runtime.dispose();
  });

  it('discards terminal hydration failure instead of retrying it', async () => {
    const h = setup();
    h.mailbox.admit(message('failed'));
    h.hydrate.reject(new Error('Provider initialization failed'));
    await flush();
    expect(h.discarded).toHaveBeenCalledWith([message('failed')]);
    expect(h.sent).toEqual([]);
    expect(h.mailbox.hasPending).toBe(false);
    expect(h.runtime.isIdle).toBe(true);
    await h.runtime.dispose();
  });

  it('discards a terminal unsent turn and advances to the next entry once', async () => {
    const h = setup();
    h.hydrate.resolve();
    h.mailbox.admit(message('failed'));
    h.mailbox.admit(message('next'));
    await flush();
    h.callbacks[0].onUnsent('failed');
    h.completions[0].resolve();
    await flush();
    expect(h.sent).toEqual(['failed', 'next']);
    expect(h.discarded).toHaveBeenCalledWith([message('failed')]);
    h.completions[1].resolve();
    await flush();
    await h.runtime.dispose();
  });

  it('rechecks eligibility when competing work settles before a deferred attempt unwinds', async () => {
    const h = setup();
    h.hydrate.resolve();
    h.mailbox.admit(message('first'));
    await flush();
    h.setUserQueued(true);
    h.callbacks[0].onUnsent('deferred');
    h.setUserQueued(false);
    h.completions[0].resolve();
    await flush();
    expect(h.sent).toEqual(['first', 'first']);
    expect(h.discarded).not.toHaveBeenCalled();
    h.completions[1].resolve();
    await flush();
    expect(h.mailbox.hasPending).toBe(false);
    await h.runtime.dispose();
  });

  it('does not resurrect a deferred return after Stop clears its generation', async () => {
    const h = setup();
    h.hydrate.resolve();
    h.mailbox.admit(message('first'));
    await flush();
    h.mailbox.admit(message('second'));
    h.runtime.cancelTurn('user');
    h.callbacks[0].onUnsent('deferred');
    h.completions[0].resolve();
    await flush();
    expect(h.sent).toEqual(['first']);
    expect(h.mailbox.hasPending).toBe(false);
    await h.runtime.dispose();
  });

  it('delivers an interrupt first when an older dispatch is still hydrating', async () => {
    const h = setup();
    expect(h.mailbox.admit(message('older'))).toBe('started');
    const interrupt = h.mailbox.reserve(message('interrupt'), { first: true });
    interrupt.commit();
    interrupt.publish();
    h.hydrate.resolve();
    await flush();
    expect(h.sent).toEqual(['interrupt']);
    h.completions[0].resolve();
    await flush();
    expect(h.sent).toEqual(['interrupt', 'older']);
    h.completions[1].resolve();
    await flush();
    await h.runtime.dispose();
  });

  it('lets nothing overtake a held interrupt while its switch commits', async () => {
    const h = setup();
    h.mailbox.admit(message('older'));
    const interrupt = h.mailbox.reserve(message('interrupt'), { first: true });
    h.hydrate.resolve();
    await flush();
    expect(h.sent).toEqual([]);
    interrupt.commit();
    interrupt.publish();
    await flush();
    expect(h.sent).toEqual(['interrupt']);
    h.completions[0].resolve();
    await flush();
    expect(h.sent).toEqual(['interrupt', 'older']);
    h.completions[1].resolve();
    await flush();
    await h.runtime.dispose();
  });

  it('returns a deferred older entry behind an interrupt admitted meanwhile', async () => {
    const h = setup();
    h.hydrate.resolve();
    h.mailbox.admit(message('older'));
    await flush();
    const interrupt = h.mailbox.reserve(message('interrupt'), { first: true });
    interrupt.commit();
    h.callbacks[0].onUnsent('deferred');
    h.completions[0].resolve();
    await flush();
    expect(h.sent).toEqual(['older', 'interrupt']);
    h.completions[1].resolve();
    await flush();
    expect(h.sent).toEqual(['older', 'interrupt', 'older']);
    h.completions[2].resolve();
    await flush();
    await h.runtime.dispose();
  });

  it('keeps a deferred newer interrupt ahead of older ones, behind interrupts admitted during its attempt', async () => {
    const h = setup();
    h.hydrate.resolve();
    h.mailbox.admit(message('running'));
    await flush();
    for (const text of ['old interrupt', 'new interrupt']) {
      const reservation = h.mailbox.reserve(message(text), { first: true });
      reservation.commit();
    }
    h.completions[0].resolve();
    await flush();
    expect(h.sent).toEqual(['running', 'new interrupt']);
    const newest = h.mailbox.reserve(message('newest interrupt'), { first: true });
    newest.commit();
    h.callbacks[1].onUnsent('deferred');
    h.completions[1].resolve();
    await flush();
    for (const index of [2, 3, 4]) {
      h.completions[index].resolve();
      await flush();
    }
    expect(h.sent).toEqual(['running', 'new interrupt', 'newest interrupt', 'new interrupt', 'old interrupt']);
    await h.runtime.dispose();
  });
});
