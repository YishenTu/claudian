import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as yieldToIO } from 'node:timers/promises';

import { testDate } from '@test/helpers/testClock';

import { OpencodeCommandLoader } from '@/providers/opencode/app/OpencodeCommandLoader';
import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';
import { OpencodeHTTPMetadataProbe } from '@/providers/opencode/metadata/OpencodeHTTPMetadataProbe';
import { OpencodeMetadataService } from '@/providers/opencode/metadata/OpencodeMetadataService';
import { assertOpencodeModelAvailable } from '@/providers/opencode/runtime/OpencodeModelAvailability';
import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from '@/providers/opencode/settings';

import { createOpencodeHTTPMetadataFixture, type OpencodeHTTPMetadataFixture, waitUntil } from './OpencodeHTTPMetadataFixture';

// OpenCode v2 metadata readiness: loopback validation, the optional integration endpoint, and account activation.
let fixture: OpencodeHTTPMetadataFixture;

beforeEach(() => { fixture = createOpencodeHTTPMetadataFixture(); });

afterEach(() => fixture.dispose());

it('rejects a non-loopback readiness endpoint before sending authorization', async () => {
  const servers = new OpencodeServerService();
  const probe = new OpencodeHTTPMetadataProbe(await servers.acquire(fixture.cliPath, fixture.root, { ...fixture.environment, INVALID_READY: '1' }));
  try {
    await expect(probe.loadCatalog()).rejects.toThrow('Invalid OpenCode catalog server readiness response');
  } finally { await probe.dispose(); await servers.dispose(); }
});

it('includes account-backed models in the first discovery and keeps the saved selection available', async () => {
  fixture.environment.ACTIVATION_DELAY_MS = '250';
  const catalog = JSON.parse(readFileSync(fixture.environment.CATALOG_FILE!, 'utf8'));
  catalog.push({ providerID: 'opencode-go', id: 'deepseek-v4.1-flash', name: 'DeepSeek Flash', enabled: true });
  writeFileSync(fixture.environment.CATALOG_FILE!, JSON.stringify(catalog));
  const { host: plugin } = await fixture.createHostFixture();
  updateOpencodeProviderSettings(plugin.settings, { visibleModels: ['opencode-go/deepseek-v4.1-flash'] });
  const service = new OpencodeMetadataService(plugin.getRuntimeHost('opencode'), plugin.executionLifecycleRegistry);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toContainEqual({
      rawId: 'opencode-go/deepseek-v4.1-flash', label: 'opencode-go/DeepSeek Flash',
    });
    expect(() => assertOpencodeModelAvailable(plugin.getRuntimeHost('opencode'), 'opencode:opencode-go/deepseek-v4.1-flash')).not.toThrow();
  } finally { await service.dispose(); }
});

it('discovers native commands after catalog loading and lists skills', async () => {
  const { host: plugin } = await fixture.createHostFixture();
  updateOpencodeProviderSettings(plugin.settings, { discoveredModels: [{ rawId: 'old/model', label: 'Old model' }] });
  const host = plugin.getRuntimeHost('opencode');
  const writes = vi.spyOn(host, 'updateConfig');
  const service = new OpencodeMetadataService(host, plugin.executionLifecycleRegistry);
  try {
    const loader = new OpencodeCommandLoader(service);
    const result = await loader.loadCommands({ plugin, conversation: null, allowIsolatedMetadataCreation: true });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Native commands did not load');
    expect(result.items.map(({ name, kind, description }) => ({ name, kind, description }))).toEqual([
      { name: 'review', kind: 'command', description: 'Review changes' },
      { name: 'writing', kind: 'skill', description: 'Writing guide' },
    ]);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([{ rawId: 'old/model', label: 'Old model' }]);
    expect(writes).not.toHaveBeenCalled();
    // A borrowed service remains usable, on the same native process, after the loader returns.
    const endpoint = readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8');
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8')).toBe(endpoint);
  } finally { await service.dispose(); }
});

it.each(['404', '500'])('loads models when the optional readiness endpoint returns %s', async status => {
  fixture.environment.INTEGRATION_STATUS = status;
  const { host: plugin } = await fixture.createHostFixture();
  const service = new OpencodeMetadataService(plugin.getRuntimeHost('opencode'), plugin.executionLifecycleRegistry);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    await expect(service.warmModelMetadata('opencode:deepseek/chat')).resolves.toBe(true);
  } finally { await service.dispose(); }
});

it('bounds the readiness wait and aborts its request without stopping the retained server', async () => {
  fixture.environment.INTEGRATION_STATUS = 'hang';
  const { host: plugin } = await fixture.createHostFixture();
  const service = new OpencodeMetadataService(plugin.getRuntimeHost('opencode'), plugin.executionLifecycleRegistry);
  vi.useFakeTimers({ now: testDate(), toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const loading = service.loadCatalog();
  let settled = false;
  void loading.then(() => { settled = true; }, () => { settled = true; });
  try {
    expect(window.setTimeout).toBe(setTimeout);
    // The native request must arrive before advancing its deadline; startup and socket I/O stay real.
    for (const started = performance.now(); !existsSync(fixture.environment.ENDPOINT_FILE! + '.integration');) {
      if (settled || performance.now() - started > 40_000) throw new Error('Readiness request did not arrive.');
      await yieldToIO(10);
    }
    for (let elapsed = 0; !settled && elapsed < 8_000; elapsed += 50) await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();
    // Only allow real I/O to settle after the deadline; a longer/missing deadline must fail.
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 3_000 });
    await expect(loading).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([
      { rawId: 'deepseek/chat', label: 'deepseek/DeepSeek Chat' },
    ]);
    await waitUntil(() => existsSync(fixture.environment.ENDPOINT_FILE! + '.integration-aborted'));
    expect((await fetch(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8'))).status).toBe(403);
  } finally { vi.useRealTimers(); await service.dispose(); }
});

it('returns a successful empty command and skill snapshot without waiting for discovery', async () => {
  writeFileSync(fixture.environment.CATALOG_FILE! + '.commands', '[]');
  writeFileSync(fixture.environment.CATALOG_FILE! + '.skills', '[]');
  const { host: plugin } = await fixture.createHostFixture();
  const service = new OpencodeMetadataService(plugin.getRuntimeHost('opencode'), plugin.executionLifecycleRegistry);
  try {
    await service.loadCatalog();
    const started = performance.now();
    await expect(service.discoverCommands()).resolves.toEqual({ loaded: true, commands: [] });
    expect(performance.now() - started).toBeLessThan(1_000);
  } finally { await service.dispose(); }
});
