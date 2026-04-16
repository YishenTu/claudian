import type {
  ProviderChatUIConfig,
  ProviderUIOption,
} from '../../../core/providers/types';
import { getAcpProviderSettings } from '../settings';

/**
 * ACP chat UI configuration.
 * Provides model options and other UI configuration for the ACP provider.
 */
export const acpChatUIConfig: ProviderChatUIConfig = {
  getModelOptions(settings: Record<string, unknown>): ProviderUIOption[] {
    const acpSettings = getAcpProviderSettings(settings);
    // Return configured agents as "model" options
    return acpSettings.agents
      .filter(a => a.enabled)
      .map(agent => ({
        value: agent.id,
        label: agent.name,
        description: `${agent.transportType} agent`,
      }));
  },

  ownsModel(model: string, settings: Record<string, unknown>): boolean {
    const acpSettings = getAcpProviderSettings(settings);
    return acpSettings.agents.some(a => a.id === model);
  },

  isAdaptiveReasoningModel(_model: string): boolean {
    // ACP agents manage their own reasoning
    return false;
  },

  getReasoningOptions(_model: string): import('../../../core/providers/types').ProviderReasoningOption[] {
    // ACP agents manage their own reasoning
    return [];
  },

  getDefaultReasoningValue(_model: string): string {
    return 'medium';
  },

  getContextWindowSize(_model: string, _customLimits?: Record<string, number>): number {
    // ACP agents manage their own context windows
    return 200000;
  },

  isDefaultModel(_model: string): boolean {
    // ACP doesn't have built-in models
    return false;
  },

  applyModelDefaults(_model: string, _settings: unknown): void {
    // No-op for ACP
  },

  normalizeModelVariant(model: string, _settings: Record<string, unknown>): string {
    return model;
  },

  getCustomModelIds(_envVars: Record<string, string>): Set<string> {
    return new Set();
  },
};
