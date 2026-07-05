import type { ProviderChatUIConfig, ProviderIconSvg, ProviderReasoningOption, ProviderUIOption } from '../../../core/providers/types';

export const GEMINI_ICON: ProviderIconSvg = {
  kind: 'path',
  viewBox: '0 0 24 24',
  path: 'M12 2C12 7.52 7.52 12 2 12C7.52 12 12 16.48 12 22C12 16.48 16.48 12 22 12C16.48 12 12 7.52 12 2Z',
};

const GEMINI_MODELS = [
  { id: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro', contextWindow: 2000000 },
  { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash', contextWindow: 1000000 },
  { id: 'gemini-2.0-flash-exp', label: 'Gemini 2.0 Flash (Exp)', contextWindow: 1000000 },
];

export const geminiChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(): ProviderUIOption[] {
    return GEMINI_MODELS.map(m => ({
      value: m.id,
      label: m.label,
      providerIcon: GEMINI_ICON,
    }));
  },

  ownsModel(model: string): boolean {
    return model.startsWith('gemini-');
  },

  isAdaptiveReasoningModel(): boolean {
    return false;
  },

  getReasoningOptions(): ProviderReasoningOption[] {
    return [];
  },

  getDefaultReasoningValue(): string {
    return 'none';
  },

  getContextWindowSize(model: string): number {
    const found = GEMINI_MODELS.find(m => m.id === model);
    return found?.contextWindow ?? 1000000;
  },

  isDefaultModel(model: string): boolean {
    return GEMINI_MODELS.some(m => m.id === model);
  },

  applyModelDefaults(): void {
    // No side effects needed
  },

  normalizeModelVariant(model: string): string {
    return model;
  },

  getCustomModelIds(): Set<string> {
    return new Set();
  },

  getProviderIcon(): ProviderIconSvg {
    return GEMINI_ICON;
  },
};
