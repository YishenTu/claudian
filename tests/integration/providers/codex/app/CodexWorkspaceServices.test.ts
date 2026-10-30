import '@/providers';

import { TEST_CODEX_CATALOG, TEST_CODEX_MODEL } from '@test/helpers/codexModels';
import { CodexRuntimeHarness } from '@test/helpers/providers/codex/CodexRuntimeHarness';
import { createCodexWorkspaceHarness } from '@test/helpers/providers/codex/CodexWorkspaceHarness';
import { testClock } from '@test/helpers/testClock';

import { getCodexProviderSettings } from '@/providers/codex/settings';

const mockNative = new CodexRuntimeHarness();
vi.mock('cross-spawn', () => ({ default: vi.fn(() => mockNative.createProcess()) }));

const fixtures: Awaited<ReturnType<typeof createCodexWorkspaceHarness>>[] = [];
async function create(config: Record<string, unknown> = {}) {
  const fixture = await createCodexWorkspaceHarness(config);
  fixture.resolveCliPath.mockResolvedValue('/native/codex');
  fixtures.push(fixture);
  return fixture;
}
const wireModel = {
  id: TEST_CODEX_MODEL, model: TEST_CODEX_MODEL, displayName: 'GPT-5.5', description: 'Native model',
  supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Deep' }], defaultReasoningEffort: 'high',
  serviceTiers: [], defaultServiceTier: null, inputModalities: ['text', 'image'], isDefault: true,
};
beforeEach(() => {
  const clock = testClock();
  vi.spyOn(Date, 'now').mockImplementation(() => clock().getTime());
  mockNative.reset(); mockNative.autoReconcile = true;
  mockNative.requestOverride = (process, rpc) => {
    if (rpc.method !== 'model/list') return false;
    process.respond(rpc.id, { data: [wireModel], nextCursor: null });
    return true;
  };
});
afterEach(async () => { await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose())); vi.restoreAllMocks(); });

it('defers discovery until refresh, persists native metadata and keeps explicit selected IDs', async () => {
  const h = await create({ discoveredModels: [], visibleModels: ['retired-model', TEST_CODEX_MODEL] });
  expect(mockNative.processes).toEqual([]);
  expect(h.saves).toEqual([]);
  await h.services.modelCatalog!.refresh({ force: true });
  expect(mockNative.processes).toHaveLength(1);
  expect(mockNative.processes[0].requests.filter(rpc => rpc.method === 'model/list')).toHaveLength(1);
  expect(getCodexProviderSettings(h.settings).discoveredModels).toEqual([{
    model: TEST_CODEX_MODEL, displayName: 'GPT-5.5', description: 'Native model',
    supportedReasoningEfforts: [{ value: 'high', description: 'Deep' }], defaultReasoningEffort: 'high',
    serviceTiers: [], defaultServiceTier: null, inputModalities: ['text', 'image'], isDefault: true,
  }]);
  expect(getCodexProviderSettings(h.settings).visibleModels).toEqual(['retired-model', TEST_CODEX_MODEL]);
  expect(h.settings.model).toBe(`openai-codex/${TEST_CODEX_MODEL}`);
  expect(h.saves).toHaveLength(1);
  expect(getCodexProviderSettings(h.saves[0]).discoveredModels).toEqual(getCodexProviderSettings(h.settings).discoveredModels);
  expect(getCodexProviderSettings(await h.settingsStorage.load()).discoveredModels).toEqual(getCodexProviderSettings(h.settings).discoveredModels);
});

it('publishes real selection normalization even when native catalog metadata is unchanged', async () => {
  const h = await create();
  await h.services.modelCatalog!.refresh({ force: true });
  h.saves.length = 0; h.notifications.length = 0;
  await expect(h.services.modelCatalog!.refresh({ force: true })).resolves.toEqual({ changed: false });
  expect(h.saves).toEqual([]); expect(h.notifications).toEqual([]);
  h.settings.model = TEST_CODEX_MODEL;
  await expect(h.services.modelCatalog!.refresh({ force: true })).resolves.toEqual({ changed: true });
  expect(h.settings.model).toBe(`openai-codex/${TEST_CODEX_MODEL}`);
  expect(h.saves).toHaveLength(1);
  expect(h.notifications).toEqual(['codex']);
});

it.each(['disabled', 'disposed'] as const)('does not discover or persist for a %s workspace catalog', async state => {
  const h = await create({ enabled: state !== 'disabled' });
  if (state === 'disposed') await h.services.dispose();
  await expect(h.services.modelCatalog!.refresh({ force: true })).resolves.toEqual({ changed: false });
  expect(getCodexProviderSettings(h.settings).discoveredModels).toEqual(TEST_CODEX_CATALOG);
  expect(mockNative.processes).toEqual([]);
  expect(h.saves).toEqual([]);
});

