import type { ProviderExecutionEvent, ProviderExecutionRun } from '@/core/execution';
import { withExecutionUsageModel } from '@/features/chat/execution/usageModel';

type ExecutionTerminalEvent = Extract<ProviderExecutionEvent, { type: 'turn_completed' | 'cancelled' | 'execution_error' }>;

export function isExecutionTerminalEvent(event: ProviderExecutionEvent): event is ExecutionTerminalEvent {
  return event.type === 'turn_completed' || event.type === 'cancelled' || event.type === 'execution_error';
}

/** Deliver one run in order, stopping before stale or post-terminal output can escape. */
export async function consumeExecutionEvents(
  run: ProviderExecutionRun,
  sessionInstanceId: string,
  model: string | undefined,
  isCurrent: () => boolean,
  consume: (event: ProviderExecutionEvent) => Promise<void>,
): Promise<ExecutionTerminalEvent | undefined> {
  let sequence = 0;
  for await (const event of run.events) {
    if (!isCurrent()) break;
    if (event.scope.sessionInstanceId !== sessionInstanceId || event.scope.executionId !== run.executionId
      || event.scope.turnId !== run.turnId || event.scope.sequence <= sequence) continue;
    sequence = event.scope.sequence;
    await consume(withExecutionUsageModel(event, model));
    if (isExecutionTerminalEvent(event)) return event;
  }
}
