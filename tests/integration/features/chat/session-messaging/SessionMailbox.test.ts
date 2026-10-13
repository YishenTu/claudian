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
});
