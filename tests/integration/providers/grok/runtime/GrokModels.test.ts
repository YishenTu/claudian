import '@/providers';

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { getProviderSettingsSnapshotWithModel } from '@/core/providers/conversationModel';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { normalizeGrokSessionModelMetadata, normalizeGrokSetModelMetadata } from '@/providers/grok/execution/GrokSessionModelMetadata';
import { GrokModelCatalogCoordinator } from '@/providers/grok/runtime/GrokModelCatalogCoordinator';
import { createGrokModels } from '@/providers/grok/runtime/GrokModels';
import { getGrokProviderSettings, projectGrokModelSettings } from '@/providers/grok/settings';
import { grokChatUIConfig } from '@/providers/grok/ui/GrokChatUIConfig';

const nativeCatalog = JSON.parse(readFileSync(
  path.resolve('tests/fixtures/providers/grok/runtime/models-list.json'), 'utf8',
));

function makeCatalog(selectedIds: string[] = [], response = nativeCatalog) {
  const settings: Record<string, unknown> = {
    providerConfigs: { grok: { enabled: true, visibleModels: selectedIds } },
  };
  const host = {
    settings,
    mutateSettings: async (mutation: (settings: Record<string, unknown>) => void) => mutation(settings),
    mutateSettingsConditionally: async (mutation: (settings: Record<string, unknown>) => boolean) => mutation(settings),
    notifyProviderChatOptionsChanged: jest.fn(),
  } as unknown as ProviderHost;
  const discovered = normalizeGrokSessionModelMetadata({ models: response.result });
  const coordinator = new GrokModelCatalogCoordinator(host, {
    discoverCatalog: async () => ({ kind: 'completed', fingerprint: 'native', defaultModelId: discovered.currentModelId, models: discovered.models }),
  });
  return { settings, coordinator, catalog: createGrokModels(host, coordinator) };
}

it('retains discovered effort choices through selection, persistence, and reload', async () => {
  const { settings, coordinator, catalog } = makeCatalog();
  await catalog.refresh();
  // Discovery must remain available in memory, but only selected models go to disk.
  expect(Object.values(projectGrokModelSettings(settings).selectedModelsByHost as Record<string, { models: unknown[] }>)
    .every(snapshot => snapshot.models.length === 0)).toBe(true);
  await catalog.select(['grok-4.6']);
  const reloaded = { providerConfigs: { grok: JSON.parse(JSON.stringify(projectGrokModelSettings(settings))) } };
  expect(grokChatUIConfig.getReasoningOptions('grok/grok-4.6', reloaded).map(option => option.value))
    .toEqual(['xhigh', 'high', 'medium', 'low']);
  expect(grokChatUIConfig.getDefaultReasoningValue('grok/grok-4.6', reloaded)).toBe('high');
  expect(grokChatUIConfig.isAdaptiveReasoningModel('grok/grok-4.6', reloaded)).toBe(true);
  await catalog.dispose();
  await coordinator.dispose();
});

it.each(['session', 'set-model'] as const)('preserves discovered efforts when %s metadata omits reasoning', async source => {
  const { settings, coordinator, catalog } = makeCatalog(['grok-4.6']);
  await catalog.refresh();
  grokChatUIConfig.applyReasoningSelection?.('grok/grok-4.6', 'xhigh', settings);
  const metadata = { totalContextTokens: 500_000, agentType: 'grok-build-plan' };
  const models = source === 'session'
    ? normalizeGrokSessionModelMetadata({ models: {
      currentModelId: 'grok-4.6',
      availableModels: [{ modelId: 'grok-4.6', name: 'Grok 4.6', _meta: metadata }],
    } }).models
    : [normalizeGrokSetModelMetadata('grok-4.6', { model: metadata })!];
  await coordinator.mergeLiveModels(models);
  expect(grokChatUIConfig.getReasoningOptions('grok/grok-4.6', settings).map(option => option.value))
    .toEqual(['xhigh', 'high', 'medium', 'low']);
  expect(getGrokProviderSettings(settings).preferredReasoningByModel).toEqual({ 'grok-4.6': 'xhigh' });
  expect(grokChatUIConfig.getDefaultReasoningValue('grok/grok-4.6', settings)).toBe('xhigh');
  await catalog.dispose();
  await coordinator.dispose();
});

it.each([{ reasoningEfforts: [] }, { supportsReasoningEffort: false }])(
  'clears choices when native metadata explicitly disables reasoning: %j', async metadata => {
    const { settings, coordinator, catalog } = makeCatalog(['grok-4.6']);
    await catalog.refresh();
    await coordinator.mergeLiveModels([
      normalizeGrokSetModelMetadata('grok-4.6', { model: metadata })!,
    ]);
    expect(grokChatUIConfig.getReasoningOptions('grok/grok-4.6', settings)).toEqual([]);
    expect(grokChatUIConfig.isAdaptiveReasoningModel('grok/grok-4.6', settings)).toBe(false);
    await catalog.dispose();
    await coordinator.dispose();
  },
);

it.each([undefined, 'low'])('projects the selected model default or preference (%s) over stale provider-wide medium effort', async preferred => {
  const byokCatalog = JSON.parse(readFileSync(
    path.resolve('tests/fixtures/providers/grok/runtime/models-list-byok.json'), 'utf8',
  ));
  const { settings, coordinator, catalog } = makeCatalog(['grok-4.7'], byokCatalog);
  await catalog.refresh();
  Object.assign(settings, {
    model: 'haiku', effortLevel: 'high',
    savedProviderModel: { grok: 'grok/grok-4.5' },
    savedProviderEffort: { grok: 'medium' },
  });
  if (preferred) grokChatUIConfig.applyReasoningSelection?.('grok/grok-4.7', preferred, settings);

  expect(ProviderSettingsCoordinator.getProviderSettingsSnapshot(settings, 'grok').effortLevel).toBe('medium');
  const projected = getProviderSettingsSnapshotWithModel(settings, 'grok', 'grok/grok-4.7');
  expect(projected.model).toBe('grok/grok-4.7');
  expect(projected.effortLevel).toBe(preferred ?? 'high');
  expect(projected.effortLevel).toBe(grokChatUIConfig.getDefaultReasoningValue('grok/grok-4.7', settings));
  expect(settings.savedProviderEffort).toEqual({ grok: 'medium' });
  await catalog.dispose();
  await coordinator.dispose();
});
