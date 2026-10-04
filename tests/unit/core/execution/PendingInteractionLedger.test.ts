import { PendingInteractionLedger } from '@/core/execution';

function createLedger() {
  const port = { dismissInteraction: jest.fn() };
  return { ledger: new PendingInteractionLedger(port), port };
}

describe('PendingInteractionLedger', () => {
  it('rejects a duplicate pending identity and settles each interaction once', () => {
    const { ledger, port } = createLedger();

    const pending = ledger.begin('interaction-1');
    expect(ledger.begin('interaction-1')).toBeNull();

    expect(pending && ledger.settle(pending, 'resolved')).toBe(true);
    expect(pending && ledger.settle(pending, 'cancelled')).toBe(false);
    expect(port.dismissInteraction.mock.calls).toEqual([['interaction-1', 'resolved']]);
    expect(pending?.signal.aborted).toBe(false);
    expect(ledger.begin('interaction-1')).not.toBeNull();
  });

  it('dismisses and aborts every pending interaction once, making later responses stale', () => {
    const { ledger, port } = createLedger();
    const first = ledger.begin('interaction-1')!;
    const second = ledger.begin('interaction-2')!;

    ledger.dismissAll('cancelled');
    ledger.settle(first, 'resolved');
    ledger.dismissAll('session-disposed');

    expect(port.dismissInteraction.mock.calls).toEqual([
      ['interaction-1', 'cancelled'],
      ['interaction-2', 'cancelled'],
    ]);
    expect([first.signal.aborted, second.signal.aborted]).toEqual([true, true]);
    expect(ledger.isStaleResponse(first, { interactionId: 'interaction-1' })).toBe(true);
    expect(ledger.size).toBe(0);
  });

  it('distinguishes current, mismatched, and released responses', () => {
    const { ledger, port } = createLedger();
    const pending = ledger.begin('interaction-1')!;

    expect(ledger.isStaleResponse(pending, { interactionId: 'interaction-1' })).toBe(false);
    expect(ledger.isStaleResponse(pending, { interactionId: 'interaction-2' })).toBe(true);
    ledger.release(pending);

    expect(ledger.isStaleResponse(pending, { interactionId: 'interaction-1' })).toBe(true);
    expect(ledger.settle(pending, 'resolved')).toBe(false);
    expect(port.dismissInteraction).not.toHaveBeenCalled();
  });

  it('dismisses a caller-aborted interaction as cancelled and never registers a pre-aborted one', () => {
    const { ledger, port } = createLedger();
    const caller = new AbortController();
    const pending = ledger.begin('interaction-1', caller.signal)!;

    caller.abort();
    ledger.settle(pending, 'resolved');

    const preAborted = new AbortController();
    preAborted.abort();
    const never = ledger.begin('interaction-2', preAborted.signal)!;

    expect(port.dismissInteraction.mock.calls).toEqual([['interaction-1', 'cancelled']]);
    expect(pending.signal.aborted).toBe(true);
    expect(never.signal.aborted).toBe(true);
    expect(ledger.has('interaction-2')).toBe(false);
  });

  it('aborts a native-resolved interaction by identity', () => {
    const { ledger, port } = createLedger();
    const pending = ledger.begin('interaction-1')!;

    expect(ledger.abort('interaction-1', 'native-rejected')).toBe(true);
    expect(ledger.abort('interaction-1', 'native-rejected')).toBe(false);

    expect(port.dismissInteraction.mock.calls).toEqual([['interaction-1', 'native-rejected']]);
    expect(pending.signal.aborted).toBe(true);
  });
});
