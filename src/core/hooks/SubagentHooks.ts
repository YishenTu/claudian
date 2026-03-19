import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

export interface SubagentHookState {
  hasRunning: boolean;
}

export function createStopSubagentHook(
  getState: () => SubagentHookState
): HookCallbackMatcher {
  return {
    hooks: [
      async () => {
        const state = getState();

        if (state.hasRunning) {
          return {
            decision: 'block' as const,
            reason: 'Background subagents are still running. Use `TaskOutput task_id="..." block=true` to wait for their results before ending your turn.',
          };
        }

        return {};
      },
    ],
  };
}
