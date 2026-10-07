import { readFileSync, writeFileSync } from 'node:fs';

import { OpencodeMetadataService } from '@/providers/opencode/metadata/OpencodeMetadataService';
import { createOpencodeModels } from '@/providers/opencode/runtime/OpencodeModels';
import { getOpencodeProviderSettings, projectOpencodeModelSettings } from '@/providers/opencode/settings';

import { createOpencodeV2MetadataFixture, type OpencodeV2MetadataFixture } from './OpencodeV2MetadataFixture';

// OpenCode v2 metadata catalog discovery, refresh, and models that appear after startup.
let fixture: OpencodeV2MetadataFixture;

beforeEach(() => { fixture = createOpencodeV2MetadataFixture(); });

afterEach(() => fixture.dispose());

it('discovers several selected models from one native catalog response', async () => {
  fixture.environment.ACTIVATION_DELAY_MS = '1';
  writeFileSync(fixture.environment.CATALOG_FILE!, JSON.stringify([
    { providerID: 'test', id: 'one', name: 'One', enabled: true, variants: [{ id: 'high' }] },
    { providerID: 'test', id: 'two', name: 'Two', enabled: true, variants: [{ id: 'low' }] },
  ]));
  const plugin = fixture.createPlugin();
  plugin.settings.providerConfigs.opencode.visibleModels = ['test/one', 'test/two'];
  const service = new OpencodeMetadataService(plugin);
  const models = createOpencodeModels(plugin, service);
  try {
    await models.refresh();
    const thinking = getOpencodeProviderSettings(plugin.settings).thinkingOptionsByModel;
    expect(thinking['test/one'].map(option => option.value)).toEqual(['high', 'default']);
    expect(thinking['test/two'].map(option => option.value)).toEqual(['low', 'default']);
    expect(readFileSync(fixture.environment.ENDPOINT_FILE + '.read', 'utf8')).toBe('1');
  } finally {
    await models.dispose();
    await service.dispose();
  }
});

it('refreshes the native catalog and commands without persisting the catalog or enabling models', async () => {
  const plugin = fixture.createPlugin();
  const service = new OpencodeMetadataService(plugin);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([
      { rawId: 'deepseek/chat', label: 'deepseek/DeepSeek Chat' },
    ]);
    fixture.writeCatalog('Updated Chat');
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels[0].label).toBe('deepseek/Updated Chat');
    await expect(service.loadCommands()).resolves.toMatchObject([
      { name: 'review', kind: 'command', description: 'Review changes' },
      { name: 'writing', kind: 'skill', description: 'Writing guide' },
    ]);
    await expect(service.warmModelMetadata('opencode:deepseek/chat')).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).thinkingOptionsByModel['deepseek/chat'])
      .toEqual(expect.arrayContaining([{ value: 'high', label: 'High' }, { value: 'default', label: 'Default' }]));
    const stored = projectOpencodeModelSettings(plugin.settings);
    expect(stored.discoveredModels).toBeUndefined();
    expect(stored.visibleModels).toEqual([]);
    expect((await fetch(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8'))).status).toBe(403);
  } finally { await service.dispose(); }
  await expect(fetch(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8'))).rejects.toThrow();
});

it.each([3_000, 7_500])('discovers models added after %i ms on the same metadata server', async (delayMs) => {
  fixture.environment.DELAYED_CATALOG_MS = String(delayMs);
  const catalog = JSON.parse(readFileSync(fixture.environment.CATALOG_FILE!, 'utf8'));
  catalog.push({ providerID: 'acme', id: 'slow-model', name: 'Slow Model', enabled: true, variants: [{ id: 'high' }] });
  writeFileSync(fixture.environment.CATALOG_FILE!, JSON.stringify(catalog));
  const plugin = fixture.createPlugin();
  const service = new OpencodeMetadataService(plugin);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    const endpoint = readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8');
    await new Promise(resolve => setTimeout(resolve, delayMs + 50));
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([
      { rawId: 'deepseek/chat', label: 'deepseek/DeepSeek Chat' },
      { rawId: 'acme/slow-model', label: 'acme/Slow Model' },
    ]);
    expect(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8')).toBe(endpoint);
    await expect(service.warmModelMetadata('opencode:acme/slow-model')).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).thinkingOptionsByModel['acme/slow-model'])
      .toEqual(expect.arrayContaining([{ value: 'high', label: 'High' }]));
    expect(getOpencodeProviderSettings(plugin.settings).visibleModels).toEqual([]);
  } finally { await service.dispose(); }
}, 15_000);

it('waits for the requested model while other models are already available', async () => {
  fixture.environment.DELAYED_CATALOG_MS = '250';
  const catalog = JSON.parse(readFileSync(fixture.environment.CATALOG_FILE!, 'utf8'));
  catalog.push({ providerID: 'acme', id: 'slow-model', name: 'Slow Model', enabled: true, variants: [{ id: 'high' }] });
  writeFileSync(fixture.environment.CATALOG_FILE!, JSON.stringify(catalog));
  const service = new OpencodeMetadataService(fixture.createPlugin());
  try {
    await expect(service.warmModelMetadata('opencode:acme/slow-model')).resolves.toBe(true);
  } finally { await service.dispose(); }
});