it('preserves the last catalog and surfaces a native discovery failure', async () => {
  const h = await create();
  mockNative.requestOverride = (process, rpc) => {
    if (rpc.method !== 'model/list') return false;
    process.stdout.write(`${JSON.stringify({ id: rpc.id, error: { code: -32601, message: 'Method not found' } })}\n`);
    return true;
  };
  await expect(h.services.modelCatalog!.refresh({ force: true })).resolves.toEqual({ changed: false, diagnostics: 'Method not found' });
  expect(getCodexProviderSettings(h.settings).discoveredModels).toEqual(TEST_CODEX_CATALOG);
  expect(h.saves).toEqual([]);
});

it('refreshes native skills on an agent-skill change without eagerly listing during construction', async () => {
  const h = await create();
  expect(mockNative.processes).toEqual([]);
  await h.services.onAgentSkillsChanged?.();
  const process = mockNative.processes[0];
  expect(process.requests.filter(rpc => rpc.method === 'skills/list').map(rpc => rpc.params)).toEqual([{ cwds: [h.vault.root], forceReload: true }]);
  expect(await h.services.commandCatalog.listDropdownEntries({ includeBuiltIns: false })).toEqual([expect.objectContaining({ name: 'remote-skill' })]);
  expect(process.requests.filter(rpc => rpc.method === 'thread/start')).toEqual([]);
});

it('blocks metadata during a workspace transition and reads only the new native environment', async () => {
  const h = await create();
  let startMutation!: () => void;
  let finishMutation!: () => void;
  const entered = new Promise<void>(resolve => { startMutation = resolve; });
  const held = new Promise<void>(resolve => { finishMutation = resolve; });
  const transition = h.registry.runTransition(['codex'], async () => { startMutation(); await held; h.settings.providerConfigs.codex!.environmentVariables = 'KEY=new'; });
  await entered;
  const modelRefresh = h.services.modelCatalogCoordinator.refresh();
  const skillListing = h.services.commandCatalog.listDropdownEntries({ includeBuiltIns: false });
  let settled = false;
  void Promise.all([modelRefresh, skillListing]).then(() => { settled = true; });
  try {
    await Promise.resolve();
    expect(mockNative.processes).toEqual([]);
    expect(settled).toBe(false);
    h.settings.providerConfigs.codex!.environmentVariables = 'KEY=new';
    await h.services.modelCatalogCoordinator.refresh({ providerTransitionOwner: true });
    expect(mockNative.processes).toHaveLength(1);
    expect(mockNative.processes[0].requests.filter(rpc => rpc.method === 'skills/list')).toEqual([]);
    expect(settled).toBe(false);
  } finally {
    finishMutation(); await transition;
    await Promise.all([modelRefresh, skillListing]);
  }
  expect(mockNative.processes).toHaveLength(1);
  expect(mockNative.processes[0].requests.filter(rpc => rpc.method === 'model/list')).toHaveLength(2);
  expect(await skillListing).toEqual([expect.objectContaining({ name: 'remote-skill' })]);
});

async function startHeldMetadata() {
  const h = await create();
  mockNative.requestOverride = (_process, rpc) => rpc.method === 'model/list' || rpc.method === 'skills/list';
  const settled = { models: false, skills: false };
  const models = h.services.modelCatalogCoordinator.refresh().finally(() => { settled.models = true; });
  const skills = h.services.commandCatalog.listDropdownEntries({ includeBuiltIns: false }).catch(() => []).finally(() => { settled.skills = true; });
  const process = await mockNative.waitForRequest('model/list');
  await mockNative.waitForRequest('skills/list');
  expect(settled).toEqual({ models: false, skills: false });
  return { ...h, settled, process, outcome: Promise.all([models, skills]) };
}

it('joins native model and skill cancellation before admitting a workspace transition', async () => {
  const h = await startHeldMetadata();
  await h.registry.runTransition(['codex'], async () => {
    expect(h.settled).toEqual({ models: true, skills: true });
  });
  await h.outcome;
  mockNative.requestOverride = null;
  expect(await h.services.commandCatalog.listDropdownEntries({ includeBuiltIns: false })).toEqual([expect.objectContaining({ name: 'remote-skill' })]);
});

it('joins metadata disposal once and unregisters its transition hook without restarting the server', async () => {
  const h = await startHeldMetadata();
  const first = h.services.dispose();
  expect(h.services.dispose()).toBe(first);
  await first;
  expect(h.settled).toEqual({ models: true, skills: true });
  expect(h.process.isAlive()).toBe(false);
  await h.registry.runTransition(['codex'], async () => undefined);
  expect(mockNative.processes).toHaveLength(1);
  await h.outcome;
});
