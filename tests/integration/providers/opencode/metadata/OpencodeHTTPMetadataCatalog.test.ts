import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as yieldToIO } from 'node:timers/promises';

import { runtimeHostFor } from '@test/helpers/providerRuntimeHost';

import { OpencodeHTTPClient } from '@/providers/opencode/http/OpencodeHTTPClient';
import { OpencodeMetadataService } from '@/providers/opencode/metadata/OpencodeMetadataService';
import { opencodeModelPolicy } from '@/providers/opencode/OpencodeModelPolicy';
import { assertOpencodeModelAvailable } from '@/providers/opencode/runtime/OpencodeModelAvailability';
import { createOpencodeModels } from '@/providers/opencode/runtime/OpencodeModels';
import { getOpencodeProviderSettings, projectOpencodeModelSettings } from '@/providers/opencode/settings';

import { createOpencodeHTTPMetadataFixture, type OpencodeHTTPMetadataFixture, waitUntil } from './OpencodeHTTPMetadataFixture';

// OpenCode v2 metadata catalog discovery, refresh, and models that appear after startup.
let fixture: OpencodeHTTPMetadataFixture;

beforeEach(() => { fixture = createOpencodeHTTPMetadataFixture(); });

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
    // Selected-model warming reuses its catalog; one extra read may attach the background watcher.
    expect(Number(readFileSync(fixture.environment.ENDPOINT_FILE + '.read', 'utf8'))).toBeLessThanOrEqual(2);
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
  const catalog = JSON.parse(readFileSync(fixture.environment.CATALOG_FILE!, 'utf8'));
  catalog[0].variants = [{ id: 'low' }, { id: 'high' }];
  writeFileSync(fixture.environment.CATALOG_FILE!, JSON.stringify(catalog));
  const plugin = fixture.createPlugin();
  const service = new OpencodeMetadataService(runtimeHostFor(plugin, 'opencode'), plugin.executionLifecycleRegistry);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([
      { rawId: 'deepseek/chat', label: 'deepseek/DeepSeek Chat' },
    ]);
    catalog[0].name = 'Updated Chat';
    writeFileSync(fixture.environment.CATALOG_FILE!, JSON.stringify(catalog));
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels[0].label).toBe('deepseek/Updated Chat');
    await expect(service.discoverCommands()).resolves.toMatchObject({ loaded: true, commands: [
      { id: 'opencode-command:review', name: 'review', kind: 'command', description: 'Review changes' },
      { id: 'opencode-skill:writing', name: 'writing', kind: 'skill', description: 'Writing guide' },
    ] });
    await expect(service.warmModelMetadata('opencode:deepseek/chat')).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).thinkingOptionsByModel['deepseek/chat'])
      .toEqual([{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }, { value: 'default', label: 'Default' }]);
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

it('returns a missing requested model immediately and discovers it later while other models remain available', async () => {
  const plugin = fixture.createPlugin();
  plugin.settings.providerConfigs.opencode.visibleModels = ['acme/slow-model'];
  const service = new OpencodeMetadataService(runtimeHostFor(plugin, 'opencode'), plugin.executionLifecycleRegistry);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    await expect(service.warmModelMetadata('opencode:acme/slow-model')).resolves.toBe(false);
    addModel();
    await waitUntil(() => getOpencodeProviderSettings(plugin.settings).discoveredModels.some(model => model.rawId === 'acme/slow-model'));
    await waitUntil(() => Object.hasOwn(getOpencodeProviderSettings(plugin.settings).thinkingOptionsByModel, 'acme/slow-model'));
    expect(getOpencodeProviderSettings(plugin.settings).thinkingOptionsByModel['acme/slow-model'])
      .toEqual([{ value: 'high', label: 'High' }, { value: 'default', label: 'Default' }]);
    await expect(service.warmModelMetadata('opencode:acme/slow-model')).resolves.toBe(true);
  } finally { await service.dispose(); }
});


it('keeps observing catalog events after a transient background model read failure', async () => {
  const plugin = fixture.createPlugin();
  const service = new OpencodeMetadataService(runtimeHostFor(plugin, 'opencode'), plugin.executionLifecycleRegistry);
  let successfulReads = 0;
  let failedReads = 0;
  const request = OpencodeHTTPClient.prototype.request;
  const spy = vi.spyOn(OpencodeHTTPClient.prototype, 'request').mockImplementation(async function (this: OpencodeHTTPClient, route, options) {
    try {
      const result = await request.call(this, route, options);
      if (route === '/api/model') successfulReads++;
      return result;
    } catch (error) {
      if (route === '/api/model') failedReads++;
      throw error;
    }
  });
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    await vi.waitFor(() => expect(successfulReads).toBeGreaterThanOrEqual(2));
    writeFileSync(fixture.environment.CATALOG_FILE! + '.error', JSON.stringify({ status: 500, body: { message: 'Temporary catalog reload error' } }));
    fixture.writeCatalog('During failure');
    await vi.waitFor(() => expect(failedReads).toBeGreaterThan(0));
    const failures = failedReads;
    // Once events are available, failure alone must not start a hot retry loop.
    await yieldToIO(100);
    expect(failedReads).toBe(failures);
    rmSync(fixture.environment.CATALOG_FILE! + '.error');
    fixture.writeCatalog('Recovered catalog');
    await vi.waitFor(() => expect(getOpencodeProviderSettings(plugin.settings).discoveredModels)
      .toContainEqual({ rawId: 'deepseek/chat', label: 'deepseek/Recovered catalog' }));
  } finally { await service.dispose(); spy.mockRestore(); }
});

it('discovers models after two empty startup reads when native catalog events are absent', async () => {
  fixture.environment.NO_CATALOG_EVENTS = '1';
  fixture.environment.EMPTY_INITIAL_READS = '2';
  const plugin = fixture.createPlugin();
  const service = new OpencodeMetadataService(runtimeHostFor(plugin, 'opencode'), plugin.executionLifecycleRegistry);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([]);
    await vi.waitFor(() => expect(getOpencodeProviderSettings(plugin.settings).discoveredModels)
      .toContainEqual({ rawId: 'deepseek/chat', label: 'deepseek/DeepSeek Chat' }));
    expect(Number(readFileSync(fixture.environment.ENDPOINT_FILE! + '.read', 'utf8'))).toBeGreaterThanOrEqual(3);
    // Advance only the background deadline; its already-scheduled tick and native HTTP I/O remain real.
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    await vi.advanceTimersByTimeAsync(5_000);
    await yieldToIO(300);
    const finalReads = Number(readFileSync(fixture.environment.ENDPOINT_FILE! + '.read', 'utf8'));
    await vi.advanceTimersByTimeAsync(1_000);
    await yieldToIO(50);
    expect(Number(readFileSync(fixture.environment.ENDPOINT_FILE! + '.read', 'utf8'))).toBe(finalReads);
  } finally { vi.useRealTimers(); await service.dispose(); }
});
