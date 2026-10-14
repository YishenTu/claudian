import type { ProviderExecutionConfiguration } from '@/core/execution';

/** Settings come from the destination that displays and submits them. */
export function buildChatExecutionConfiguration(
  settings: Pick<ProviderExecutionConfiguration, 'model' | 'reasoning' | 'permissionMode' | 'serviceTier'>,
): ProviderExecutionConfiguration {
  return {
    model: settings.model,
    reasoning: settings.reasoning,
    permissionMode: settings.permissionMode,
    serviceTier: settings.serviceTier,
    systemInstructions: { kind: 'provider-default' },
  };
}
