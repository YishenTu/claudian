import type { ProviderUIOption } from '../../../core/providers/types';

export type CodexModel = string;

export const DEFAULT_CODEX_MINI_MODEL: CodexModel = 'gpt-5.4-mini';
export const DEFAULT_CODEX_PRIMARY_MODEL: CodexModel = 'gpt-5.5';
export const FAST_TIER_CODEX_MODEL = DEFAULT_CODEX_PRIMARY_MODEL;

function formatCodexModelSuffix(suffix: string): string {
  return suffix
    .split('-')
    .filter(Boolean)
    .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase())
    .join(' ');
}

export function formatCodexModelLabel(model: string): string {
  const match = model.match(/^gpt-([^-]+)(?:-(.+))?$/i);
  if (!match) {
    return model;
  }

  const [, version, suffix] = match;
  return `GPT-${version}${suffix ? ` ${formatCodexModelSuffix(suffix)}` : ''}`;
}

function createCodexModelOption(model: CodexModel, description: string): ProviderUIOption {
  return {
    value: model,
    label: formatCodexModelLabel(model),
    description,
  };
}

export const DEFAULT_CODEX_MINI_MODEL_LABEL = formatCodexModelLabel(DEFAULT_CODEX_MINI_MODEL);
export const DEFAULT_CODEX_PRIMARY_MODEL_LABEL = formatCodexModelLabel(DEFAULT_CODEX_PRIMARY_MODEL);
export const FAST_TIER_CODEX_MODEL_LABEL = formatCodexModelLabel(FAST_TIER_CODEX_MODEL);
export const FAST_TIER_CODEX_DESCRIPTION = `Enable ${FAST_TIER_CODEX_MODEL_LABEL} fast mode for this conversation. Faster responses use more credits.`;

export const DEFAULT_CODEX_MODELS: ProviderUIOption[] = [
  createCodexModelOption(DEFAULT_CODEX_MINI_MODEL, 'Fast'),
  createCodexModelOption(DEFAULT_CODEX_PRIMARY_MODEL, 'Latest'),
];

export const DEFAULT_CODEX_MODEL_SET = new Set(DEFAULT_CODEX_MODELS.map(model => model.value));
