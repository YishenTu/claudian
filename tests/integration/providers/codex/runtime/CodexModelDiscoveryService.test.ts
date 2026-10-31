import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { CodexRuntimeHarness } from '@test/helpers/providers/codex/CodexRuntimeHarness';

import { CodexAppServerRuntime } from '@/providers/codex/runtime/CodexAppServerRuntime';
import { CodexModelDiscoveryService } from '@/providers/codex/runtime/CodexModelDiscoveryService';

const native = new CodexRuntimeHarness();
let launchError: Error | undefined;
vi.mock('cross-spawn', () => ({ default: vi.fn(() => native.createProcess()) }));
let vault: DesktopVault;
let fixture: Awaited<ReturnType<typeof createProviderHostFixture>>;
let runtime: CodexAppServerRuntime;
let discovery: CodexModelDiscoveryService;
beforeAll(async () => { vault = await DesktopVault.create(); });
afterAll(async () => { await vault.dispose(); });
beforeEach(async () => {
  native.reset(); launchError = undefined;
  fixture = await createProviderHostFixture({
    vault, settings: { providerConfigs: { codex: { enabled: true } } },
    overrides: { getResolvedProviderCliPath: async () => {
      if (launchError) throw launchError;
      return '/native/codex';
    } },
  });
  const host = fixture.host.getRuntimeHost('codex');
  runtime = new CodexAppServerRuntime(host, () => undefined);
  discovery = new CodexModelDiscoveryService(host, runtime);
});
afterEach(async () => { await runtime.dispose(); });

function model(id: string, isDefault = false) {
  return { id, model: id, displayName: id, description: `${id} description`, hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
    defaultReasoningEffort: 'medium', inputModalities: ['text', 'image'], supportsPersonality: false,
    serviceTiers: [], defaultServiceTier: null, isDefault };
}

async function expectLeaseReleased() {
  const old = native.processes[0];
  fixture.settings.providerConfigs.codex!.environmentVariables = 'KEY=replacement';
  const replacement = await runtime.acquire({ readiness: 'initialized' });
  expect(old.isAlive()).toBe(false);
  expect(native.processes[1].isAlive()).toBe(true);
  await replacement.release();
}

it('does not launch Codex when disabled or already canceled', async () => {
  fixture.settings.providerConfigs.codex!.enabled = false;
  expect(await discovery.discoverModels()).toEqual({ kind: 'skipped', reason: 'provider-disabled' });
  fixture.settings.providerConfigs.codex!.enabled = true;
  const controller = new AbortController(); controller.abort();
  expect(await discovery.discoverModels(controller.signal)).toEqual({ kind: 'completed', diagnostics: 'Codex model discovery was cancelled', models: [] });
  expect(native.processes).toEqual([]);
});

it('loads and normalizes every native model page without retaining a server lease', async () => {
  native.requestOverride = (process, request) => {
    if (request.method !== 'model/list') return false;
    const second = request.params.cursor === 'page-2';
    process.respond(request.id, { data: [model(second ? 'gpt-5.6-luna' : 'gpt-5.6-sol', !second)], nextCursor: second ? null : 'page-2' });
    return true;
  };
  const result = await discovery.discoverModels();
  expect(result).toEqual({ kind: 'completed', models: [
    expect.objectContaining({ model: 'gpt-5.6-sol', supportedReasoningEfforts: [{ value: 'medium', description: 'Balanced' }], isDefault: true }),
    expect.objectContaining({ model: 'gpt-5.6-luna', isDefault: false }),
  ] });
  expect(native.processes[0].requests.filter(request => request.method === 'model/list').map(request => request.params)).toEqual([
    { includeHidden: false, limit: 100 }, { cursor: 'page-2', includeHidden: false, limit: 100 },
  ]);
  await expectLeaseReleased();
});

it('surfaces native error and stderr diagnostics without retaining the failed lease', async () => {
  native.requestOverride = (process, request) => {
    if (request.method !== 'model/list') return false;
    process.stderr.write('codex app-server stderr');
    process.respondError(request.id, 'Method not found', -32601);
    return true;
  };
  expect(await discovery.discoverModels()).toEqual({ kind: 'completed', diagnostics: 'Method not found\n\ncodex app-server stderr', models: [] });
  await expectLeaseReleased();
});

it('returns launch diagnostics before creating a native process', async () => {
  launchError = new Error('Unable to determine the WSL distro');
  expect(await discovery.discoverModels()).toEqual({ kind: 'completed', diagnostics: 'Unable to determine the WSL distro', models: [] });
  expect(native.processes).toEqual([]);
});

it('cancels only its discovery request and leaves the shared server available', async () => {
  native.requestOverride = (_process, request) => request.method === 'model/list';
  const controller = new AbortController();
  const pending = discovery.discoverModels(controller.signal);
  const process = await native.waitForRequest('model/list');
  controller.abort();
  expect(await pending).toEqual({ kind: 'completed', diagnostics: 'Codex model discovery was cancelled', models: [] });
  expect(process.isAlive()).toBe(true);
  native.requestOverride = null;
  expect(await discovery.discoverModels()).toEqual({ kind: 'completed', models: [] });
  expect(native.processes).toHaveLength(1);
  await expectLeaseReleased();
});

it('rejects repeated native cursors without publishing a partial catalog or retaining its lease', async () => {
  native.requestOverride = (process, request) => {
    if (request.method !== 'model/list') return false;
    process.respond(request.id, { data: [model('model')], nextCursor: 'same' });
    return true;
  };
  expect(await discovery.discoverModels()).toEqual({ kind: 'completed', diagnostics: 'Codex model/list returned a repeated cursor', models: [] });
  expect(native.processes[0].requests.filter(request => request.method === 'model/list')).toHaveLength(2);
  await expectLeaseReleased();
});
