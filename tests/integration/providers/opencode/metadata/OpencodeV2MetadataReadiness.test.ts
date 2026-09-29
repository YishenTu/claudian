import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';
import { OpencodeMetadataService } from '@/providers/opencode/metadata/OpencodeMetadataService';
import { OpencodeV2MetadataProbe } from '@/providers/opencode/metadata/OpencodeV2MetadataProbe';
import { assertOpencodeModelAvailable } from '@/providers/opencode/runtime/OpencodeModelAvailability';
import { getOpencodeProviderSettings } from '@/providers/opencode/settings';

import { createOpencodeV2MetadataFixture, type OpencodeV2MetadataFixture, waitUntil } from './OpencodeV2MetadataFixture';

// OpenCode v2 metadata readiness: loopback validation, the optional integration endpoint, and account activation.
let fixture: OpencodeV2MetadataFixture;

beforeEach(() => { fixture = createOpencodeV2MetadataFixture(); });

afterEach(() => fixture.dispose());

it('rejects a non-loopback readiness endpoint before sending authorization', async () => {
  const servers = new OpencodeServerService();
  const probe = new OpencodeV2MetadataProbe(await servers.acquire(fixture.cliPath, fixture.root, { ...fixture.environment, INVALID_READY: '1' }));
  try {
    await expect(probe.loadCatalog()).rejects.toThrow('Invalid OpenCode catalog server readiness response');
  } finally { await probe.dispose(); await servers.dispose(); }
});

it('includes account-backed models in the first discovery and keeps the saved selection available', async () => {
  fixture.environment.ACTIVATION_DELAY_MS = '250';
  const catalog = JSON.parse(readFileSync(fixture.environment.CATALOG_FILE!, 'utf8'));
  catalog.push({ providerID: 'opencode-go', id: 'deepseek-v4.1-flash', name: 'DeepSeek Flash', enabled: true });
  writeFileSync(fixture.environment.CATALOG_FILE!, JSON.stringify(catalog));
  const plugin = fixture.createPlugin();
  plugin.settings.providerConfigs.opencode.visibleModels = ['opencode-go/deepseek-v4.1-flash'];
  const service = new OpencodeMetadataService(plugin);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toContainEqual({
      rawId: 'opencode-go/deepseek-v4.1-flash', label: 'opencode-go/DeepSeek Flash',
    });
    expect(() => assertOpencodeModelAvailable(plugin.settings, 'opencode:opencode-go/deepseek-v4.1-flash')).not.toThrow();
  } finally { await service.dispose(); }
});

it.each(['404', '500'])('loads models when the optional readiness endpoint returns %s', async status => {
  fixture.environment.INTEGRATION_STATUS = status;
  const service = new OpencodeMetadataService(fixture.createPlugin());
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    await expect(service.warmModelMetadata('opencode:deepseek/chat')).resolves.toBe(true);
  } finally { await service.dispose(); }
});

it('bounds the readiness wait and aborts its request without stopping the retained server', async () => {
  fixture.environment.INTEGRATION_STATUS = 'hang';
  const plugin = fixture.createPlugin();
  const service = new OpencodeMetadataService(plugin);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([
      { rawId: 'deepseek/chat', label: 'deepseek/DeepSeek Chat' },
    ]);
    await waitUntil(() => existsSync(fixture.environment.ENDPOINT_FILE! + '.integration-aborted'));
    expect((await fetch(readFileSync(fixture.environment.ENDPOINT_FILE!, 'utf8'))).status).toBe(403);
  } finally { await service.dispose(); }
}, 12_000);
