import '@/providers';

import { modelCatalogCases } from '@test/helpers/providerModelCatalogs';
import { FakeAuxiliaryBackend, waitFor } from '@test/unit/core/auxiliary/AuxiliaryExecutionTestHarness';

import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { assertClaudeModelAvailable } from '@/providers/claude/runtime/ClaudeModelAvailability';
import { updateClaudeProviderSettings } from '@/providers/claude/settings';
import { assertCodexModelAvailable } from '@/providers/codex/runtime/CodexModelAvailability';
import { assertGrokModelAvailable } from '@/providers/grok/runtime/GrokModelAvailability';
import { assertOpencodeModelAvailable } from '@/providers/opencode/runtime/OpencodeModelAvailability';
import { assertPiModelAvailable } from '@/providers/pi/runtime/PiModelAvailability';

const executionGuards = {
  claude: assertClaudeModelAvailable, codex: assertCodexModelAvailable, grok: assertGrokModelAvailable,
  opencode: assertOpencodeModelAvailable, pi: assertPiModelAvailable,
};

const titleCases = modelCatalogCases.map(provider => ({
  ...provider,
  forms: {
    claude: ['sonnet', 'claude-code/sonnet'],
    codex: ['gpt-5.5', 'openai-codex/gpt-5.5'],
    grok: ['selected', 'grok/selected'],
    opencode: ['anthropic/selected', 'opencode:anthropic/selected'],
    pi: ['anthropic/selected', 'pi:anthropic/selected'],
  }[provider.id],
}));

afterEach(() => jest.restoreAllMocks());

async function generateTitleModel(settings: Record<string, unknown>, providerId: string): Promise<string | undefined> {
  const backend = new FakeAuxiliaryBackend();
  jest.spyOn(ProviderRegistry, 'createExecutionBackend').mockReturnValue(backend);
  const lifecycle = new ProviderExecutionLifecycleRegistry();
  const host = {
    settings, app: { vault: { adapter: { basePath: '/vault' } } }, executionLifecycleRegistry: lifecycle,
  } as unknown as ProviderHost;
  const service = ProviderRegistry.createTitleGenerationService(host, providerId);
  const callback = jest.fn();
  const generation = service.generateTitle('conversation', 'First message', callback);
  await waitFor(() => backend.sessions.some(session => session.requests.length > 0) || callback.mock.calls.length > 0);
  const model = backend.sessions.flatMap(session => session.requests)[0]?.configuration.model;
  for (const session of backend.sessions) { session.emitText('A title'); session.complete(); }
  await generation;
  await lifecycle.dispose();
  expect(callback).toHaveBeenCalledWith('conversation', expect.objectContaining({ success: true }));
  return model;
}


it.each(titleCases)('$id routes equivalent title IDs without choosing a sibling', async ({ id, forms, populate }) => {
  const settings: Record<string, unknown> = {};
  populate(settings);
  for (const model of forms) {
    settings.titleGenerationModel = model;
    expect(ProviderRegistry.resolveTitleGenerationSelection(settings)?.providerId).toBe(id);
    const expectedModel = id === 'claude' ? forms[0] : forms[1];
    expect(await generateTitleModel(settings, id)).toBe(expectedModel);
    expect(() => executionGuards[id](settings, expectedModel)).not.toThrow();
    settings.titleGenerationModel = `${model}/high`;
    expect(ProviderRegistry.resolveTitleGenerationSelection(settings)).toBeNull();
    settings.titleGenerationModel = `${model}-sibling`;
    expect(ProviderRegistry.resolveTitleGenerationSelection(settings)).toBeNull();
  }
});

it.each(titleCases)('$id rejects a title model cleared after routing instead of using a default', async ({ id, populate }) => {
  const settings: Record<string, unknown> = {};
  populate(settings);
  settings.titleGenerationModel = '';
  const backend = new FakeAuxiliaryBackend();
  jest.spyOn(ProviderRegistry, 'createExecutionBackend').mockReturnValue(backend);
  const lifecycle = new ProviderExecutionLifecycleRegistry();
  const host = {
    settings,
    app: { vault: { adapter: { basePath: '/vault' } } },
    executionLifecycleRegistry: lifecycle,
  } as unknown as ProviderHost;
  const service = ProviderRegistry.createTitleGenerationService(host, id);
  const callback = jest.fn();
  const generation = service.generateTitle('conversation', 'First message', callback);
  await waitFor(() => backend.sessions.some(session => session.requests.length > 0) || callback.mock.calls.length > 0);
  const requests = backend.sessions.flatMap(session => session.requests);
  for (const session of backend.sessions) {
    session.emitText('A title');
    session.complete();
  }
  await generation;
  await lifecycle.dispose();
  expect(requests).toHaveLength(0);
  expect(callback).toHaveBeenCalledWith('conversation', expect.objectContaining({ success: false }));
});

it('routes plain and qualified Claude haiku selections to the same model', async () => {
  const settings: Record<string, unknown> = {};
  updateClaudeProviderSettings(settings, {
    enabled: true, visibleModels: ['haiku'],
    discoveredModels: [{ value: 'haiku', label: 'Haiku', description: '' }],
  });
  for (const model of ['haiku', 'claude-code/haiku']) {
    settings.titleGenerationModel = model;
    expect(ProviderRegistry.resolveTitleGenerationSelection(settings)?.providerId).toBe('claude');
    expect(await generateTitleModel(settings, 'claude')).toBe('haiku');
  }
});

it.each(titleCases)('$id preserves omitted-model execution fallback without accepting an explicit missing model', ({ id, populate, selected }) => {
  const settings: Record<string, unknown> = { model: selected };
  populate(settings);
  expect(() => executionGuards[id](settings, undefined)).not.toThrow();
  expect(() => executionGuards[id](settings, 'missing-model')).toThrow(/unavailable/);
});
