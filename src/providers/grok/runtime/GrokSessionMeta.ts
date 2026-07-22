import { decodeGrokModelId } from '../models';
import {
  buildGrokSystemPrompt,
  type GrokSystemPromptSettings,
} from '../prompt/GrokSystemPrompt';

export interface GrokSessionMeta {
  modelId?: string;
  systemPromptOverride: string;
  yoloMode: boolean;
}

export interface GrokSessionMetaBuildOptions {
  model: string;
  permissionMode: unknown;
  promptSettings: GrokSystemPromptSettings;
}

export function buildGrokSessionMeta(
  options: GrokSessionMetaBuildOptions,
): GrokSessionMeta {
  const modelId = decodeGrokModelId(options.model);
  return {
    ...(modelId ? { modelId } : {}),
    systemPromptOverride: buildGrokSystemPrompt(options.promptSettings),
    yoloMode: options.permissionMode === 'yolo',
  };
}
