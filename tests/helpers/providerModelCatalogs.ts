import { TEST_CODEX_CATALOG } from '@test/helpers/codexModels';
import { runtimeHostFor } from '@test/helpers/providerRuntimeHost';
import { writeGrokCatalog } from '@test/helpers/providers/grokSettings';

import { assertClaudeModelAvailable } from '@/providers/claude/runtime/ClaudeModelAvailability';
import { getClaudeProviderSettings, updateClaudeProviderSettings } from '@/providers/claude/settings';
import { assertCodexModelAvailable } from '@/providers/codex/runtime/CodexModelAvailability';
import { getCodexProviderSettings, updateCodexProviderSettings } from '@/providers/codex/settings';
import { assertDeepSeekModelAvailable } from '@/providers/deepseek/runtime/DeepSeekModels';
import { getDeepSeekProviderSettings, updateDeepSeekProviderSettings } from '@/providers/deepseek/settings';
import { assertGrokModelAvailable } from '@/providers/grok/runtime/GrokModelAvailability';
import { getGrokProviderSettings, updateGrokProviderSettings } from '@/providers/grok/settings';
import { assertOpencodeModelAvailable } from '@/providers/opencode/runtime/OpencodeModelAvailability';
import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from '@/providers/opencode/settings';
import { assertPiModelAvailable } from '@/providers/pi/runtime/PiModelAvailability';
import { getPiProviderSettings, updatePiProviderSettings } from '@/providers/pi/settings';

const availabilityGuards = {
  claude: assertClaudeModelAvailable,
  codex: assertCodexModelAvailable,
  deepseek: assertDeepSeekModelAvailable,
  grok: assertGrokModelAvailable,
  opencode: assertOpencodeModelAvailable,
  pi: assertPiModelAvailable,
};

/** Runs a provider's execution-time model guard against a settings document. */
export function assertCatalogModelAvailable(
  providerId: keyof typeof availabilityGuards,
  settings: object,
  model: string | undefined,
): void {
  availabilityGuards[providerId](runtimeHostFor({ settings }, providerId), model);
}

export const modelCatalogCases = [
  {
    id: 'claude' as const, selected: 'sonnet',
    populate(settings: Record<string, unknown>) {
      updateClaudeProviderSettings(settings, { enabled: true, visibleModels: ['sonnet'], discoveredModels: [
        { value: 'sonnet', label: 'Selected label', description: 'Selected metadata' },
        { value: 'unselected-catalog-entry', label: 'Unselected', description: '' },
      ] });
    },
    read: (settings: Record<string, unknown>) => getClaudeProviderSettings(settings).discoveredModels,
  },
  {
    id: 'codex' as const, selected: 'gpt-5.5',
    populate(settings: Record<string, unknown>) {
      updateCodexProviderSettings(settings, { enabled: true, visibleModels: ['gpt-5.5'], discoveredModels: [
        { ...TEST_CODEX_CATALOG[0], inputModalities: ['text'] }, { ...TEST_CODEX_CATALOG[1], inputModalities: ['text'], model: 'unselected-catalog-entry' },
      ] });
    },
    read: (settings: Record<string, unknown>) => getCodexProviderSettings(settings).discoveredModels,
  },
  {
    id: 'grok' as const, selected: 'grok/selected',
    populate(settings: Record<string, unknown>) {
      updateGrokProviderSettings(settings, { enabled: true, visibleModels: ['selected'] });
      writeGrokCatalog(settings, { defaultModelId: 'selected', fingerprint: 'test', refreshedAt: 10, models: [
        { rawId: 'selected', displayName: 'Selected label', reasoningEfforts: [], supportsReasoning: false },
        { rawId: 'unselected-catalog-entry', displayName: 'Unselected', reasoningEfforts: [], supportsReasoning: false },
      ] });
    },
    read: (settings: Record<string, unknown>) => getGrokProviderSettings(settings).currentCatalog?.models ?? [],
  },
  {
    id: 'opencode' as const, selected: 'opencode:anthropic/selected',
    populate(settings: Record<string, unknown>) {
      updateOpencodeProviderSettings(settings, { enabled: true, visibleModels: ['anthropic/selected'], discoveredModels: [
        { rawId: 'anthropic/selected', label: 'Selected label' },
        { rawId: 'unselected-catalog-entry', label: 'Unselected' },
      ] });
    },
    read: (settings: Record<string, unknown>) => getOpencodeProviderSettings(settings).discoveredModels,
  },
  {
    id: 'pi' as const, selected: 'pi:anthropic/selected',
    populate(settings: Record<string, unknown>) {
      updatePiProviderSettings(settings, { enabled: true, visibleModels: ['pi:anthropic/selected'], discoveredModels: [
        { encodedId: 'pi:anthropic/selected', id: 'selected', provider: 'anthropic', label: 'Selected label', input: ['text'], reasoning: true, thinkingLevels: ['off', 'high'] },
        { encodedId: 'pi:anthropic/unselected-catalog-entry', id: 'unselected-catalog-entry', provider: 'anthropic', label: 'Unselected', input: ['text'], reasoning: false, thinkingLevels: ['off'] },
      ] });
    },
    read: (settings: Record<string, unknown>) => getPiProviderSettings(settings).discoveredModels,
  },
  {
    id: 'deepseek' as const, selected: 'deepseek:native/selected',
    populate(settings: Record<string, unknown>) {
      updateDeepSeekProviderSettings(settings, { enabled: true, visibleModels: ['deepseek:native/selected'], discoveredModels: [
        { encodedId: 'deepseek:native/selected', id: 'selected', provider: 'native', label: 'Selected label', reasoning: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
        { encodedId: 'deepseek:native/unselected-catalog-entry', id: 'unselected-catalog-entry', provider: 'native', label: 'Unselected', reasoning: [] },
      ] });
    },
    read: (settings: Record<string, unknown>) => getDeepSeekProviderSettings(settings).discoveredModels,
  },
];
