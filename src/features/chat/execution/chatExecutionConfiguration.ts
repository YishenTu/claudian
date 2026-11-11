import type { ProviderExecutionConfiguration, ProviderSystemInstructions } from '@/core/execution';
import { buildSystemPrompt } from '@/core/prompt/mainAgent';
import type { ClaudianSettings } from '@/core/types';
import type { FeatureHost } from '@/features/FeatureHost';

import type { ResolvedProjectInstructions } from './projectInstructions';

/** The host Vault root used for local filesystem operations and session configuration. */
export function getChatWorkingDirectory(host: Pick<FeatureHost, 'providerHost'>): string {
  return host.providerHost.workingDirectory ?? '.';
}

/**
 * The Main Agent prompt a chat destination sends, resolved by the shared core builder from current settings,
 * the execution-visible Vault working directory, and the session's own instructions (for example, a project paragraph).
 */
export function resolveChatSystemInstructions(
  settings: Pick<ClaudianSettings, 'mediaFolder' | 'systemPrompt' | 'userName'>,
  workingDirectory: string,
  project?: ResolvedProjectInstructions,
): ProviderSystemInstructions {
  return {
    kind: 'main-agent',
    ...(project ? { projectId: project.projectId } : {}),
    instructions: buildSystemPrompt({
      customPrompt: settings.systemPrompt,
      mediaFolder: settings.mediaFolder,
      userName: settings.userName,
      vaultPath: workingDirectory,
      sessionInstructions: project?.instructions,
    }),
  };
}

/** Settings come from the destination that displays and submits them. */
export function buildChatExecutionConfiguration(
  settings: Pick<ProviderExecutionConfiguration, 'model' | 'reasoning' | 'permissionMode' | 'serviceTier'>,
  systemInstructions: ProviderSystemInstructions,
): ProviderExecutionConfiguration {
  return {
    model: settings.model,
    reasoning: settings.reasoning,
    permissionMode: settings.permissionMode,
    serviceTier: settings.serviceTier,
    systemInstructions,
  };
}
