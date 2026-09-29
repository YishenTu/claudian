import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';
import { OpencodeMetadataService } from '@/providers/opencode/metadata/OpencodeMetadataService';
import { OpencodeV2MetadataProbe } from '@/providers/opencode/metadata/OpencodeV2MetadataProbe';
import { getOpencodeProviderSettings } from '@/providers/opencode/settings';

import { createOpencodeV2MetadataFixture, type OpencodeV2MetadataFixture, waitUntil } from './OpencodeV2MetadataFixture';

// OpenCode v2 metadata reader cancellation, invalidation, and disposal during startup and polling.
let fixture: OpencodeV2MetadataFixture;

beforeEach(() => { fixture = createOpencodeV2MetadataFixture(); });

afterEach(() => fixture.dispose());

it('cancels one activation wait without publishing or stopping another reader', async () => {
  fixture.environment.ACTIVATION_DELAY_MS = '500';
  const plugin = fixture.createPlugin();
  const service = new OpencodeMetadataService(plugin);
  const controller = new AbortController();
  try {
    const cancelled = service.loadCatalog(controller.signal);
    const other = service.loadCatalog();
    await waitUntil(() => existsSync(fixture.environment.ENDPOINT_FILE! + '.integration'));
    const endpoint = readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8');
    controller.abort();
    await expect(cancelled).resolves.toBe(false);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([]);
    await expect(other).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([
      { rawId: 'deepseek/chat', label: 'deepseek/DeepSeek Chat' },
    ]);
    expect(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8')).toBe(endpoint);
  } finally { await service.dispose(); }
});

it('cancels a probe waiting for native catalog initialization and closes its server', async () => {
  writeFileSync(fixture.environment.CATALOG_FILE!, '[]');
  const servers = new OpencodeServerService();
  const probe = new OpencodeV2MetadataProbe(await servers.acquire(fixture.cliPath, fixture.root, fixture.environment));
  const controller = new AbortController();
  const pending = probe.loadCatalog(controller.signal);
  const timer = setTimeout(() => controller.abort(), 150);
  try {
    await expect(pending).rejects.toThrow();
  } finally {
    clearTimeout(timer);
    await probe.dispose(); await servers.dispose();
  }
});

it('cancels one reader during shared startup without stopping another reader', async () => {
  fixture.environment.READY_DELAY_MS = '1000';
  const service = new OpencodeMetadataService(fixture.createPlugin());
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
    // The surviving query keeps the same startup and can still publish its catalog.
    await expect(other).resolves.toBe(true);
    expect(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8')).toBe(endpoint);
    expect((await fetch(endpoint)).status).toBe(403);
  } finally { await service.dispose(); }
});

it('invalidates a retained server during startup and permits a fresh discovery', async () => {
  fixture.environment.READY_DELAY_MS = '1000';
  const service = new OpencodeMetadataService(fixture.createPlugin());
  try {
    const pending = service.loadCatalog();
    await waitUntil(() => existsSync(fixture.environment.ENDPOINT_FILE!));
    const endpoint = readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8');
    await service.invalidate();
    await expect(pending).resolves.toBe(false);
    await expect(fetch(endpoint)).rejects.toThrow();
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8')).not.toBe(endpoint);
  } finally { await service.dispose(); }
});

it('cancels one polling reader without stopping another or publishing its stale result', async () => {
  const plugin = fixture.createPlugin();
  const service = new OpencodeMetadataService(plugin);
  const controller = new AbortController();
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    const endpoint = readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8');
    writeFileSync(fixture.environment.CATALOG_FILE!, '[]');
    rmSync(fixture.environment.ENDPOINT_FILE! + '.read');
    const cancelled = service.loadCatalog(controller.signal);
    const other = service.loadCatalog();
    await waitUntil(() => existsSync(fixture.environment.ENDPOINT_FILE! + '.read'));
    controller.abort();
    await expect(cancelled).resolves.toBe(false);
    fixture.writeCatalog('Updated Chat');
    await expect(other).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([
      { rawId: 'deepseek/chat', label: 'deepseek/Updated Chat' },
    ]);
    expect(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8')).toBe(endpoint);
  } finally { await service.dispose(); }
});

it('does not start a server when disposed while resolving the CLI', async () => {
  const plugin = fixture.createPlugin();
  let resolveCli!: (value: string) => void;
  plugin.getResolvedProviderCliPath = () => new Promise<string>(resolve => { resolveCli = resolve; });
  const service = new OpencodeMetadataService(plugin);
  const pending = service.loadCatalog();
  const disposal = service.dispose();
  resolveCli(fixture.cliPath);
  await disposal;
  await expect(pending).resolves.toBe(false);
  expect(existsSync(fixture.environment.ENDPOINT_FILE!)).toBe(false);
});
