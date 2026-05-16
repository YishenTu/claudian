import type { ProviderUIOption } from '../../../core/providers/types';

export type CursorModel = string;

export const DEFAULT_CURSOR_PRIMARY_MODEL: CursorModel = 'auto';
export const CURSOR_GPT5_MODEL: CursorModel = 'gpt-5';
export const CURSOR_SONNET_MODEL: CursorModel = 'claude-sonnet-4.5';
export const CURSOR_COMPOSER_MODEL: CursorModel = 'composer-1';

const KNOWN_LABELS: Record<string, string> = {
  auto: 'Auto',
  'gpt-5': 'GPT-5',
  'claude-sonnet-4.5': 'Claude Sonnet 4.5',
  'composer-1': 'Composer 1',
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
  createCursorModelOption(CURSOR_GPT5_MODEL, 'OpenAI'),
  createCursorModelOption(CURSOR_SONNET_MODEL, 'Anthropic'),
  createCursorModelOption(CURSOR_COMPOSER_MODEL, 'Cursor'),
];

export const DEFAULT_CURSOR_MODEL_SET = new Set(DEFAULT_CURSOR_MODELS.map(model => model.value));
