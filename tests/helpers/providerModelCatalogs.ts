import { TEST_CODEX_CATALOG } from '@test/helpers/codexModels';

import { getClaudeProviderSettings, updateClaudeProviderSettings } from '@/providers/claude/settings';
import { getCodexProviderSettings, updateCodexProviderSettings } from '@/providers/codex/settings';
import { getGrokProviderSettings, updateCurrentGrokCatalog, updateGrokProviderSettings } from '@/providers/grok/settings';
import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from '@/providers/opencode/settings';
import { getPiProviderSettings, updatePiProviderSettings } from '@/providers/pi/settings';
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
      updateCurrentGrokCatalog(settings, { defaultModelId: 'selected', fingerprint: 'test', refreshedAt: 10, models: [
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
];
