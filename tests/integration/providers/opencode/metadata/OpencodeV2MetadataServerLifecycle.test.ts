import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { OpencodeMetadataService } from '@/providers/opencode/metadata/OpencodeMetadataService';
import { getOpencodeProviderSettings } from '@/providers/opencode/settings';

import { createOpencodeV2MetadataFixture, type OpencodeV2MetadataFixture, waitUntil } from './OpencodeV2MetadataFixture';

// OpenCode v2 retained metadata server recovery across transitions, crashes, invalid catalogs, and timeouts.
let fixture: OpencodeV2MetadataFixture;

beforeEach(() => { fixture = createOpencodeV2MetadataFixture(); });

afterEach(() => fixture.dispose());

it('closes the retained server across environment transitions and reads the new environment', async () => {
  const plugin = fixture.createPlugin();
  const service = new OpencodeMetadataService(plugin);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    const endpoint = readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8');
    const hooks = plugin.executionLifecycleRegistry.registerTransitionHook.mock.calls[0][1];
    await hooks.beforeTransition();
    await expect(fetch(endpoint)).rejects.toThrow();
    const pending = service.loadCatalog();
    const replacementCatalog = path.join(fixture.root, 'replacement.json');
    writeFileSync(replacementCatalog, JSON.stringify([
      { providerID: 'new', id: 'model', name: 'New Model', enabled: true, variants: [] },
    ]));
    plugin.settings.providerConfigs.opencode.environmentVariables =
      plugin.settings.providerConfigs.opencode.environmentVariables.replace(fixture.environment.CATALOG_FILE!, replacementCatalog);
    await hooks.afterTransition();
    await expect(pending).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([
      { rawId: 'new/model', label: 'new/New Model' },
    ]);
  } finally { await service.dispose(); }
});

it('replaces a crashed idle server on the next discovery', async () => {
  const service = new OpencodeMetadataService(fixture.createPlugin());
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    const endpoint = readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8');
    const pid = Number(readFileSync(fixture.environment.ENDPOINT_FILE! + '.pid', 'utf8'));
    process.kill(pid, 'SIGTERM');
    await waitUntil(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    });
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8')).not.toBe(endpoint);
  } finally { await service.dispose(); }
});

it('keeps the shared server alive after an invalid catalog and permits retry after repair', async () => {
  const service = new OpencodeMetadataService(fixture.createPlugin());
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

it('retains initialization after a missing-model timeout so warmup can be retried', async () => {
  const service = new OpencodeMetadataService(fixture.createPlugin());
  try {
    await expect(service.warmModelMetadata('opencode:acme/slow-model')).resolves.toBe(false);
    const endpoint = readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8');
    writeFileSync(fixture.environment.CATALOG_FILE!, JSON.stringify([
      { providerID: 'acme', id: 'slow-model', name: 'Slow Model', enabled: true, variants: [{ id: 'high' }] },
    ]));
    await expect(service.warmModelMetadata('opencode:acme/slow-model')).resolves.toBe(true);
    expect(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8')).toBe(endpoint);
  } finally { await service.dispose(); }
}, 10_000);

it('clears removed models when the retained server reports an empty catalog', async () => {
  const plugin = fixture.createPlugin();
  const service = new OpencodeMetadataService(plugin);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    writeFileSync(fixture.environment.CATALOG_FILE!, '[]');
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([]);
  } finally { await service.dispose(); }
}, 10_000);
