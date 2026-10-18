import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { OpencodeNativeModel } from '@/providers/opencode/http/OpencodeNativeModelCatalog';
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
  expect(getOpencodeProviderSettings(host.settings).thinkingOptionsByModel).toEqual({
    'provider/alpha': [{ label: 'High', value: 'high' }],
    'provider/beta': [{ label: 'Low', value: 'low' }],
  });
});

it('replaces an explicitly empty catalog without changing enabled model choices', async () => {
  const host = createHost();
  await projectOpencodeMetadata(host, { models: [nativeModel('provider/alpha', 'Alpha')] });
  await projectOpencodeMetadata(host, { models: [] });
  expect(getOpencodeProviderSettings(host.settings)).toMatchObject({
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
  expect(getOpencodeProviderSettings(host.settings).thinkingOptionsByModel['provider/alpha'])
    .toEqual([{ label: 'High', value: 'high' }]);

  await projectOpencodeMetadata(host, { selectedRawModelId: 'provider/alpha', thinkingLevels: [] });
  expect(getOpencodeProviderSettings(host.settings)).toMatchObject({
    discoveredModels: [{ rawId: 'provider/alpha', label: 'Alpha' }],
    thinkingOptionsByModel: { 'provider/beta': [{ label: 'Low', value: 'low' }] },
  });
  expect(getOpencodeProviderSettings(host.settings).thinkingOptionsByModel['provider/alpha']).toEqual([]);
});
