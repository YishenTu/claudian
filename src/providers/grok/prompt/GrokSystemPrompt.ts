import {
  buildSystemPrompt,
  type SystemPromptSettings,
} from '../../../core/prompt/mainAgent';

export type GrokSystemPromptSettings = SystemPromptSettings;

export interface GrokSystemPromptOptions {
  readonly dynamicSections?: readonly string[];
}

export function buildGrokSystemPrompt(
  settings: GrokSystemPromptSettings,
  options: GrokSystemPromptOptions = {},
): string {
  return buildSystemPrompt(settings, {
    dynamicSections: options.dynamicSections ? [...options.dynamicSections] : undefined,
  });
}
