import type {
  ProviderChatUIConfig,
  ProviderReasoningOption,
  ProviderUIOption,
} from '../../../core/providers/types';
import { parseEnvironmentVariables } from '../../../utils/env';

const CODEX_MODELS: ProviderUIOption[] = [
  { value: 'codex-mini', label: 'Codex Mini', description: 'Fast, lightweight' },
  { value: 'gpt-4.1', label: 'GPT-4.1', description: 'Balanced' },
  { value: 'o4-mini', label: 'o4-mini', description: 'Reasoning' },
];

const CODEX_MODEL_SET = new Set(CODEX_MODELS.map(m => m.value));

const EFFORT_LEVELS: ProviderReasoningOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const DEFAULT_CONTEXT_WINDOW = 200_000;

export const codexChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
    const envVars = settings.environmentVariables as string | undefined;
    if (envVars) {
      const parsed = parseEnvironmentVariables(envVars);
      if (parsed.OPENAI_MODEL) {
        const customModel = parsed.OPENAI_MODEL;
        if (!CODEX_MODEL_SET.has(customModel)) {
          return [
            { value: customModel, label: customModel, description: 'Custom (env)' },
            ...CODEX_MODELS,
          ];
        }
      }
    }
    return [...CODEX_MODELS];
  },

  isAdaptiveReasoningModel(): boolean {
    return true;
  },

  getReasoningOptions(): ProviderReasoningOption[] {
    return [...EFFORT_LEVELS];
  },

  getDefaultReasoningValue(): string {
    return 'medium';
  },

  getContextWindowSize(): number {
    return DEFAULT_CONTEXT_WINDOW;
  },

  isDefaultModel(model: string): boolean {
    return CODEX_MODEL_SET.has(model);
  },

  applyModelDefaults(): void {
    // No-op for Codex
  },

  normalizeModelVariant(model: string): string {
    return model;
  },

  getCustomModelIds(envVars: Record<string, string>): Set<string> {
    const ids = new Set<string>();
    if (envVars.OPENAI_MODEL && !CODEX_MODEL_SET.has(envVars.OPENAI_MODEL)) {
      ids.add(envVars.OPENAI_MODEL);
    }
    return ids;
  },

  getPermissionModeToggle() {
    return null;
  },
};
