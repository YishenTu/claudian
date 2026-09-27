import type { ProviderExecutionEvent, ProviderSessionEvent } from '@/core/execution';

/** Attribute omitted usage identity to the originating execution, preserving native evidence. */
export function withExecutionUsageModel<T extends ProviderExecutionEvent | ProviderSessionEvent>(
  event: T,
  model: string | undefined,
): T {
  return event.type === 'usage_updated' && !event.usage.model && model
    ? { ...event, usage: { ...event.usage, model } }
    : event;
}
