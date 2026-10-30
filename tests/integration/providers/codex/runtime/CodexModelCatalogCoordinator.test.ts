import '@/providers';

import { CodexRuntimeHarness } from '@test/helpers/providers/codex/CodexRuntimeHarness';
import { createCodexWorkspaceHarness } from '@test/helpers/providers/codex/CodexWorkspaceHarness';

import { createCodexModelCatalogCommit } from '@/providers/codex/app/CodexWorkspaceServices';
import { CodexModelCatalogCoordinator } from '@/providers/codex/runtime/CodexModelCatalogCoordinator';
import type { CodexModelDiscoveryResult } from '@/providers/codex/runtime/CodexModelDiscoveryService';
import { CodexModelDiscoveryService } from '@/providers/codex/runtime/CodexModelDiscoveryService';
import { getCodexProviderSettings } from '@/providers/codex/settings';

const native = new CodexRuntimeHarness();
vi.mock('cross-spawn', () => ({ default: vi.fn(() => native.createProcess()) }));
let fixture: Awaited<ReturnType<typeof createCodexWorkspaceHarness>>;
let catalog: CodexModelCatalogCoordinator;
beforeEach(async () => {
  native.reset(); native.autoReconcile = true;
  native.requestOverride = (_process, request) => request.method === 'model/list';
  fixture = await createCodexWorkspaceHarness({ discoveredModels: [], environmentVariables: 'OPENAI_API_KEY=secret' });
  fixture.resolveCliPath.mockResolvedValue('/native/codex');
  catalog = fixture.services.modelCatalogCoordinator;
});
afterEach(async () => { await fixture.dispose(); vi.restoreAllMocks(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}
function wireModel(id: string) {
  return { id, model: id, displayName: `${id} name`, description: `${id} description`,
    supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }], defaultReasoningEffort: 'medium',
    serviceTiers: [], defaultServiceTier: null, inputModalities: ['text' as const, 'image' as const], isDefault: false };
}
async function answer(id: string, count = 1) {
  const process = await native.waitForRequest('model/list', 0, count);
  const request = process.requests.filter(request => request.method === 'model/list')[count - 1];
  process.respond(request.id, { data: [wireModel(id)], nextCursor: null });
}
function modelIDs() { return getCodexProviderSettings(fixture.settings).discoveredModels.map(model => model.model); }
async function savedIDs() { return getCodexProviderSettings(await fixture.settingsStorage.load()).discoveredModels.map(model => model.model); }

async function holdSettingsQueue() {
  const gate = deferred<void>(); const entered = deferred<void>();
  const blocker = fixture.coordinator.mutateConditionally(async () => { entered.resolve(); await gate.promise; return false; });
  await entered.promise;
  let count = 0;
  const observers = new Set<() => void>();
  const mutate = fixture.host.mutateSettingsConditionally.bind(fixture.host);
  vi.spyOn(fixture.host, 'mutateSettingsConditionally').mockImplementation(mutation => {
    const result = mutate(mutation);
    count++; for (const observe of observers) observe();
    return result;
  });
  return {
    queued(expected: number) {
      return new Promise<void>(resolve => {
        const observe = () => { if (count >= expected) { observers.delete(observe); resolve(); } };
        observers.add(observe); observe();
      });
    },
    async release() { gate.resolve(); await blocker; },
  };
}

it('deduplicates concurrent native refreshes and persists their normalized catalog once', async () => {
  const first = catalog.refresh(); const second = catalog.refresh();
  await answer('gpt-4o');
  const results = await Promise.all([first, second]);
  expect(results[0].models).toEqual(results[1].models);
  expect(modelIDs()).toEqual(['gpt-4o']);
  expect(await savedIDs()).toEqual(['gpt-4o']);
  expect(native.processes[0].requests.filter(request => request.method === 'model/list')).toHaveLength(1);
  expect(fixture.saves).toHaveLength(1);
});

it('rejects a discovery result captured before the environment changes', async () => {
  const refresh = catalog.refresh();
  await native.waitForRequest('model/list');
  fixture.settings.providerConfigs.codex!.environmentVariables = 'OPENAI_API_KEY=rotated';
  await answer('stale-model');
  await refresh;
  expect(modelIDs()).toEqual([]);
  expect(getCodexProviderSettings(fixture.settings).catalogFingerprint).toBe('');
  expect(fixture.saves).toEqual([]);
});

it('rejects a queued old catalog after an owner refresh supersedes its generation', async () => {
  const queue = await holdSettingsQueue();
  const old = catalog.refresh();
  let owner: ReturnType<typeof catalog.refresh> | undefined;
  try {
    await answer('old-model'); await queue.queued(1);
    owner = catalog.refresh({ providerTransitionOwner: true });
    await answer('new-model', 2); await queue.queued(2);
  } finally { await queue.release(); }
  await Promise.all([old, owner]);
  expect(modelIDs()).toEqual(['new-model']);
  expect(await savedIDs()).toEqual(['new-model']);
  expect(fixture.saves).toHaveLength(1);
  expect(fixture.notifications).toEqual(['codex']);
});

