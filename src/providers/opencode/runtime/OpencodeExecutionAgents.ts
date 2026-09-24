import { getInlineEditSystemPrompt } from '@/core/prompt/inlineEdit';
import { buildSystemPrompt, type SystemPromptSettings } from '@/core/prompt/mainAgent';
import { buildTitleGenerationSystemPrompt } from '@/core/prompt/titleGeneration';
import type { ProviderHost } from '@/core/providers/ProviderHost';

import type { OpencodeExecutionProfile } from '../execution/OpencodeSessionContract';
import type { OpencodeManagedAgentConfig } from './OpencodeLaunchArtifacts';

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
  dynamicSections?: readonly string[];
  titleLocale?: string;
  workspaceRoot: string;
}

/** Claudian's default instructions for each native execution profile. */
export function buildOpencodeSystemPrompt(profile: OpencodeExecutionProfile, params: OpencodeSystemPromptParams): string {
  if (profile === 'readonly') return getInlineEditSystemPrompt(params.workspaceRoot);
  if (profile === 'passive') return buildTitleGenerationSystemPrompt(params.titleLocale);
  return buildSystemPrompt(params.settings ?? {}, {
    dynamicSections: params.dynamicSections ? [...params.dynamicSections] : undefined,
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
