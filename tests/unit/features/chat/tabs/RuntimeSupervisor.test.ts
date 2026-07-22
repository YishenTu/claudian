import type { ChatRuntime } from '@/core/runtime/ChatRuntime';
import { RuntimeSupervisor } from '@/features/chat/tabs/RuntimeSupervisor';

function createRuntime(id: string, trace: string[]): ChatRuntime {
  return {
    cleanup: () => { trace.push(`${id}:cleanup`); },
  } as unknown as ChatRuntime;
}

describe('RuntimeSupervisor', () => {
  it('owns replacement without introducing implicit cleanup semantics', () => {
    const trace: string[] = [];
    const first = createRuntime('first', trace);
    const second = createRuntime('second', trace);
    const supervisor = new RuntimeSupervisor(first);

    supervisor.setCurrent(second);

    expect(supervisor.current).toBe(second);
    expect(trace).toEqual([]);
  });

  it('keeps cleanup authoritative and clears the owned reference', () => {
    const trace: string[] = [];
    const runtime = createRuntime('runtime', trace);
    const supervisor = new RuntimeSupervisor(runtime);

    supervisor.cleanup();

    expect(trace).toEqual(['runtime:cleanup']);
    expect(supervisor.current).toBeNull();
  });

  it('keeps the runtime visible during cleanup and preserves it when cleanup throws', () => {
    const runtime = {
      cleanup: jest.fn(() => {
        expect(supervisor.current).toBe(runtime);
        throw new Error('cleanup failed');
      }),
    } as unknown as ChatRuntime;
    const supervisor = new RuntimeSupervisor(runtime);

    expect(() => supervisor.cleanup()).toThrow('cleanup failed');
    expect(supervisor.current).toBe(runtime);
  });

  it('marks an installed runtime stale only for a newer resource generation', () => {
    const runtime = createRuntime('runtime', []);
    const supervisor = new RuntimeSupervisor();

    supervisor.setCurrent(runtime, 3);
    supervisor.invalidate(3);
    expect(supervisor.isInvalidated).toBe(false);

    supervisor.invalidate(4);
    expect(supervisor.isInvalidated).toBe(true);
    expect(supervisor.current).toBe(runtime);
  });

  it('clears invalidation only when a replacement is installed for the current generation', () => {
    const first = createRuntime('first', []);
    const second = createRuntime('second', []);
    const supervisor = new RuntimeSupervisor(first, 1);

    supervisor.invalidate(5);
    supervisor.setCurrent(second, 4);
    expect(supervisor.isInvalidated).toBe(true);

    supervisor.setCurrent(second, 5);
    expect(supervisor.isInvalidated).toBe(false);
  });
});
