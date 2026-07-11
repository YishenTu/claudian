import { RuntimeSupervisor } from '@/app/runtime/RuntimeSupervisor';
import type { ChatRuntime } from '@/core/runtime/ChatRuntime';

function createRuntime(id: string, trace: string[]): ChatRuntime {
  return {
    cleanup: () => { trace.push(`${id}:cleanup`); },
  } as unknown as ChatRuntime;
}

describe('RuntimeSupervisor', () => {
  it('delegates readiness, query, cancellation, reset, and callbacks in order', async () => {
    const trace: string[] = [];
    const runtime = {
      providerId: 'codex',
      ensureReady: jest.fn(async () => {
        trace.push('ready');
        return true;
      }),
      query: jest.fn(() => (async function* () {
        trace.push('query');
        yield { type: 'text', content: 'ok' };
      })()),
      cancel: jest.fn(() => { trace.push('cancel'); }),
      resetSession: jest.fn(() => { trace.push('reset'); }),
      setApprovalCallback: jest.fn(() => { trace.push('approval'); }),
      cleanup: jest.fn(() => { trace.push('cleanup'); }),
    } as unknown as ChatRuntime;
    const supervisor = new RuntimeSupervisor(runtime);

    await expect(supervisor.ensureReady()).resolves.toBe(true);
    const chunks = [];
    for await (const chunk of supervisor.query({} as never)) {
      chunks.push(chunk);
    }
    supervisor.cancel();
    supervisor.resetSession();
    supervisor.setApprovalCallback(null);
    supervisor.cleanup();

    expect(chunks).toEqual([{ type: 'text', content: 'ok' }]);
    expect(trace).toEqual(['ready', 'query', 'cancel', 'reset', 'approval', 'cleanup']);
  });

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
});
