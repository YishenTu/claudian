import type { ProviderSystemInstructions } from '@/core/execution';
import { getInlineEditSystemPrompt } from '@/core/prompt/inlineEdit';
import { buildSystemPrompt, type SystemPromptSettings } from '@/core/prompt/mainAgent';
import { buildTitleGenerationSystemPrompt, resolveTitleGenerationLocale } from '@/core/prompt/titleGeneration';
import type { ProviderHost } from '@/core/providers/ProviderHost';

import type { OpencodeExecutionProfile } from '../execution/OpencodeSessionContract';
import type { OpencodeManagedAgentConfig } from './OpencodeLaunchArtifacts';

/** OpenCode's native default agent; the main chat runs on it in every permission mode. */
export const OPENCODE_BUILD_AGENT_ID = 'build';

export const AUX_AGENT_IDS: Record<Exclude<OpencodeExecutionProfile, 'managed'>, string> = {
  passive: 'claudian-title',
  readonly: 'claudian-inline-edit',
};

const READ_PERMISSION = Object.freeze({
  '*': 'allow',
  '*.env': 'deny',
  '*.env.*': 'deny',
  '*.env.example': 'allow',
});

export function buildAgentConfig(
  profile: Exclude<OpencodeExecutionProfile, 'managed'>,
): OpencodeManagedAgentConfig {
  return profile === 'readonly'
    ? {
      definition: {
        description: 'Claudian read-only execution agent.',
        mode: 'primary',
        permission: {
          '*': 'deny',
          codesearch: 'allow',
          external_directory: 'deny',
          glob: 'allow',
          grep: 'allow',
          lsp: 'allow',
          read: READ_PERMISSION,
          webfetch: 'allow',
          websearch: 'allow',
        },
      },
      id: AUX_AGENT_IDS.readonly,
    }
    : {
      definition: {
        description: 'Claudian passive execution agent.',
        mode: 'primary',
        permission: {
          '*': 'deny',
          external_directory: 'deny',
        },
      },
      id: AUX_AGENT_IDS.passive,
    };
}

export interface OpencodeSystemPromptParams {
  settings?: SystemPromptSettings;
  titleLocale?: string;
  workspaceRoot: string;
}

/** Claudian's default instructions for each native execution profile. */
export function buildOpencodeSystemPrompt(profile: OpencodeExecutionProfile, params: OpencodeSystemPromptParams): string {
  if (profile === 'readonly') return getInlineEditSystemPrompt(params.workspaceRoot);
  if (profile === 'passive') return buildTitleGenerationSystemPrompt(params.titleLocale);
  return buildSystemPrompt(params.settings ?? {});
}

/** The literal instructions one execution runs with, read from the current settings. */
export function resolveOpencodeSystemPrompt(
  plugin: Pick<ProviderHost, 'settings'>,
  workspaceRoot: string,
  profile: OpencodeExecutionProfile,
  instructions: ProviderSystemInstructions,
): string {
  if (instructions.kind === 'explicit') return instructions.instructions;
  return buildOpencodeSystemPrompt(profile, {
    // Only the managed chat profile reads these settings; auxiliary profiles keep their fixed prompts.
    settings: { ...getSystemPromptSettings(plugin, workspaceRoot), sessionInstructions: instructions.sessionInstructions },
    titleLocale: resolveTitleGenerationLocale(plugin.settings),
    workspaceRoot,
  });
}

export function getSystemPromptSettings(
  plugin: Pick<ProviderHost, 'settings'>,
  vaultPath: string,
): SystemPromptSettings {
  return {
    customPrompt: plugin.settings.systemPrompt,
    mediaFolder: plugin.settings.mediaFolder,
    userName: plugin.settings.userName,
    vaultPath,
  };
}
