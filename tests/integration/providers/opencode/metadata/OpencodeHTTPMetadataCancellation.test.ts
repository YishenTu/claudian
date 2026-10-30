import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { OpencodeServerLease, OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';
import { OpencodeHTTPMetadataProbe } from '@/providers/opencode/metadata/OpencodeHTTPMetadataProbe';
import { OpencodeMetadataService } from '@/providers/opencode/metadata/OpencodeMetadataService';
import { getOpencodeProviderSettings } from '@/providers/opencode/settings';

import { createOpencodeHTTPMetadataFixture, type OpencodeHTTPMetadataFixture, waitUntil } from './OpencodeHTTPMetadataFixture';

// OpenCode v2 metadata reader cancellation, invalidation, and disposal during startup and polling.
let fixture: OpencodeHTTPMetadataFixture;

beforeEach(() => { fixture = createOpencodeHTTPMetadataFixture(); });

afterEach(() => fixture.dispose());

it('cancels one activation wait without publishing or stopping another reader', async () => {
  const hold = fixture.environment.CATALOG_FILE! + '.activation-hold';
  writeFileSync(hold, '');
  const { host: plugin } = await fixture.createHostFixture();
  const service = new OpencodeMetadataService(plugin.getRuntimeHost('opencode'), plugin.executionLifecycleRegistry);
  const controller = new AbortController();
  try {
    const cancelled = service.loadCatalog(controller.signal);
    const other = service.loadCatalog();
    await waitUntil(() => existsSync(fixture.environment.ENDPOINT_FILE! + '.integration'));
    const endpoint = readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8');
    controller.abort();
    await expect(cancelled).resolves.toBe(false);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([]);
    rmSync(hold);
    await expect(other).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([
      { rawId: 'deepseek/chat', label: 'deepseek/DeepSeek Chat' },
    ]);
    expect(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8')).toBe(endpoint);
  } finally { await service.dispose(); }
});

it('cancels an in-flight catalog read and closes its server', async () => {
  writeFileSync(fixture.environment.CATALOG_FILE! + '.hang', '');
  const servers = new OpencodeServerService();
  const probe = new OpencodeHTTPMetadataProbe(await servers.acquire(fixture.cliPath, fixture.root, fixture.environment));
  const controller = new AbortController();
  const pending = probe.loadCatalog(controller.signal);
  try {
    await waitUntil(() => existsSync(fixture.environment.ENDPOINT_FILE! + '.model-pending'));
    controller.abort();
    await expect(pending).rejects.toThrow();
  } finally {
    await probe.dispose(); await servers.dispose();
  }
});

it('cancels one reader during shared startup without stopping another reader', async () => {
  const hold = fixture.environment.CATALOG_FILE! + '.ready-hold';
  writeFileSync(hold, '');
  const { host: plugin } = await fixture.createHostFixture();
  const service = new OpencodeMetadataService(plugin.getRuntimeHost('opencode'), plugin.executionLifecycleRegistry);
  const controller = new AbortController();
  try {
    const cancelled = service.loadCatalog(controller.signal);
    const other = service.loadCatalog();
    let otherSettled = false;
    void other.then(() => { otherSettled = true; });
    await waitUntil(() => existsSync(fixture.environment.ENDPOINT_FILE!));
    const endpoint = readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8');
    controller.abort();
    await expect(cancelled).resolves.toBe(false);
    expect(otherSettled).toBe(false);
    rmSync(hold);
    // The surviving query keeps the same startup and can still publish its catalog.
    await expect(other).resolves.toBe(true);
    expect(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8')).toBe(endpoint);
    expect((await fetch(endpoint)).status).toBe(403);
  } finally { await service.dispose(); }
});

it('invalidates a retained server during startup and permits a fresh discovery', async () => {
  const hold = fixture.environment.CATALOG_FILE! + '.ready-hold';
  writeFileSync(hold, '');
  const { host: plugin } = await fixture.createHostFixture();
  const service = new OpencodeMetadataService(plugin.getRuntimeHost('opencode'), plugin.executionLifecycleRegistry);
  try {
    const pending = service.loadCatalog();
    await waitUntil(() => existsSync(fixture.environment.ENDPOINT_FILE!));
    const endpoint = readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8');
    await service.invalidate();
    await expect(pending).resolves.toBe(false);
    await expect(fetch(endpoint)).rejects.toThrow();
    rmSync(hold);
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8')).not.toBe(endpoint);
  } finally { await service.dispose(); }
});

it('cancels one in-flight reader without stopping another or publishing its stale result', async () => {
  const { host: plugin } = await fixture.createHostFixture();
  const service = new OpencodeMetadataService(plugin.getRuntimeHost('opencode'), plugin.executionLifecycleRegistry);
  const controller = new AbortController();
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    const endpoint = readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8');
    writeFileSync(fixture.environment.CATALOG_FILE! + '.hold', '');
    rmSync(fixture.environment.ENDPOINT_FILE! + '.read');
    const cancelled = service.loadCatalog(controller.signal);
    const other = service.loadCatalog();
    await waitUntil(() => existsSync(fixture.environment.ENDPOINT_FILE! + '.read'));
    controller.abort();
    // Release the real HTTP read only after cancelling its peer.
    fixture.writeCatalog('Updated Chat');
    rmSync(fixture.environment.CATALOG_FILE! + '.hold');
    await expect(cancelled).resolves.toBe(false);
    await expect(other).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([
      { rawId: 'deepseek/chat', label: 'deepseek/Updated Chat' },
    ]);
    expect(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8')).toBe(endpoint);
  } finally { await service.dispose(); }
});

it('does not start a server when disposed while resolving the CLI', async () => {
  const { host: plugin } = await fixture.createHostFixture();
  let resolveCli!: (value: string) => void;
  plugin.getResolvedProviderCliPath = () => new Promise<string>(resolve => { resolveCli = resolve; });
  const service = new OpencodeMetadataService(plugin.getRuntimeHost('opencode'), plugin.executionLifecycleRegistry);
  const pending = service.loadCatalog();
  const disposal = service.dispose();
  resolveCli(fixture.cliPath);
  await disposal;
  await expect(pending).resolves.toBe(false);
  expect(existsSync(fixture.environment.ENDPOINT_FILE!)).toBe(false);
});

it('aborts background catalog discovery on dispose without late settings writes or stopping a shared server', async () => {
  writeFileSync(fixture.environment.CATALOG_FILE!, '[]');
  writeFileSync(fixture.environment.CATALOG_FILE! + '.hang-after-first', '');
  const { host: plugin } = await fixture.createHostFixture();
  const host = plugin.getRuntimeHost('opencode');
  const writes = vi.spyOn(host, 'updateConfig');
  const servers = new OpencodeServerService();
  const service = new OpencodeMetadataService(host, plugin.executionLifecycleRegistry, { serverService: servers });
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    await waitUntil(() => existsSync(fixture.environment.ENDPOINT_FILE! + '.model-pending'));
    await service.dispose();
    await waitUntil(() => existsSync(fixture.environment.ENDPOINT_FILE! + '.model-aborted'));
    const writeCount = writes.mock.calls.length;
    rmSync(fixture.environment.CATALOG_FILE! + '.hang-after-first');
    fixture.writeCatalog('After disposal');
    expect((await fetch(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8'))).status).toBe(403);
    expect(writes).toHaveBeenCalledTimes(writeCount);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([]);
  } finally { await service.dispose(); await servers.dispose(); }
});

it('cancels metadata subscription admission without cancelling a peer sharing the pending event stream', async () => {
  const hold = fixture.environment.CATALOG_FILE! + '.event-hold';
  writeFileSync(hold, '');
  const { host: plugin } = await fixture.createHostFixture();
  const servers = new OpencodeServerService();
  const peer = await servers.acquire(fixture.cliPath, fixture.root, fixture.environment);
  const service = new OpencodeMetadataService(plugin.getRuntimeHost('opencode'), plugin.executionLifecycleRegistry, {
    serverService: servers, createProbe: () => new OpencodeHTTPMetadataProbe(peer.retain()),
  });
  const subscribe = vi.spyOn(OpencodeServerLease.prototype, 'subscribe');
  const events: string[] = [];
  const peerAdmission = peer.subscribe(event => events.push(event.type), () => undefined, () => false);
  void peerAdmission.catch(() => undefined);
  let disposal: Promise<void> | undefined;
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2));
    await waitUntil(() => existsSync(fixture.environment.ENDPOINT_FILE! + '.event-pending'));
    let admissionSettled = false;
    void subscribe.mock.results[1].value.then(
      () => { admissionSettled = true; }, () => { admissionSettled = true; },
    );
    let disposed = false;
    disposal = service.dispose().then(() => { disposed = true; });
    await vi.waitFor(() => expect(disposed).toBe(true));
    await vi.waitFor(() => expect(admissionSettled).toBe(true));
    expect(existsSync(fixture.environment.ENDPOINT_FILE! + '.event-closed')).toBe(false);
    rmSync(hold);
    await peerAdmission;
    fixture.writeCatalog('Peer still observes');
    await vi.waitFor(() => expect(events).toContain('model.updated'));
  } finally {
    rmSync(hold, { force: true });
    await servers.dispose(); await disposal; await service.dispose(); await peer.dispose();
    await Promise.allSettled([peerAdmission]); subscribe.mockRestore();
  }
});
