import { CursorAgentProcess } from '@/providers/cursor/runtime/CursorAgentProcess';
import type { CursorLaunchSpec } from '@/providers/cursor/runtime/CursorLaunchSpecBuilder';

const makeSpec = (overrides: Partial<CursorLaunchSpec> = {}): CursorLaunchSpec => ({
  command: '/bin/echo',
  args: ['hello'],
  env: process.env,
  spawnCwd: undefined,
  ...overrides,
});

describe('CursorAgentProcess', () => {
  it('throws when stdout is accessed before start()', () => {
    const proc = new CursorAgentProcess(makeSpec());
    expect(() => proc.stdout).toThrow('CursorAgentProcess not started');
  });

  it('throws when stderr is accessed before start()', () => {
    const proc = new CursorAgentProcess(makeSpec());
    expect(() => proc.stderr).toThrow('CursorAgentProcess not started');
  });

  it('exposes stdout and stderr after start() returns', () => {
    const proc = new CursorAgentProcess(makeSpec());
    proc.start();
    try {
      expect(proc.stdout).toBeDefined();
      expect(proc.stderr).toBeDefined();
      expect(proc.isAlive()).toBe(true);
    } finally {
      void proc.shutdown();
    }
  });

  it('isAlive becomes false after the process exits', async () => {
    const proc = new CursorAgentProcess(makeSpec({ command: '/bin/echo', args: ['ok'] }));
    proc.start();
    await new Promise<void>((resolve) => proc.onExit(() => resolve()));
    expect(proc.isAlive()).toBe(false);
  });

  it('invokes exit callbacks with code and signal', async () => {
    const proc = new CursorAgentProcess(makeSpec({ command: '/bin/echo', args: ['ok'] }));
    proc.start();
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      proc.onExit((code, signal) => resolve({ code, signal }));
    });
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
  });
});
