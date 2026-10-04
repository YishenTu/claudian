import {
  type ProviderSessionEvent,
  SessionSnapshotState,
} from '@/core/execution';

describe('SessionSnapshotState', () => {
  it('advances one revision per status change and clears invalidation on recovery', () => {
    const state = new SessionSnapshotState({
      providerId: 'claude',
      readProviderSessionId: () => 'native-1',
      sessionInstanceId: 'session-1',
    });

    expect(state.getSnapshot()).toEqual({ providerId: 'claude', providerSessionId: 'native-1', revision: 0, status: 'idle' });
    state.setStatus('executing');
    state.invalidate({ message: 'gone', reason: 'process-exited', recoverable: true });
    const invalidated = state.getSnapshot();
    state.bumpRevision();
    state.setStatus('idle');

    expect(invalidated).toMatchObject({
      invalidation: { message: 'gone', reason: 'process-exited', recoverable: true },
      revision: 2,
      status: 'invalidated',
    });
    expect(state.getSnapshot()).toEqual({ providerId: 'claude', providerSessionId: 'native-1', revision: 4, status: 'idle' });
    expect(state.invalidation).toBeUndefined();
  });

  it('publishes immutable provider-state copies with recorded deletions', () => {
    const state = new SessionSnapshotState({
      providerId: 'pi',
      providerState: { cursor: { leafId: 'leaf-1' }, forkSource: { sessionId: 'source' } },
      readProviderSessionId: () => undefined,
      sessionInstanceId: 'session-1',
    });

    state.deleteProviderStateValue('forkSource');
    state.deleteProviderStateValue('stale');
    state.setProviderStateValue('stale', 'restored');
    const snapshot = state.getSnapshot();
    (state.providerState.cursor as { leafId: string }).leafId = 'leaf-2';

    expect(snapshot.providerState).toEqual({ cursor: { leafId: 'leaf-1' }, stale: 'restored' });
    expect(snapshot.providerStateDeletes).toEqual(['forkSource']);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.providerState)).toBe(true);
  });

  it('applies recorded deletions after projecting provider-owned fields', () => {
    const provider: { nativeVersion?: number } = {};
    const state = new SessionSnapshotState({
      providerId: 'opencode',
      providerState: { seeded: true },
      projectProviderState: stored => ({
        ...stored,
        ...(provider.nativeVersion ? { nativeVersion: provider.nativeVersion } : {}),
        pendingFork: 'target',
      }),
      readProviderSessionId: () => null,
      sessionInstanceId: 'session-1',
    });
    state.deleteProviderStateValue('pendingFork');
    provider.nativeVersion = 2;

    expect(state.getSnapshot().providerState).toEqual({ nativeVersion: 2, seeded: true });
  });

  it('delivers session events in increasing sequence despite failing listeners', () => {
    const state = new SessionSnapshotState({
      providerId: 'grok',
      readProviderSessionId: () => undefined,
      sessionInstanceId: 'session-1',
    });
    const received: ProviderSessionEvent[] = [];
    state.onEvent(() => {
      throw new Error('listener failure');
    });
    const unsubscribe = state.onEvent(event => received.push(event));

    state.emit({ type: 'commands_changed' });
    state.emit({ permissionMode: 'yolo', snapshot: state.getSnapshot(), type: 'permission_mode_changed' });
    unsubscribe();
    state.emit({ type: 'commands_changed' });

    expect(received.map(event => event.scope)).toEqual([1, 2].map(sequence => ({
      kind: 'session',
      sequence,
      sessionInstanceId: 'session-1',
    })));
  });
});
