import { testDate } from '@test/helpers/testClock';

import { ConversationNamingAPIHost } from '@/app/integration/ConversationNamingAPIHost';

describe('ConversationNamingAPIHost', () => {
  function createHost() {
    return new ConversationNamingAPIHost({
      getActiveConversationId: () => 'one',
      getSnapshot: () => ({ conversationId: 'one', createdAt: testDate().getTime(), longTitle: 'Before', shortTitle: null }),
      listSnapshots: () => [],
      getFirstUserText: async () => null,
      updateTitles: async () => ({ longTitle: true, shortTitle: false }),
      setGenerationStatus: async () => true,
      runTextTask: async () => 'generated',
    });
  }

  it('delivers only the first accepted input and stops delivery after unsubscribe', () => {
    const host = createHost();
    const inputs: string[] = [];
    const off = host.subscribeFirstTurn(event => { inputs.push(event.visibleUserText); });
    expect(host.notifyFirstTurnAccepted({ conversationId: 'one', visibleUserText: 'Fix labels' })).toBe(true);
    host.notifyFirstTurnAccepted({ conversationId: 'one', visibleUserText: 'Duplicate delivery' });
    off();
    expect(host.notifyFirstTurnAccepted({ conversationId: 'two', visibleUserText: 'No listener' })).toBe(false);
    expect(inputs).toEqual(['Fix labels']);
  });

  it('rejects duplicate naming owners and preserves the original subscriber', () => {
    const host = createHost();
    const inputs: string[] = [];
    host.subscribeFirstTurn(event => { inputs.push(event.visibleUserText); });
    expect(() => host.subscribeFirstTurn(() => undefined)).toThrow(/subscriber/);
    host.notifyFirstTurnAccepted({ conversationId: 'one', visibleUserText: 'Original' });
    expect(inputs).toEqual(['Original']);
  });

  it('becomes unavailable on disposal without exposing mutable state', async () => {
    const host = createHost();
    expect(host.version).toBe(1);
    host.dispose();
    expect(host.getConversationSnapshot('one')).toBeNull();
    expect(host.listConversationSnapshots()).toEqual([]);
    expect(await host.updateTitles('one', { longTitle: 'After' })).toEqual({ longTitle: false, shortTitle: false });
    await expect(host.runAuxiliaryTextTask({ prompt: 'input', systemPrompt: 'name' })).rejects.toThrow(/unavailable/);
  });
});
