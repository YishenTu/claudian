// @test-ci {"inputs":["tests/helpers/providers/opencode/OpencodeNativePeer.cjs"]}
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';
import { OpencodeMetadataService } from '@/providers/opencode/metadata/OpencodeMetadataService';
import { resolveOpencodeTarget } from '@/providers/opencode/runtime/OpencodeExecutionTarget';
import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from '@/providers/opencode/settings';

import { createOpencodeHTTPMetadataFixture, type OpencodeHTTPMetadataFixture, waitUntil } from './OpencodeHTTPMetadataFixture';

// OpenCode v2 retained metadata server recovery across transitions, crashes, invalid catalogs, and timeouts.
let fixture: OpencodeHTTPMetadataFixture;

beforeEach(() => { fixture = createOpencodeHTTPMetadataFixture(); });

afterEach(() => fixture.dispose());

it('closes the retained server across environment transitions and reads the new environment', async () => {
  const { host: plugin } = await fixture.createHostFixture();
  const service = new OpencodeMetadataService(plugin.getRuntimeHost('opencode'), plugin.executionLifecycleRegistry);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    const endpoint = readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8');
    let pending: Promise<boolean> | undefined;
    await plugin.runProviderExecutionTransition(['opencode'], async () => {
      await expect(fetch(endpoint)).rejects.toThrow();
      pending = service.loadCatalog();
      const replacementCatalog = path.join(fixture.root, 'replacement.json');
      writeFileSync(replacementCatalog, JSON.stringify([
        { providerID: 'new', id: 'model', name: 'New Model', enabled: true, variants: [] },
      ]));
      updateOpencodeProviderSettings(plugin.settings, { environmentVariables: getOpencodeProviderSettings(plugin.settings).environmentVariables.replace(fixture.environment.CATALOG_FILE!, replacementCatalog) });
    });
    await expect(pending).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([
      { rawId: 'new/model', label: 'new/New Model' },
    ]);
  } finally { await service.dispose(); }
});

it('replaces a crashed idle server on the next discovery', async () => {
  const { host: plugin } = await fixture.createHostFixture();
  const runtimeHost = plugin.getRuntimeHost('opencode');
  const serverService = new OpencodeServerService();
  const service = new OpencodeMetadataService(runtimeHost, plugin.executionLifecycleRegistry, { serverService });
  // The same launch the metadata probe acquires, so the lookup addresses its retained server.
  const launch = async () => {
    const cliPath = await runtimeHost.resolveCliPath() ?? 'opencode';
    const cwd = runtimeHost.workingDirectory || process.cwd();
    const target = await resolveOpencodeTarget(runtimeHost.config, cwd);
    return { cliPath, cwd, target, environment: await serverService.targetEnvironment.resolve(target, cwd, runtimeHost.environmentText, cliPath) };
  };
  const running = async () => {
    const lease = await serverService.acquireRunning(launch);
    await lease?.dispose();
    return lease !== null;
  };
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    await expect(running()).resolves.toBe(true);
    const endpoint = readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8');
    const pid = Number(readFileSync(fixture.environment.ENDPOINT_FILE! + '.pid', 'utf8'));
    process.kill(pid, 'SIGTERM');
    // Reuse follows the client's observed exit, which Windows delivers after the pid already reads as gone.
    await waitUntil(async () => !await running());
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8')).not.toBe(endpoint);
  } finally { await service.dispose(); await serverService.dispose(); }
});

it('keeps the shared server alive after an invalid catalog and permits retry after repair', async () => {
  const { host: plugin } = await fixture.createHostFixture();
  const service = new OpencodeMetadataService(plugin.getRuntimeHost('opencode'), plugin.executionLifecycleRegistry);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    const endpoint = readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8');
    writeFileSync(fixture.environment.CATALOG_FILE! + '.invalid', '');
    await expect(service.loadCatalog()).resolves.toBe(false);
    // A malformed catalog must not terminate unrelated chat sessions.
    expect((await fetch(endpoint)).status).toBe(403);
    rmSync(fixture.environment.CATALOG_FILE! + '.invalid');
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8')).toBe(endpoint);
  } finally { await service.dispose(); }
});

it('retains initialization after a missing-model response so warmup can be retried', async () => {
  const { host: plugin } = await fixture.createHostFixture();
  const service = new OpencodeMetadataService(plugin.getRuntimeHost('opencode'), plugin.executionLifecycleRegistry);
  try {
    // Warm native startup first so this measures only the missing-model catalog read.
    await expect(service.loadCatalog()).resolves.toBe(true);
    const started = performance.now();
    await expect(service.warmModelMetadata('opencode:acme/slow-model')).resolves.toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
    const endpoint = readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8');
    writeFileSync(fixture.environment.CATALOG_FILE!, JSON.stringify([
      { providerID: 'acme', id: 'slow-model', name: 'Slow Model', enabled: true, variants: [{ id: 'high' }] },
    ]));
    await expect(service.warmModelMetadata('opencode:acme/slow-model')).resolves.toBe(true);
    expect(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8')).toBe(endpoint);
  } finally { await service.dispose(); }
});

it('clears removed models when the retained server reports an empty catalog', async () => {
  const { host: plugin } = await fixture.createHostFixture();
  const service = new OpencodeMetadataService(plugin.getRuntimeHost('opencode'), plugin.executionLifecycleRegistry);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    writeFileSync(fixture.environment.CATALOG_FILE!, '[]');
    const started = performance.now();
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([]);
  } finally { await service.dispose(); }
});
