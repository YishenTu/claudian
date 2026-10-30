import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import * as path from 'node:path';

import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { readGrokCatalog, writeGrokCatalog } from '@test/helpers/providers/grokSettings';
import spawn from 'cross-spawn';

import type { GrokDiscoveredModel } from '@/providers/grok/models';
import { GrokModelCatalogCoordinator } from '@/providers/grok/runtime/GrokModelCatalogCoordinator';
import { GrokModelDiscoveryService } from '@/providers/grok/runtime/GrokModelDiscoveryService';
import { updateGrokProviderSettings } from '@/providers/grok/settings';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const fixture = path.resolve('tests/fixtures/providers/grok/runtime/GrokModelCatalogProcess.mjs');
let children: ChildProcess[];
const coordinators: GrokModelCatalogCoordinator[] = [];

beforeEach(() => {
  children = [];
  vi.mocked(spawn).mockImplementation((_command, args, options) => {
    const child = nodeSpawn(process.execPath, [fixture, ...(args ?? [])], options ?? {});
    children.push(child);
    return child;
  });
});
afterEach(async () => {
  await Promise.all(coordinators.splice(0).map(coordinator => coordinator.dispose()));
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  vi.mocked(spawn).mockReset();
});

function makeModel(rawId: string, displayName = rawId): GrokDiscoveredModel {
  return { displayName, rawId, reasoningEfforts: [], supportsReasoning: false };
}
function makeCatalog(overrides: Partial<NonNullable<ReturnType<typeof readGrokCatalog>>> = {}) {
  return { defaultModelId: 'kimi-coding', fingerprint: 'fingerprint-current',
    models: [makeModel('kimi-coding', 'Kimi')], refreshedAt: Date.now(), ...overrides };
}
async function makeHost(options: { catalog?: ReturnType<typeof makeCatalog>; visibleModels?: string[]; scenario?: string } = {}) {
  const settings = structuredClone(DEFAULT_CLAUDIAN_SETTINGS);
  updateGrokProviderSettings(settings, { enabled: true, visibleModels: options.visibleModels ?? null, environmentVariables: `GROK_CATALOG_SCENARIO=${options.scenario ?? ''}` });
  if (options.catalog) writeGrokCatalog(settings, options.catalog);
  const persist = vi.fn(async () => undefined);
  const fixture = await createProviderHostFixture({ settings, beforePersist: persist,
    overrides: { workingDirectory: process.cwd(), getResolvedProviderCliPath: async () => 'fixture-grok' } });
  const runtime = fixture.host.getRuntimeHost('grok');
  const coordinator = new GrokModelCatalogCoordinator(runtime, new GrokModelDiscoveryService(runtime));
  coordinators.push(coordinator);
  return { settings: fixture.settings, coordinator, persist };
}

it('merges richer live ACP metadata by raw id and preserves CLI-only models', async () => {
    const host = await makeHost({
      catalog: makeCatalog({
        models: [makeModel('kimi-coding', 'kimi-coding'), makeModel('glm-coding', 'GLM')],
      }),
    });
    const coordinator = host.coordinator;

    await expect(coordinator.mergeLiveModels([{
      agentType: 'coding',
      contextWindow: 262_144,
      description: 'Rich live metadata',
      displayName: 'Kimi Coding',
      rawId: 'kimi-coding',
      reasoningEfforts: [{ label: 'High', value: 'high' }],
      supportsReasoning: true,
    }])).resolves.toEqual({
      changed: true,
      persistedSettingsChanged: true,
    });

    expect(readGrokCatalog(host.settings)?.models).toEqual([
      expect.objectContaining({
        agentType: 'coding',
        contextWindow: 262_144,
        displayName: 'Kimi Coding',
        rawId: 'kimi-coding',
      }),
      expect.objectContaining({ rawId: 'glm-coding' }),
    ]);
  });

it('retains live ACP reasoning metadata for models available for selection', async () => {
    const host = await makeHost({
      catalog: makeCatalog({
        models: [makeModel('kimi-coding', 'Kimi'), {
          displayName: 'GLM',
          rawId: 'glm-coding',
          reasoningEfforts: [{ label: 'High', value: 'high' }],
          reasoningMetadataResolved: true,
          supportsReasoning: true,
        }],
      }),
      visibleModels: ['kimi-coding'],
    });
    const coordinator = host.coordinator;

    await coordinator.mergeLiveModels([{
      displayName: 'Kimi',
      rawId: 'kimi-coding',
      reasoningEfforts: [{ label: 'High', value: 'high' }],
      reasoningMetadataResolved: true,
      supportsReasoning: true,
    }, {
      displayName: 'GLM',
      rawId: 'glm-coding',
      reasoningEfforts: [{ label: 'High', value: 'high' }],
      reasoningMetadataResolved: true,
      supportsReasoning: true,
    }]);

    expect(readGrokCatalog(host.settings)?.models).toEqual([
      expect.objectContaining({
        rawId: 'kimi-coding',
        reasoningMetadataResolved: true,
      }),
      expect.objectContaining({
        rawId: 'glm-coding',
        reasoningEfforts: [{ label: 'High', value: 'high' }],
        reasoningMetadataResolved: true,
        supportsReasoning: true,
      }),
    ]);
  });
it('deduplicates concurrent refreshes through native discovery and durable publication', async () => {
  const host = await makeHost();
  const [first, second] = await Promise.all([host.coordinator.refresh(), host.coordinator.refresh()]);
  expect(first).toEqual(second);
  expect(readGrokCatalog(host.settings)?.models.map(model => model.rawId)).toEqual(['grok-4.6', 'grok-4.5']);
  expect(host.persist).toHaveBeenCalledTimes(1);
  // One version process and one ACP probe: duplicate refreshes must not launch peers twice.
  expect(children).toHaveLength(2);
  expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
});

it('replaces live-only models and the live default on refresh while retaining surviving metadata', async () => {
  const host = await makeHost({ scenario: 'legacy-catalog', catalog: makeCatalog({ models: [makeModel('model-a'), makeModel('removed-model')] }) });
  await host.coordinator.mergeLiveModels([{
    agentType: 'coding', contextWindow: 262_144, defaultReasoningEffort: 'high',
    description: 'Enriched by live ACP', displayName: 'Model A Coding', rawId: 'model-a',
    reasoningEfforts: [{ description: 'Deep reasoning', label: 'High', value: 'high' }], supportsReasoning: true,
  }, makeModel('live-only')], 'live-only');
  expect(readGrokCatalog(host.settings)?.defaultModelId).toBe('live-only');
  await host.coordinator.refresh();
  const catalog = readGrokCatalog(host.settings);
  expect(catalog?.defaultModelId).toBe('new-model');
  expect(catalog?.models.map(model => model.rawId)).toEqual(['new-model', 'model-a']);
  expect(catalog?.models[1]).toMatchObject({
    agentType: 'coding', contextWindow: 262_144, defaultReasoningEffort: 'high',
    description: 'Enriched by live ACP', displayName: 'Model A Coding', rawId: 'model-a',
    reasoningEfforts: [{ description: 'Deep reasoning', label: 'High', value: 'high' }], supportsReasoning: true,
  });
  expect(catalog?.models[0]).toMatchObject({ displayName: 'new-model', rawId: 'new-model', reasoningEfforts: [], supportsReasoning: false });
  expect(catalog?.fingerprint).not.toBe('fingerprint-current');
  expect(host.persist).toHaveBeenCalledTimes(2);
});
