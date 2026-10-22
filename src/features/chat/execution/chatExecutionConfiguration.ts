import type { ProviderExecutionConfiguration } from '@/core/execution';

/**
 * Settings come from the destination that displays and submits them. `sessionInstructions` rides on the
 * provider-default prompt only.
 */
export function buildChatExecutionConfiguration(
  settings: Pick<ProviderExecutionConfiguration, 'model' | 'reasoning' | 'permissionMode' | 'serviceTier'>,
  sessionInstructions?: string,
): ProviderExecutionConfiguration {
  return {
    model: settings.model,
    reasoning: settings.reasoning,
    permissionMode: settings.permissionMode,
    serviceTier: settings.serviceTier,
    systemInstructions: {
      kind: 'provider-default',
      ...(sessionInstructions !== undefined ? { sessionInstructions } : {}),
    },
  };
}
