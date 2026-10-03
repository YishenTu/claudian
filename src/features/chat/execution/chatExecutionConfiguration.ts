import type { ProviderExecutionConfiguration, ProviderSystemInstructions } from '@/core/execution';

import type { ChatFeatureHost } from '../ChatFeatureHost';

export async function resolveChatDynamicSections(
  host: Pick<ChatFeatureHost, 'getMainAgentDynamicSystemPromptSections'>,
): Promise<readonly string[]> {
  try {
    return await host.getMainAgentDynamicSystemPromptSections?.() ?? [];
  } catch {
    return [];
  }
}

export function buildChatSystemInstructions(dynamicSections: readonly string[]): ProviderSystemInstructions {
  return { kind: 'provider-default', ...(dynamicSections.length ? { dynamicSections: [...dynamicSections] } : {}) };
}

/** Settings come from the destination that displays and submits them. */
export function buildChatExecutionConfiguration(
  settings: Pick<ProviderExecutionConfiguration, 'model' | 'reasoning' | 'permissionMode' | 'serviceTier'>,
  snapshotDirectory: string,
  dynamicSections: readonly string[] = [],
): ProviderExecutionConfiguration {
  return {
    model: settings.model,
    reasoning: settings.reasoning,
    permissionMode: settings.permissionMode,
    serviceTier: settings.serviceTier,
    readableRoots: [snapshotDirectory],
    systemInstructions: buildChatSystemInstructions(dynamicSections),
  };
}
