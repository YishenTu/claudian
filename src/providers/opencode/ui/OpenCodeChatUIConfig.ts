import type {
  ProviderChatUIConfig,
  ProviderIconSvg,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';

const OPENCODE_ICON: ProviderIconSvg = {
  viewBox: '0 0 100 100',
  path: 'M50 5 L95 27.5 L95 72.5 L50 95 L5 72.5 L5 27.5 Z M50 15 L85 32.5 L85 67.5 L50 85 L15 67.5 L15 32.5 Z M50 25 L75 37.5 L75 62.5 L50 75 L25 62.5 L25 37.5 Z',
};

// Models available from user's OpenCode installation
const OPENCODE_MODELS: ProviderUIOption[] = [
  { value: 'opencode/big-pickle', label: 'Big Pickle', description: 'OpenCode - Free' },
  { value: 'opencode/gpt-5-nano', label: 'GPT-5 Nano', description: 'OpenAI via OpenCode - Free' },
  { value: 'opencode/minimax-m2.5-free', label: 'MiniMax M2.5', description: 'MiniMax - Free' },
  { value: 'opencode/nemotron-3-super-free', label: 'Nemotron 3 Super', description: 'NVIDIA - Free' },
];

const OPENCODE_MODEL_SET = new Set(OPENCODE_MODELS.map(m => m.value));

const EFFORT_LEVELS: ProviderReasoningOption[] = [
  { value: 'low', label: 'Low', description: 'Fast, minimal reasoning' },
  { value: 'medium', label: 'Medium', description: 'Balanced' },
  { value: 'high', label: 'High', description: 'Thorough reasoning' },
  { value: 'xhigh', label: 'XHigh', description: 'Maximum reasoning' },
];

function isOpenCodeModel(model: string): boolean {
  return OPENCODE_MODEL_SET.has(model) || model.startsWith('opencode/');
}

export const openCodeChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(_settings: Record<string, unknown>): ProviderUIOption[] {
    return [...OPENCODE_MODELS];
  },

  ownsModel(model: string, _settings: Record<string, unknown>): boolean {
    return isOpenCodeModel(model);
  },

  isAdaptiveReasoningModel(): boolean {
    return true;
  },

  getReasoningOptions(): ProviderReasoningOption[] {
    return EFFORT_LEVELS;
  },

  getDefaultReasoningValue(): string {
    return 'medium';
  },

  getContextWindowSize(model: string, customLimits?: Record<string, number>): number {
    if (customLimits?.[model]) return customLimits[model];
    return 128000;
  },

  isDefaultModel(model: string): boolean {
    return OPENCODE_MODEL_SET.has(model);
  },

  applyModelDefaults(_model: string, settings: unknown): void {
    const settingsRecord = settings as Record<string, unknown>;
    if (!settingsRecord['opencodeModel']) {
      settingsRecord['opencodeModel'] = 'opencode/big-pickle';
    }
  },

  normalizeModelVariant(model: string, _settings: Record<string, unknown>): string {
    return model || 'opencode/big-pickle';
  },

  getCustomModelIds(_envVars: Record<string, string>): Set<string> {
    return new Set(OPENCODE_MODELS.map(m => m.value));
  },

  getProviderIcon(): ProviderIconSvg | null {
    return OPENCODE_ICON;
  },
};
