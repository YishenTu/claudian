import {
  createStopSubagentHook,
  MAX_CONSECUTIVE_STOP_BLOCKS,
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

    it('fails closed and logs the error when reading subagent state throws', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const error = new Error('tab already torn down');
        const hook = createStopSubagentHook(() => {
          throw error;
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
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('state check failed'),
          error
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('fails closed and logs when subagent state has an invalid shape', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const hook = createStopSubagentHook(() => ({ hasRunning: 'yes' }) as any);
        const opts = { signal: new AbortController().signal };

        const result = await hook.hooks[0](createHookInput(), undefined, opts);

        expect(result).toEqual({
          decision: 'block',
          reason: expect.stringContaining('still running'),
        });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('invalid subagent state shape'),
          { hasRunning: 'yes' }
        );

        // Invalid shape is bounded by the same cap
        for (let i = 1; i < MAX_CONSECUTIVE_STOP_BLOCKS; i++) {
          const blocked = await hook.hooks[0](createHookInput(), undefined, opts);
          expect((blocked as any).decision).toBe('block');
        }
        expect(await hook.hooks[0](createHookInput(), undefined, opts)).toEqual({});
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('fails closed and logs when subagent state is null/undefined', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const hook = createStopSubagentHook(() => null as any);

        const result = await hook.hooks[0](
          createHookInput(),
          undefined,
          { signal: new AbortController().signal }
        );

        expect(result).toEqual({
          decision: 'block',
          reason: expect.stringContaining('still running'),
        });
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining('invalid subagent state shape'),
          null
        );
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('stops blocking after the consecutive block cap when state stays running (stale tracking)', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const hook = createStopSubagentHook(() => ({ hasRunning: true }));
        const opts = { signal: new AbortController().signal };

        for (let i = 0; i < MAX_CONSECUTIVE_STOP_BLOCKS; i++) {
          const result = await hook.hooks[0](createHookInput(), undefined, opts);
          expect((result as any).decision).toBe('block');
        }

        // Cap reached — turn must be allowed to end despite hasRunning=true
        const released = await hook.hooks[0](createHookInput(), undefined, opts);
        expect(released).toEqual({});
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('stops blocking after the consecutive block cap when state check keeps throwing', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const hook = createStopSubagentHook(() => {
          throw new Error('provider gone');
        });
        const opts = { signal: new AbortController().signal };

        for (let i = 0; i < MAX_CONSECUTIVE_STOP_BLOCKS; i++) {
          const result = await hook.hooks[0](createHookInput(), undefined, opts);
          expect((result as any).decision).toBe('block');
        }

        const released = await hook.hooks[0](createHookInput(), undefined, opts);
        expect(released).toEqual({});
        expect(warnSpy).toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('resets the block counter once subagents finish, re-arming the cap', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        let running = true;
        const hook = createStopSubagentHook(() => ({ hasRunning: running }));
        const opts = { signal: new AbortController().signal };

        // Two blocks, then subagents finish
        await hook.hooks[0](createHookInput(), undefined, opts);
        await hook.hooks[0](createHookInput(), undefined, opts);
        running = false;
        expect(await hook.hooks[0](createHookInput(), undefined, opts)).toEqual({});

        // New running phase gets the full cap again
        running = true;
        for (let i = 0; i < MAX_CONSECUTIVE_STOP_BLOCKS; i++) {
          const result = await hook.hooks[0](createHookInput(), undefined, opts);
          expect((result as any).decision).toBe('block');
        }
        expect(await hook.hooks[0](createHookInput(), undefined, opts)).toEqual({});
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('has no matcher (applies to all stop events)', () => {
      const hook = createStopSubagentHook(
        () => ({ hasRunning: false })
      );
      expect(hook.matcher).toBeUndefined();
    });
  });
});
