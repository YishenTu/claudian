import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

export interface SubagentHookState {
  hasRunning: boolean;
}

const STOP_BLOCK_REASON = 'Background subagents are still running. Use `TaskOutput task_id="..." block=true` to wait for their results before ending your turn.';

export function createStopSubagentHook(
  getState: () => SubagentHookState
): HookCallbackMatcher {
  return {
    hooks: [
      async () => {
        let state: SubagentHookState;
        try {
          state = getState();
        } catch {
          return {
            decision: 'block' as const,
            reason: STOP_BLOCK_REASON,
          };
        }

        if (state.hasRunning) {
          return {
            decision: 'block' as const,
            reason: STOP_BLOCK_REASON,
          };
        }

        return {};
      },
    ],
  };
}
