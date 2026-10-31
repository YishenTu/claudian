import '@/providers';

import { FakeAuxiliaryBackend, waitFor } from '@test/helpers/core/auxiliary/AuxiliaryExecutionTestHarness';
import { assertCatalogModelAvailable, modelCatalogCases } from '@test/helpers/providerModelCatalogs';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { updateClaudeProviderSettings } from '@/providers/claude/settings';

const titleCases = modelCatalogCases.map(provider => ({
  ...provider,
  forms: {
    deepseek: ['deepseek:native/selected', 'deepseek:native/selected'],
    claude: ['sonnet', 'claude-code/sonnet'],
    codex: ['gpt-5.5', 'openai-codex/gpt-5.5'],
    grok: ['selected', 'grok/selected'],
    opencode: ['anthropic/selected', 'opencode:anthropic/selected'],
    pi: ['anthropic/selected', 'pi:anthropic/selected'],
  }[provider.id],
}));

beforeEach(() => vi.spyOn(ProviderWorkspaceRegistry, 'ensureInitialized').mockResolvedValue(undefined));
afterEach(() => vi.restoreAllMocks());

/** Runs one title generation over a fake backend; returns the requests it sent and its result callback. */
async function runTitleGeneration(host: ProviderHost, providerId: string) {
  const backend = new FakeAuxiliaryBackend();
  const createBackend = vi.spyOn(ProviderRegistry, 'createExecutionBackend').mockReturnValue(backend);
  const service = ProviderRegistry.createTitleGenerationService(host);
  const callback = vi.fn();
  const generation = service.generateTitle('conversation', 'First message', callback);
  await waitFor(() => backend.sessions.some(session => session.requests.length > 0) || callback.mock.calls.length > 0);
  const requests = backend.sessions.flatMap(session => session.requests);
  if (requests.length > 0) expect(createBackend).toHaveBeenCalledWith(host, providerId);
  for (const session of backend.sessions) { session.emitText('A title'); session.complete(); }
  await generation;
  return { requests, callback };
}

async function generateTitleModel(host: ProviderHost, providerId: string): Promise<string | undefined> {
  const { requests, callback } = await runTitleGeneration(host, providerId);
  expect(callback).toHaveBeenCalledWith('conversation', expect.objectContaining({ success: true }));
  return requests[0]?.configuration.model;
}


it.each(titleCases)('$id routes equivalent title IDs without choosing a sibling', async ({ id, forms, populate }) => {
  const { host, settings } = await createProviderHostFixture();
  populate(settings);
  for (const model of forms) {
    settings.titleGenerationModel = model;
    expect(ProviderRegistry.resolveTitleGenerationSelection(settings)?.providerId).toBe(id);
    const expectedModel = id === 'claude' ? forms[0] : forms[1];
    expect(await generateTitleModel(host, id)).toBe(expectedModel);
    expect(() => assertCatalogModelAvailable(id, host.getRuntimeHost(id), expectedModel)).not.toThrow();
    settings.titleGenerationModel = `${model}/high`;
    expect(ProviderRegistry.resolveTitleGenerationSelection(settings)).toBeNull();
    settings.titleGenerationModel = `${model}-sibling`;
    expect(ProviderRegistry.resolveTitleGenerationSelection(settings)).toBeNull();
  }
});

it.each(titleCases)('$id rejects a title model cleared after routing instead of using a default', async ({ id, forms, populate }) => {
  const { host, settings } = await createProviderHostFixture();
  populate(settings);
  settings.titleGenerationModel = forms[0];
  vi.mocked(ProviderWorkspaceRegistry.ensureInitialized).mockImplementation(async () => {
    settings.titleGenerationModel = '';
  });
  const { requests, callback } = await runTitleGeneration(host, id);
  expect(requests).toHaveLength(0);
  expect(callback).toHaveBeenCalledWith('conversation', expect.objectContaining({ success: false }));
});

it('routes plain and qualified Claude haiku selections to the same model', async () => {
  const { host, settings } = await createProviderHostFixture();
  updateClaudeProviderSettings(settings, {
    enabled: true, visibleModels: ['haiku'],
    discoveredModels: [{ value: 'haiku', label: 'Haiku', description: '' }],
  });
  for (const model of ['haiku', 'claude-code/haiku']) {
    settings.titleGenerationModel = model;
    expect(ProviderRegistry.resolveTitleGenerationSelection(settings)?.providerId).toBe('claude');
    expect(await generateTitleModel(host, 'claude')).toBe('haiku');
  }
});

it.each(titleCases)('$id preserves omitted-model execution fallback without accepting an explicit missing model', async ({ id, populate, selected }) => {
  const { host, settings } = await createProviderHostFixture({ settings: { model: selected } });
  populate(settings);
  expect(() => assertCatalogModelAvailable(id, host.getRuntimeHost(id), undefined)).not.toThrow();
  expect(() => assertCatalogModelAvailable(id, host.getRuntimeHost(id), 'missing-model')).toThrow(/unavailable/);
});
