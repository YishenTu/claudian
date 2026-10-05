import type { ProviderExecutionConfiguration } from '@/core/execution';

/** Settings come from the destination that displays and submits them. */
export function buildChatExecutionConfiguration(
  settings: Pick<ProviderExecutionConfiguration, 'model' | 'reasoning' | 'permissionMode' | 'serviceTier'>,
  snapshotDirectory: string,
): ProviderExecutionConfiguration {
  return {
    model: settings.model,
    reasoning: settings.reasoning,
    permissionMode: settings.permissionMode,
    serviceTier: settings.serviceTier,
    readableRoots: [snapshotDirectory],
    systemInstructions: { kind: 'provider-default' },
  };
}
