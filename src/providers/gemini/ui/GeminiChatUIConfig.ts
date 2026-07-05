import type { ProviderChatUIConfig, ProviderIconSvg, ProviderReasoningOption, ProviderUIOption } from '../../../core/providers/types';
import { getGeminiProviderSettings, migrateLegacyGeminiModelId } from '../settings';

export const GEMINI_ICON: ProviderIconSvg = {
  kind: 'path',
  viewBox: '0 0 24 24',
  path: 'M12 2C12 7.52 7.52 12 2 12C7.52 12 12 16.48 12 22C12 16.48 16.48 12 22 12C16.48 12 12 7.52 12 2Z',
};

const GEMINI_MODELS = [
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextWindow: 1048576 },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextWindow: 1048576 },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite', contextWindow: 1048576 },
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', contextWindow: 1048576 },
  { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash-Lite', contextWindow: 1048576 },
];

export const geminiChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
    const providerSettings = getGeminiProviderSettings(settings);
    
    // Combine fetched models with hardcoded defaults, preferring fetched ones if they overlap
    const modelsMap = new Map<string, { id: string; label: string; contextWindow: number }>();
    
    for (const m of GEMINI_MODELS) {
      modelsMap.set(m.id, m);
    }
    
    if (providerSettings.fetchedModels && providerSettings.fetchedModels.length > 0) {
      for (const m of providerSettings.fetchedModels) {
        modelsMap.set(m.id, { id: m.id, label: m.label, contextWindow: 2000000 }); // Default 2M context for Gemini 1.5+ models
      }
    }
    
    return Array.from(modelsMap.values()).map(m => ({
      value: m.id,
      label: m.label,
      providerIcon: GEMINI_ICON,
    }));
  },

  ownsModel(model: string, settings: Record<string, unknown>): boolean {
    return model.startsWith('gemini-') || model.startsWith('learnlm-') || model.startsWith('models/');
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

  getContextWindowSize(model: string, customLimits?: Record<string, number>, settings?: Record<string, unknown>): number {
    const found = GEMINI_MODELS.find(m => m.id === model);
    return found?.contextWindow ?? 2000000;
  },

  isDefaultModel(model: string): boolean {
    return GEMINI_MODELS.some(m => m.id === model);
  },

  applyModelDefaults(): void {
    // No side effects needed
  },

  normalizeModelVariant(model: string): string {
    return migrateLegacyGeminiModelId(model);
  },

  getCustomModelIds(): Set<string> {
    return new Set();
  },

  getProviderIcon(): ProviderIconSvg {
    return GEMINI_ICON;
  },
};
