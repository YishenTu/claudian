import type { ProviderUIOption } from '../../../core/providers/types';

export type CursorModel = string;

export const DEFAULT_CURSOR_PRIMARY_MODEL: CursorModel = 'auto';
export const CURSOR_COMPOSER_MODEL: CursorModel = 'composer-2';
export const CURSOR_GPT5_MODEL: CursorModel = 'gpt-5.5-extra-high';
export const CURSOR_OPUS_MODEL: CursorModel = 'claude-opus-4-7-max';
export const CURSOR_SONNET_MODEL: CursorModel = 'claude-4.6-sonnet-medium-thinking';

const KNOWN_LABELS: Record<string, string> = {
  auto: 'Auto',
  'composer-2': 'Composer 2',
  'gpt-5.5-extra-high': 'GPT-5.5 1M Extra High',
  'claude-opus-4-7-max': 'Opus 4.7 1M Max',
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

export const CURSOR_CONTEXT_WINDOW_STANDARD = 200_000;
export const CURSOR_CONTEXT_WINDOW_1M = 1_000_000;

/**
 * Models known to ship with a 1M context window in `cursor-agent --list-models`.
 * Anything matching is reported as 1M; everything else falls back to the
 * standard 200K and can still be overridden per-model via
 * `settings.customContextLimits[<modelId>]`.
 */
const ONE_M_PATTERNS: RegExp[] = [
  /^gpt-5\.5(-|$)/i,
  /^gpt-5\.4-(?:low|medium|high|xhigh)(?:-fast)?$/i,
  /^claude-opus-4-7/i,
  /^claude-4\.5-opus/i,
  /^claude-4\.6-opus/i,
  /^claude-4\.6-sonnet/i,
  /^grok-4\.3$/i,
];

function looksLike1MContext(model: string): boolean {
  return ONE_M_PATTERNS.some(pattern => pattern.test(model));
}

function isValidContextLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function getCursorContextWindow(
  model: string,
  customLimits?: Record<string, number>,
): number {
  if (customLimits) {
    const override = customLimits[model];
    if (isValidContextLimit(override)) {
      return override;
    }
  }

  if (looksLike1MContext(model)) {
    return CURSOR_CONTEXT_WINDOW_1M;
  }

  return CURSOR_CONTEXT_WINDOW_STANDARD;
}
