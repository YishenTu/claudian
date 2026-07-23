import {
  buildPersistedQoderProviderState,
  parseQoderProviderState,
} from '@/providers/qoder/types';

describe('Qoder provider state', () => {
  it('trims and retains only recognized session fields', () => {
    expect(parseQoderProviderState({
      checkpointUserMessageIds: ['msg-1', '  ', 42],
      forkSource: { resumeAt: ' assistant-1 ', sessionId: ' source ' },
      lastKnownTitle: ' My session ',
      sessionId: ' session-id ',
      token: 'do-not-preserve',
    })).toEqual({
      checkpointUserMessageIds: ['msg-1'],
      forkSource: { resumeAt: 'assistant-1', sessionId: 'source' },
      lastKnownTitle: 'My session',
      sessionId: 'session-id',
    });
  });

  it('drops incomplete fork sources and non-object input', () => {
    expect(parseQoderProviderState({
      forkSource: { resumeAt: '', sessionId: 'source' },
    })).toEqual({});
    expect(parseQoderProviderState(null)).toEqual({});
    expect(parseQoderProviderState('nope')).toEqual({});
  });

  it('normalizes discovery snapshots to known command, agent, and skill shapes', () => {
    expect(parseQoderProviderState({
      discovery: {
        agents: [{ name: 'reviewer' }, { noName: true }],
        commands: [
          { description: 'Review', name: '/review' },
          { name: 'missing-description' },
        ],
        plugins: [{ name: 'plug' }],
        skills: ['skill-a', '  '],
      },
    })).toEqual({
      discovery: {
        agents: [{ name: 'reviewer' }],
        commands: [{ description: 'Review', name: '/review' }],
        plugins: [{ name: 'plug' }],
        skills: ['skill-a'],
      },
    });
  });

  it('builds persisted state only when at least one field survives parsing', () => {
    expect(buildPersistedQoderProviderState({ sessionId: 'session-id' })).toEqual({
      sessionId: 'session-id',
    });
    expect(buildPersistedQoderProviderState({})).toBeUndefined();
  });
});
