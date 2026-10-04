import {
  type ProviderExecutionEvent,
  RequestedRunChannel,
} from '@/core/execution';

async function collect(events: AsyncIterable<ProviderExecutionEvent>): Promise<ProviderExecutionEvent[]> {
  const collected: ProviderExecutionEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function createChannel(onCancel = jest.fn()) {
  return {
    onCancel,
    run: new RequestedRunChannel({ onCancel, sessionInstanceId: 'session-1' }),
  };
}

describe('RequestedRunChannel', () => {
  it('sequences immutable requested scopes and terminates exactly once', async () => {
    const { run } = createChannel();

    run.emit({ accepted: true, type: 'turn_started' });
    run.emit({ text: 'hello', type: 'text_delta' });
    run.finish({ reason: 'completed', type: 'turn_completed' });
    const late = run.emit({ text: 'late', type: 'text_delta' });
    const secondTerminal = run.finish({ reason: 'Cancelled', type: 'cancelled' });
    const events = await collect(run.events);

    expect(late).toBeNull();
    expect(secondTerminal).toBeNull();
    expect(run.isTerminal).toBe(true);
    expect(events.map(event => event.type)).toEqual(['turn_started', 'text_delta', 'turn_completed']);
    expect(events.map(event => event.scope)).toEqual([1, 2, 3].map(sequence => ({
      executionId: run.executionId,
      kind: 'requested',
      sequence,
      sessionInstanceId: 'session-1',
      turnId: run.turnId,
    })));
    expect(events.every(event => Object.isFrozen(event.scope))).toBe(true);
    await expect(run.terminated).resolves.toBeUndefined();
  });

  it('requests cancellation once and never after termination', () => {
    const { onCancel, run } = createChannel();

    run.cancel();
    run.cancel();
    expect(onCancel.mock.calls).toEqual([['consumer']]);
    expect(run.isCancellationRequested).toBe(true);

    const finished = createChannel();
    finished.run.finish({ reason: 'completed', type: 'turn_completed' });
    finished.run.cancel();
    expect(finished.onCancel).not.toHaveBeenCalled();
  });

  it('cancels when the consumer stops before the terminal event, but not after it', async () => {
    const open = createChannel();
    open.run.emit({ text: 'partial', type: 'text_delta' });
    for await (const event of open.run.events) {
      expect(event.type).toBe('text_delta');
      break;
    }
    expect(open.onCancel).toHaveBeenCalledWith('consumer');

    const terminal = createChannel();
    terminal.run.finish({ reason: 'completed', type: 'turn_completed' });
    for await (const event of terminal.run.events) {
      expect(event.type).toBe('turn_completed');
      break;
    }
    expect(terminal.onCancel).not.toHaveBeenCalled();
  });

  it('cancels from an already-aborted or later-aborted request signal until termination', () => {
    const preAborted = createChannel();
    const aborted = new AbortController();
    aborted.abort();
    preAborted.run.attachAbortSignal(aborted.signal);
    expect(preAborted.onCancel.mock.calls).toEqual([['abort-signal']]);

    const live = createChannel();
    const controller = new AbortController();
    live.run.attachAbortSignal(controller.signal);
    controller.abort();
    expect(live.onCancel.mock.calls).toEqual([['abort-signal']]);

    const detached = createChannel();
    const lateController = new AbortController();
    detached.run.attachAbortSignal(lateController.signal);
    detached.run.finish({ reason: 'completed', type: 'turn_completed' });
    lateController.abort();
    expect(detached.onCancel).not.toHaveBeenCalled();
  });

  it('closes a control stream without a terminal event', async () => {
    const { onCancel, run } = createChannel();
    const controller = new AbortController();
    run.attachAbortSignal(controller.signal);

    run.emit({ text: 'internal', type: 'text_delta' });
    run.close();
    controller.abort();

    await expect(collect(run.events)).resolves.toEqual([
      expect.objectContaining({ type: 'text_delta' }),
    ]);
    expect(run.isTerminal).toBe(true);
    expect(onCancel).not.toHaveBeenCalled();
    await expect(run.terminated).resolves.toBeUndefined();
  });
});
