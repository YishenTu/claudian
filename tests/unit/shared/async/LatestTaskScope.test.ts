import { LatestTaskScope } from '@/shared/async/LatestTaskScope';

describe('LatestTaskScope', () => {
  it('aborts and invalidates the preceding task when replaced', () => {
    const scope = new LatestTaskScope();
    const first = scope.start();

    const second = scope.start();

    expect(first.signal.aborted).toBe(true);
    expect(first.isCurrent()).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });

  it('does not let stale completion clear the current task', () => {
    const scope = new LatestTaskScope();
    const first = scope.start();
    const second = scope.start();

    expect(first.complete()).toBe(false);
    expect(scope.active).toBe(true);
    expect(second.isCurrent()).toBe(true);
  });

  it('clears only the current task on completion', () => {
    const scope = new LatestTaskScope();
    const task = scope.start();

    expect(task.complete()).toBe(true);
    expect(task.isCurrent()).toBe(false);
    expect(scope.active).toBe(false);
    expect(task.complete()).toBe(false);
  });

  it('keeps separate scopes independent', () => {
    const snapshotScope = new LatestTaskScope();
    const fileScope = new LatestTaskScope();
    const snapshot = snapshotScope.start();
    const file = fileScope.start();

    snapshotScope.cancel();

    expect(snapshot.signal.aborted).toBe(true);
    expect(file.signal.aborted).toBe(false);
    expect(file.isCurrent()).toBe(true);
  });

  it('permanently closes the scope', () => {
    const scope = new LatestTaskScope();
    const task = scope.start();

    scope.close();

    expect(task.signal.aborted).toBe(true);
    expect(task.isCurrent()).toBe(false);
    expect(scope.active).toBe(false);
    expect(() => scope.start()).toThrow('LatestTaskScope is closed');
  });
});
