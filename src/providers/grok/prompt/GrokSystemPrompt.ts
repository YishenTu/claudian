import {
  buildSystemPrompt,
  type SystemPromptSettings,
} from '../../../core/prompt/mainAgent';

export type GrokSystemPromptSettings = SystemPromptSettings;

export function buildGrokSystemPrompt(settings: GrokSystemPromptSettings): string {
  return buildSystemPrompt(settings);
}
