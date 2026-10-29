import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import { runtimeHostFor } from '@test/helpers/providerRuntimeHost';

import { OpencodeMetadataService } from '@/providers/opencode/metadata/OpencodeMetadataService';
import { opencodeModelPolicy } from '@/providers/opencode/OpencodeModelPolicy';
import { assertOpencodeModelAvailable } from '@/providers/opencode/runtime/OpencodeModelAvailability';
import { createOpencodeModels } from '@/providers/opencode/runtime/OpencodeModels';
import { getOpencodeProviderSettings, projectOpencodeModelSettings } from '@/providers/opencode/settings';

import { createOpencodeV2MetadataFixture, type OpencodeV2MetadataFixture, waitUntil } from './OpencodeV2MetadataFixture';

// OpenCode v2 metadata catalog discovery, refresh, and models that appear after startup.
let fixture: OpencodeV2MetadataFixture;

beforeEach(() => { fixture = createOpencodeV2MetadataFixture(); });

afterEach(() => fixture.dispose());

function addModel(): void {
  const file = fixture.environment.CATALOG_FILE!;
  const catalog = JSON.parse(readFileSync(file, 'utf8'));
  catalog.push({ providerID: 'acme', id: 'slow-model', name: 'Slow Model', enabled: true, variants: [{ id: 'high' }] });
  writeFileSync(file + '.pending', JSON.stringify(catalog));
  renameSync(file + '.pending', file);
}

it('keeps native model IDs and reasoning independent through discovery, selection and persistence', async () => {
  fixture.environment.ACTIVATION_DELAY_MS = '1';
  writeFileSync(fixture.environment.CATALOG_FILE!, JSON.stringify([
    { providerID: 'test', id: 'one', name: 'One', enabled: true, variants: [{ id: 'high' }] },
    { providerID: 'test', id: 'one/high', name: 'Nested Model', enabled: true, variants: [{ id: 'low' }] },
    { providerID: 'test', id: 'high', name: 'High Model', enabled: true, variants: [{ id: 'max' }] },
  ]));
  const plugin = fixture.createPlugin();
  plugin.settings.providerConfigs.opencode.visibleModels = ['test/one/high', 'test/high', 'test/one'];
  const host = runtimeHostFor(plugin, 'opencode');
  const service = new OpencodeMetadataService(host, plugin.executionLifecycleRegistry);
  const models = createOpencodeModels(host, service);
  try {
    await models.refresh();
    const thinking = getOpencodeProviderSettings(plugin.settings).thinkingOptionsByModel;
    expect(thinking).toEqual({
      'test/one': [{ label: 'High', value: 'high' }, { label: 'Default', value: 'default' }],
      'test/one/high': [{ label: 'Low', value: 'low' }, { label: 'Default', value: 'default' }],
      'test/high': [{ label: 'Max', value: 'max' }, { label: 'Default', value: 'default' }],
    });
    expect(models.getSnapshot().models.map(model => [model.id, model.isAvailable !== false])).toEqual([
      ['test/one', true], ['test/one/high', true], ['test/high', true],
    ]);
    expect(opencodeModelPolicy.getModelOptions(plugin.settings).map(option => option.value))
      .toEqual(['opencode:test/one/high', 'opencode:test/high', 'opencode:test/one']);
    expect(opencodeModelPolicy.getDefaultModel?.(plugin.settings)).toBe('opencode:test/one/high');
    for (const [id, effort] of [['test/one/high', 'low'], ['test/high', 'max']]) {
      const model = `opencode:${id}`;
      expect(() => assertOpencodeModelAvailable(host, model)).not.toThrow();
      expect(opencodeModelPolicy.normalizeModelVariant(model, plugin.settings)).toBe(model);
      opencodeModelPolicy.applyReasoningSelection?.(model, effort, plugin.settings);
      opencodeModelPolicy.applyModelDefaults?.(model, plugin.settings);
      expect(plugin.settings.model).toBe(model);
      expect(plugin.settings.effortLevel).toBe(effort);
    }
    expect(() => assertOpencodeModelAvailable(host, 'opencode:test/one/max')).toThrow();
    await models.changeSelection({ type: 'set', modelId: 'test/one', selected: false });
    const reopened = getOpencodeProviderSettings({ providerConfigs: {
      opencode: JSON.parse(JSON.stringify(projectOpencodeModelSettings(plugin.settings))),
    } });
    expect(reopened.discoveredModels.map(model => model.rawId)).toEqual(['test/one/high', 'test/high']);
    expect(reopened.thinkingOptionsByModel).toEqual({
      'test/one/high': thinking['test/one/high'], 'test/high': thinking['test/high'],
    });
    expect(reopened.preferredThinkingByModel).toEqual({ 'test/one/high': 'low', 'test/high': 'max' });
    expect(readFileSync(fixture.environment.ENDPOINT_FILE + '.read', 'utf8')).toBe('1');
  } finally {
    await models.dispose();
    await service.dispose();
  }
});

it('names each model\'s upstream provider by its native display name when the server lists one', async () => {
  writeFileSync(fixture.environment.CATALOG_FILE + '.providers', JSON.stringify([
    { id: 'deepseek', name: 'DeepSeek Official' },
    // A name that would split the "Upstream/Model" label keeps the provider id.
    { id: 'acme', name: 'Acme / Labs' },
  ]));
  addModel();
  const plugin = fixture.createPlugin();
  const service = new OpencodeMetadataService(runtimeHostFor(plugin, 'opencode'), plugin.executionLifecycleRegistry);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([
      { rawId: 'deepseek/chat', label: 'DeepSeek Official/DeepSeek Chat' },
      { rawId: 'acme/slow-model', label: 'acme/Slow Model' },
    ]);
  } finally { await service.dispose(); }
});

it('refreshes the native catalog and commands without persisting the catalog or enabling models', async () => {
  const plugin = fixture.createPlugin();
  const service = new OpencodeMetadataService(runtimeHostFor(plugin, 'opencode'), plugin.executionLifecycleRegistry);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([
      { rawId: 'deepseek/chat', label: 'deepseek/DeepSeek Chat' },
    ]);
    fixture.writeCatalog('Updated Chat');
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels[0].label).toBe('deepseek/Updated Chat');
    await expect(service.discoverCommands()).resolves.toMatchObject({ loaded: true, commands: [
      { id: 'opencode-command:review', name: 'review', kind: 'command', description: 'Review changes' },
      { id: 'opencode-skill:writing', name: 'writing', kind: 'skill', description: 'Writing guide' },
    ] });
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

it('discovers models added after the initial discovery on the same metadata server', async () => {
  const plugin = fixture.createPlugin();
  const service = new OpencodeMetadataService(runtimeHostFor(plugin, 'opencode'), plugin.executionLifecycleRegistry);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    const endpoint = readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8');
    addModel();
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
});

it('waits for the requested model while other models are already available', async () => {
  const plugin = fixture.createPlugin();
  const service = new OpencodeMetadataService(runtimeHostFor(plugin, 'opencode'), plugin.executionLifecycleRegistry);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    const read = fixture.environment.ENDPOINT_FILE! + '.read';
    rmSync(read);
    const pending = service.warmModelMetadata('opencode:acme/slow-model');
    // The requested model appears only after a response containing other models was sent.
    await waitUntil(() => existsSync(read));
    addModel();
    await expect(pending).resolves.toBe(true);
  } finally { await service.dispose(); }
});
