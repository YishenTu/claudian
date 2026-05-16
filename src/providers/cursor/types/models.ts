import type { ProviderUIOption } from '../../../core/providers/types';

export type CursorModel = string;

export const DEFAULT_CURSOR_PRIMARY_MODEL: CursorModel = 'auto';
export const CURSOR_COMPOSER_MODEL: CursorModel = 'composer-2';
export const CURSOR_GPT5_MODEL: CursorModel = 'gpt-5.5-extra-high';
export const CURSOR_OPUS_MODEL: CursorModel = 'claude-4.6-opus-max-thinking';
export const CURSOR_SONNET_MODEL: CursorModel = 'claude-4.6-sonnet-medium-thinking';

const KNOWN_LABELS: Record<string, string> = {
  auto: 'Auto',
  'composer-2': 'Composer 2',
  'gpt-5.5-extra-high': 'GPT-5.5 Extra High',
  'claude-4.6-opus-max-thinking': 'Opus 4.6 Max Thinking',
  'claude-4.6-sonnet-medium-thinking': 'Sonnet 4.6 Thinking',
};

export function formatCursorModelLabel(model: string): string {
  if (KNOWN_LABELS[model]) {
    return KNOWN_LABELS[model];
  }
  return model;
}

function createCursorModelOption(model: CursorModel, description: string): ProviderUIOption {
  return {
    value: model,
    label: formatCursorModelLabel(model),
    description,
  };
}

export const DEFAULT_CURSOR_MODELS: ProviderUIOption[] = [
  createCursorModelOption(DEFAULT_CURSOR_PRIMARY_MODEL, 'Cursor selects'),
  createCursorModelOption(CURSOR_COMPOSER_MODEL, 'Cursor'),
  createCursorModelOption(CURSOR_GPT5_MODEL, 'OpenAI'),
  createCursorModelOption(CURSOR_OPUS_MODEL, 'Anthropic'),
  createCursorModelOption(CURSOR_SONNET_MODEL, 'Anthropic'),
];

export const DEFAULT_CURSOR_MODEL_SET = new Set(DEFAULT_CURSOR_MODELS.map(model => model.value));
