import type { ProviderUIOption } from '../../../core/providers/types';

export const DEFAULT_GEMINI_PRIMARY_MODEL = 'gemini-2.5-pro';
export const DEFAULT_GEMINI_CONTEXT_WINDOW = 1_000_000;

export const DEFAULT_GEMINI_MODELS: ProviderUIOption[] = [
  {
    value: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    description: 'Highest quality',
  },
  {
    value: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    description: 'Fast, balanced',
  },
  {
    value: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash Lite',
    description: 'Fastest, low cost',
  },
];

export const DEFAULT_GEMINI_MODEL_SET = new Set(
  DEFAULT_GEMINI_MODELS.map((model) => model.value),
);

export function formatGeminiModelLabel(modelId: string): string {
  return modelId
    .replace(/^models\//, '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => {
      if (/^\d+(\.\d+)?$/.test(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}
