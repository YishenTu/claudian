import { runtimeHostFor } from '@test/helpers/providerRuntimeHost';

import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import type { ACPSessionConfigOption } from '@/providers/acp';
import { decodeOpencodeConfig } from '@/providers/opencode/config';
import { projectOpencodeMetadata } from '@/providers/opencode/metadata/OpencodeMetadataProjection';

function createHost(): ProviderRuntimeHost {
  const settings = { providerConfigs: { opencode: { enabled: true, visibleModels: ['provider/alpha', 'provider/beta'] } } };
  return runtimeHostFor({ settings }, 'opencode');
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
  expect(decodeOpencodeConfig(host.config).thinkingOptionsByModel).toEqual({
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
  expect(decodeOpencodeConfig(host.config)).toMatchObject({
    discoveredModels: [], visibleModels: ['provider/alpha', 'provider/beta'],
  });
});

it('clears catalogs supplied as empty ACP selectors while preserving omitted catalogs', async () => {
  const host = createHost();
  await projectOpencodeMetadata(host, {
    models: { currentModelId: 'provider/alpha', availableModels: [{ modelId: 'provider/alpha', name: 'Alpha' }] },
  });
  await projectOpencodeMetadata(host, {
    configOptions: [{ id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: '', options: [] }],
  });
  expect(decodeOpencodeConfig(host.config)).toMatchObject({
    discoveredModels: [],
    visibleModels: ['provider/alpha', 'provider/beta'],
  });
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
  expect(decodeOpencodeConfig(host.config).thinkingOptionsByModel['provider/alpha'])
    .toEqual([{ label: 'high', value: 'high' }]);

  await projectOpencodeMetadata(host, { selectedRawModelId: 'provider/alpha', configOptions: effort([]) });
  expect(decodeOpencodeConfig(host.config)).toMatchObject({
    discoveredModels: [{ rawId: 'provider/alpha', label: 'Alpha' }],
    thinkingOptionsByModel: { 'provider/beta': [{ label: 'low', value: 'low' }] },
  });
  expect(decodeOpencodeConfig(host.config).thinkingOptionsByModel['provider/alpha']).toEqual([]);
});