it.each(['disposal', 'environment change'] as const)('rejects a queued catalog write after %s', async invalidation => {
  const queue = await holdSettingsQueue();
  const refresh = catalog.refresh();
  let disposal: Promise<void> | undefined;
  try {
    await answer('stale-model'); await queue.queued(1);
    if (invalidation === 'disposal') disposal = catalog.dispose();
    else fixture.settings.providerConfigs.codex!.environmentVariables = 'OPENAI_API_KEY=rotated';
  } finally { await queue.release(); }
  await Promise.all([refresh, disposal]);
  expect(modelIDs()).toEqual([]);
  expect(fixture.saves).toEqual([]);
  expect(fixture.notifications).toEqual([]);
});

it('skips discovery when canceled before launch context resolves', async () => {
  const cli = deferred<string>(); const entered = deferred<void>();
  fixture.resolveCliPath.mockImplementationOnce(() => { entered.resolve(); return cli.promise; });
  const refresh = catalog.refresh();
  await entered.promise; catalog.cancel(); cli.resolve('/native/codex');
  expect(await refresh).toMatchObject({ kind: 'skipped', refreshed: false });
  expect(native.processes).toEqual([]);
});

it('blocks native discovery during a transition and uses the newly committed environment after it', async () => {
  catalog.beginEnvironmentTransition(); await catalog.quiesceForEnvironmentChange();
  const refresh = catalog.refresh();
  expect(native.processes).toEqual([]);
  await fixture.host.mutateSettings(draft => { draft.providerConfigs.codex!.environmentVariables = 'OPENAI_API_KEY=updated'; });
  catalog.endEnvironmentTransition();
  await answer('new-environment-model');
  expect(await refresh).toMatchObject({ kind: 'completed' });
  expect(modelIDs()).toEqual(['new-environment-model']);
  const { default: spawn } = await import('cross-spawn');
  expect(vi.mocked(spawn).mock.calls.at(-1)![2]?.env?.OPENAI_API_KEY).toBe('updated');
});

it('releases blocked requests on disposal and rejects later refreshes without starting native discovery', async () => {
  catalog.beginEnvironmentTransition();
  const refresh = catalog.refresh();
  await catalog.dispose();
  expect(await refresh).toMatchObject({ kind: 'skipped' });
  expect(await catalog.refresh()).toMatchObject({ kind: 'skipped' });
  expect(native.processes).toEqual([]);
  expect(fixture.saves).toEqual([]);
});

// Deliberate discovery faults: native cancellation is normally prompt, so these two
// cases replace that operation with one that ignores cancellation to check owner draining.
function uncooperativeDiscovery() {
  const discovery = new CodexModelDiscoveryService(fixture.host.getRuntimeHost('codex'), fixture.services.runtime);
  const result = deferred<CodexModelDiscoveryResult>();
  const started = deferred<AbortSignal>();
  vi.spyOn(discovery, 'discoverModels').mockImplementationOnce(signal => {
    if (!signal) throw new Error('Discovery must receive cancellation');
    started.resolve(signal);
    return result.promise;
  });
  const coordinator = new CodexModelCatalogCoordinator(
    fixture.host.getRuntimeHost('codex'), discovery, createCodexModelCatalogCommit(fixture.host),
  );
  return { coordinator, result, started };
}

it('aborts and joins discovery that ignores cancellation without publishing its stale catalog', async () => {
  fixture.settings.providerConfigs.codex!.discoveredModels = [{ ...wireModel('cached-model'), supportedReasoningEfforts: [{ value: 'medium', description: 'Balanced' }] }];
  const fault = uncooperativeDiscovery();
  const refresh = fault.coordinator.refresh();
  const signal = await fault.started.promise;
  let settled = false;
  const quiesce = fault.coordinator.quiesceForEnvironmentChange().then(() => { settled = true; });
  expect(signal.aborted).toBe(true);
  const ready = await fixture.services.runtime.acquire({ readiness: 'initialized' });
  await ready.release();
  expect(settled).toBe(false);
  fault.result.resolve({ kind: 'completed', models: [{ ...wireModel('stale-model'), supportedReasoningEfforts: [{ value: 'medium', description: 'Balanced' }] }] });
  await Promise.all([quiesce, refresh]);
  expect(settled).toBe(true);
  expect(modelIDs()).toEqual(['cached-model']);
  expect(fixture.saves).toEqual([]);
  await fault.coordinator.dispose();
});

it('admits a new native caller while canceled discovery drains and never publishes the late result', async () => {
  const fault = uncooperativeDiscovery();
  const old = fault.coordinator.refresh();
  await fault.started.promise;
  fault.coordinator.cancel();
  const replacement = fault.coordinator.refresh();
  await answer('fresh-model'); await replacement;
  expect(modelIDs()).toEqual(['fresh-model']);
  let disposed = false;
  const disposal = fault.coordinator.dispose().then(() => { disposed = true; });
  const ready = await fixture.services.runtime.acquire({ readiness: 'initialized' });
  await ready.release();
  expect(disposed).toBe(false);
  fault.result.resolve({ kind: 'completed', models: [{ ...wireModel('obsolete-model'), supportedReasoningEfforts: [{ value: 'medium', description: 'Balanced' }] }] });
  await Promise.all([old, disposal]);
  expect(modelIDs()).toEqual(['fresh-model']);
  expect(await savedIDs()).toEqual(['fresh-model']);
  expect(fixture.notifications).toEqual(['codex']);
});
