import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

import type { SubagentRuntimeState } from '../../../core/runtime/types';

export type SubagentHookState = SubagentRuntimeState;

const STOP_BLOCK_REASON = 'Background subagents are still running. Use `TaskOutput task_id="..." block=true` to wait for their results before ending your turn.';

/**
 * Maximum number of consecutive Stop blocks before the hook lets the turn end
 * anyway. Acts as a safety net against stale subagent tracking state (e.g. a
 * background subagent that was killed/stalled without its termination path
 * running) which would otherwise block turn-ends forever.
 */
export const MAX_CONSECUTIVE_STOP_BLOCKS = 3;

export function createStopSubagentHook(
  getState: () => SubagentHookState
): HookCallbackMatcher {
  // Counts consecutive blocks. Reset whenever the state reports no running
  // subagents (i.e. the block mechanism worked as intended).
  let consecutiveBlocks = 0;

  return {
    hooks: [
      async () => {
        let hasRunning: boolean;
        let stateCheckFailed = false;
        try {
          const state = getState();
          if (typeof state?.hasRunning === 'boolean') {
            hasRunning = state.hasRunning;
          } else {
            // Provider returned an unexpected shape — treat like a failed
            // state check: fail closed, bounded by the retry cap below.
            console.warn('[Claudian] Stop hook received invalid subagent state shape:', state);
            hasRunning = true;
            stateCheckFailed = true;
          }
        } catch (err) {
          // Provider failed — assume subagents are running to be safe.
          // The retry cap below guarantees this can never block forever.
          console.warn('[Claudian] Stop hook subagent state check failed:', err);
          hasRunning = true;
          stateCheckFailed = true;
        }

        if (!hasRunning) {
          consecutiveBlocks = 0;
          return {};
        }

        if (consecutiveBlocks >= MAX_CONSECUTIVE_STOP_BLOCKS) {
          console.warn(
            `[Claudian] Stop hook still reports running subagents after ${consecutiveBlocks} consecutive blocks`
            + `${stateCheckFailed ? ' (subagent state check failed)' : ''}`
            + ' — allowing the turn to end to avoid an infinite block loop.'
            + ' Subagent tracking state may be stale (killed/stalled background task).'
          );
          consecutiveBlocks = 0;
          return {};
        }

        consecutiveBlocks++;
        return { decision: 'block' as const, reason: STOP_BLOCK_REASON };
      },
    ],
  };
}
