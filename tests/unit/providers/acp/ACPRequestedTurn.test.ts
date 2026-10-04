import { type ProviderExecutionEvent, RequestedRunChannel } from '@/core/execution';
import { ACPRequestedTurn, type ACPRequestedTurnOptions } from '@/providers/acp';

function createTurn(options: Partial<Omit<ACPRequestedTurnOptions, 'run'>> = {}) {
  const run = new RequestedRunChannel({ onCancel: jest.fn(), sessionInstanceId: 'session-1' });
  const turn = new ACPRequestedTurn({ ...options, run });
  return { run, turn };
}

async function finishAndCollect(run: RequestedRunChannel): Promise<ProviderExecutionEvent[]> {
  run.finish({ reason: 'completed', type: 'turn_completed' });
  const events: ProviderExecutionEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

const textChunk = (text: string) => ({
  content: { text, type: 'text' },
  sessionUpdate: 'agent_message_chunk',
});

describe('ACPRequestedTurn', () => {
  it('returns session metadata to the provider without accepting the turn', async () => {
    const { run, turn } = createTurn();
    turn.beginLiveOutput();

    const metadata = turn.handleUpdate({
      availableCommands: [{ description: 'Compact', name: 'compact' }],
      sessionUpdate: 'available_commands_update',
    });

    expect(metadata).toMatchObject({ type: 'commands' });
    expect(turn.accepted).toBe(false);
    expect((await finishAndCollect(run)).map(event => event.type)).toEqual(['turn_completed']);
  });

  it('drops replayed output before the live prompt, then accepts once and re-sequences live events', async () => {
    const onAccept = jest.fn();
    const { run, turn } = createTurn({ onAccept });

    turn.handleUpdate(textChunk('replayed history'));
    turn.beginLiveOutput();
    turn.handleUpdate(textChunk('first'));
    turn.handleUpdate(textChunk(' second'));
    turn.accept('native-user');
    const events = await finishAndCollect(run);

    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(events.map(event => [event.type, event.scope.sequence])).toEqual([
      ['turn_started', 1],
      ['assistant_message_started', 2],
      ['text_delta', 3],
      ['text_delta', 4],
      ['turn_completed', 5],
    ]);
    expect(events.filter(event => event.type === 'text_delta')).toEqual([
      expect.objectContaining({ text: 'first' }),
      expect.objectContaining({ text: ' second' }),
    ]);
    expect(events[0]).not.toHaveProperty('nativeUserMessageId');
  });

  it.each([
    [false, ['turn_completed']],
    [true, ['turn_started', 'turn_completed']],
  ])('treats a live update without events as acceptance only when configured (%s)', async (acceptsSilentUpdates, types) => {
    const { run, turn } = createTurn({ acceptsSilentUpdates });
    turn.beginLiveOutput();

    turn.handleUpdate({ entries: [], sessionUpdate: 'plan' });

    expect((await finishAndCollect(run)).map(event => event.type)).toEqual(types);
  });

  it('records context usage only while live output is accepted', () => {
    const { turn } = createTurn({ resolveUsageModel: () => 'model-1' });

    turn.handleUpdate({ sessionUpdate: 'usage_update', size: 1000, used: 10 });
    expect(turn.contextUsage).toBeNull();

    turn.beginLiveOutput();
    turn.handleUpdate({ sessionUpdate: 'usage_update', size: 1000, used: 250 });
    turn.endLiveOutput();
    turn.handleUpdate({ sessionUpdate: 'usage_update', size: 1000, used: 400 });

    expect(turn.contextUsage).toMatchObject({ size: 1000, used: 250 });
  });
});
