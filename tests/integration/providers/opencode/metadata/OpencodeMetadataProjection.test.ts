import { runtimeHostFor } from '@test/helpers/providerRuntimeHost';

import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import { decodeOpencodeConfig } from '@/providers/opencode/config';
import type { OpencodeNativeModel } from '@/providers/opencode/http/OpencodeNativeModelCatalog';
import { projectOpencodeMetadata } from '@/providers/opencode/metadata/OpencodeMetadataProjection';

function createHost(): ProviderRuntimeHost {
  const settings = { providerConfigs: { opencode: { enabled: true, visibleModels: ['provider/alpha', 'provider/beta'] } } };
  return runtimeHostFor({ settings }, 'opencode');
}

function nativeModel(rawId: string, label: string): OpencodeNativeModel {
  const [providerID, id] = rawId.split('/');
  return { rawId, providerID, id, label, variants: [], contextWindow: 0 };
}

it('retains independent model warmups published through serialized settings mutations', async () => {
  const host = createHost();
  await Promise.all([
    projectOpencodeMetadata(host, { selectedRawModelId: 'provider/alpha', thinkingLevels: ['high'] }),
    projectOpencodeMetadata(host, { selectedRawModelId: 'provider/beta', thinkingLevels: ['low'] }),
  ]);
  expect(decodeOpencodeConfig(host.config).thinkingOptionsByModel).toEqual({
    'provider/alpha': [{ label: 'High', value: 'high' }],
    'provider/beta': [{ label: 'Low', value: 'low' }],
  });
});

it('replaces an explicitly empty catalog without changing enabled model choices', async () => {
  const host = createHost();
  await projectOpencodeMetadata(host, { models: [nativeModel('provider/alpha', 'Alpha')] });
  await projectOpencodeMetadata(host, { models: [] });
  expect(decodeOpencodeConfig(host.config)).toMatchObject({
    discoveredModels: [], visibleModels: ['provider/alpha', 'provider/beta'],
  });
});

it('clears explicitly empty reasoning options while retaining metadata absent from the update', async () => {
  const host = createHost();
  await projectOpencodeMetadata(host, {
    models: [nativeModel('provider/alpha', 'Alpha')],
    selectedRawModelId: 'provider/alpha',
    thinkingLevels: ['high'],
  });
  await projectOpencodeMetadata(host, {
    selectedRawModelId: 'provider/beta', thinkingLevels: ['low'],
  });
  await projectOpencodeMetadata(host, { selectedRawModelId: 'provider/alpha' });
  expect(decodeOpencodeConfig(host.config).thinkingOptionsByModel['provider/alpha'])
    .toEqual([{ label: 'High', value: 'high' }]);

  await projectOpencodeMetadata(host, { selectedRawModelId: 'provider/alpha', thinkingLevels: [] });
  expect(decodeOpencodeConfig(host.config)).toMatchObject({
    discoveredModels: [{ rawId: 'provider/alpha', label: 'Alpha' }],
    thinkingOptionsByModel: { 'provider/beta': [{ label: 'Low', value: 'low' }] },
  });
  expect(decodeOpencodeConfig(host.config).thinkingOptionsByModel['provider/alpha']).toEqual([]);
});

it('publishes reasoning metadata for an accepted prototype-named model', async () => {
  const host = runtimeHostFor({ settings: { providerConfigs: { opencode: { enabled: true, visibleModels: ['__proto__'] } } } }, 'opencode');
  await projectOpencodeMetadata(host, { selectedRawModelId: '__proto__', thinkingLevels: ['high'] });
  expect(Object.entries(decodeOpencodeConfig(JSON.parse(JSON.stringify(host.config))).thinkingOptionsByModel))
    .toEqual([['__proto__', [{ label: 'High', value: 'high' }]]]);
});
