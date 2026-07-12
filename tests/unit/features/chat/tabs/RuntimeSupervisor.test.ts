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
});
