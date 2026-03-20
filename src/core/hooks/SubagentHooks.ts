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
        let hasRunning: boolean;
        try {
          hasRunning = getState().hasRunning;
        } catch {
          // Provider failed — assume subagents are running to be safe
          hasRunning = true;
        }

        if (hasRunning) {
          return { decision: 'block' as const, reason: STOP_BLOCK_REASON };
        }

        return {};
      },
    ],
  };
}
