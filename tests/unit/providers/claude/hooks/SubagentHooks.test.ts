import {
  createStopSubagentHook,
  type SubagentHookState,
} from '@/providers/claude/hooks/SubagentHooks';

describe('SubagentHooks', () => {
  describe('createStopSubagentHook', () => {
    const createHookInput = () => ({
      hook_event_name: 'Stop' as const,
      session_id: 'test-session',
      transcript_path: '/tmp/transcript',
      cwd: '/vault',
      stop_hook_active: true,
    });

    it('allows stop when no running subagents', async () => {
      const state: SubagentHookState = {
        hasRunning: false,
      };

      const hook = createStopSubagentHook(() => state);
      const result = await hook.hooks[0](createHookInput(), undefined, { signal: new AbortController().signal });

      expect(result).toEqual({});
    });

    it('blocks stop when subagents are still running', async () => {
      const state: SubagentHookState = {
        hasRunning: true,
      };

      const hook = createStopSubagentHook(() => state);
      const result = await hook.hooks[0](createHookInput(), undefined, { signal: new AbortController().signal });

      expect(result).toEqual({
        decision: 'block',
        reason: expect.stringContaining('still running'),
      });
      expect((result as any).reason).toContain('TaskOutput');
    });

    it('resolves state dynamically at execution time', async () => {
      let running = true;
      const getState = (): SubagentHookState => ({
        hasRunning: running,
      });

      const hook = createStopSubagentHook(getState);
      const opts = { signal: new AbortController().signal };

      const result1 = await hook.hooks[0](createHookInput(), undefined, opts);
      expect((result1 as any).decision).toBe('block');

      running = false;
      const result2 = await hook.hooks[0](createHookInput(), undefined, opts);
      expect(result2).toEqual({});
    });

    it('fails closed when reading subagent state throws', async () => {
      const hook = createStopSubagentHook(() => {
        throw new Error('tab already torn down');
      });

      const result = await hook.hooks[0](
        createHookInput(),
        undefined,
        { signal: new AbortController().signal }
      );

      expect(result).toEqual({
        decision: 'block',
        reason: expect.stringContaining('still running'),
      });
    });

    it('has no matcher (applies to all stop events)', () => {
      const hook = createStopSubagentHook(
        () => ({ hasRunning: false })
      );
      expect(hook.matcher).toBeUndefined();
    });
  });
});
