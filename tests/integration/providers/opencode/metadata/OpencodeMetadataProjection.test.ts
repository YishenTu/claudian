import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ACPSessionConfigOption } from '@/providers/acp';
import { projectOpencodeMetadata } from '@/providers/opencode/metadata/OpencodeMetadataProjection';
import { getOpencodeProviderSettings } from '@/providers/opencode/settings';

function createHost(): ProviderHost {
  const settings = { providerConfigs: { opencode: { enabled: true, visibleModels: ['provider/alpha', 'provider/beta'] } } };
  const coordinator = new SettingsCoordinator(settings, async () => undefined);
  return {
    settings,
    mutateSettings: coordinator.mutate.bind(coordinator),
    mutateSettingsConditionally: coordinator.mutateConditionally.bind(coordinator),
    notifyProviderChatOptionsChanged() {},
  } as unknown as ProviderHost;
}

function effort(values: string[]): ACPSessionConfigOption[] {
  return [{
    id: 'effort', category: 'thought_level', name: 'Effort', type: 'select',
    currentValue: values[0] ?? '', options: values.map(value => ({ name: value, value })),
  }];
}

it('retains independent model warmups published through serialized settings mutations', async () => {
  const host = createHost();
  await Promise.all([
    projectOpencodeMetadata(host, { selectedRawModelId: 'provider/alpha', configOptions: effort(['high']) }),
    projectOpencodeMetadata(host, { selectedRawModelId: 'provider/beta', configOptions: effort(['low']) }),
  ]);
  expect(getOpencodeProviderSettings(host.settings).thinkingOptionsByModel).toEqual({
    'provider/alpha': [{ label: 'high', value: 'high' }],
    'provider/beta': [{ label: 'low', value: 'low' }],
  });
});

it('replaces an explicitly empty catalog without changing enabled model choices', async () => {
  const host = createHost();
  await projectOpencodeMetadata(host, {
    models: { currentModelId: '', availableModels: [{ modelId: 'provider/alpha', name: 'Alpha' }] },
  });
  await projectOpencodeMetadata(host, { models: { currentModelId: '', availableModels: [] } });
  expect(getOpencodeProviderSettings(host.settings)).toMatchObject({
    discoveredModels: [], visibleModels: ['provider/alpha', 'provider/beta'],
  });
});

it('clears catalogs supplied as empty ACP selectors while preserving omitted catalogs', async () => {
  const host = createHost();
  await projectOpencodeMetadata(host, {
    models: { currentModelId: 'provider/alpha', availableModels: [{ modelId: 'provider/alpha', name: 'Alpha' }] },
    modes: { currentModeId: 'build', availableModes: [{ id: 'build', name: 'Build' }] },
  });
  await projectOpencodeMetadata(host, {
    configOptions: [{ id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: '', options: [] }],
  });
  expect(getOpencodeProviderSettings(host.settings)).toMatchObject({
    discoveredModels: [], availableModes: [{ id: 'build', name: 'Build' }],
    visibleModels: ['provider/alpha', 'provider/beta'],
  });
  await projectOpencodeMetadata(host, {
    configOptions: [{ id: 'mode', name: 'Mode', type: 'select', currentValue: '', options: [] }],
  });
  expect(getOpencodeProviderSettings(host.settings).availableModes).toEqual([]);
});

it('clears explicitly empty reasoning options while retaining metadata absent from the update', async () => {
  const host = createHost();
  await projectOpencodeMetadata(host, {
    models: { currentModelId: 'provider/alpha', availableModels: [{ modelId: 'provider/alpha', name: 'Alpha' }] },
    configOptions: effort(['high']),
  });
  await projectOpencodeMetadata(host, {
    selectedRawModelId: 'provider/beta', configOptions: effort(['low']),
  });
  await projectOpencodeMetadata(host, { selectedRawModelId: 'provider/alpha' });
  expect(getOpencodeProviderSettings(host.settings).thinkingOptionsByModel['provider/alpha'])
    .toEqual([{ label: 'high', value: 'high' }]);

  await projectOpencodeMetadata(host, { selectedRawModelId: 'provider/alpha', configOptions: effort([]) });
  expect(getOpencodeProviderSettings(host.settings)).toMatchObject({
    discoveredModels: [{ rawId: 'provider/alpha', label: 'Alpha' }],
    thinkingOptionsByModel: { 'provider/beta': [{ label: 'low', value: 'low' }] },
  });
  expect(getOpencodeProviderSettings(host.settings).thinkingOptionsByModel['provider/alpha']).toBeUndefined();
});
