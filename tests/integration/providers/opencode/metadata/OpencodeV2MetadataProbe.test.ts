import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';
import { OpencodeMetadataService } from '@/providers/opencode/metadata/OpencodeMetadataService';
import { OpencodeV2MetadataProbe } from '@/providers/opencode/metadata/OpencodeV2MetadataProbe';
import { getOpencodeProviderSettings, projectOpencodeModelSettings } from '@/providers/opencode/settings';

// External OpenCode boundary: its native catalog endpoints and stdio ownership lease.
const cliFixture = `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
if (process.argv.includes('--version')) {
  process.stdout.write('opencode v2.0.12\\n');
} else {
  if (!process.argv.includes('--stdio') || process.env.OPENCODE_DB !== process.env.EXPECTED_DATABASE) process.exit(2);
  const started = Date.now();
  let reads = 0;
  const server = http.createServer((req, res) => {
    const auth = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_PASSWORD).toString('base64');
    const url = new URL(req.url, 'http://localhost');
    if (req.headers.authorization !== auth || url.searchParams.get('location[directory]') !== process.cwd()) {
      res.writeHead(403); res.end(); return;
    }
    if (req.method !== 'GET' || !['/api/model', '/api/command'].includes(url.pathname)) {
      res.writeHead(405); res.end(); return;
    }
    if (fs.existsSync(process.env.CATALOG_FILE + '.invalid')) {
      res.setHeader('Content-Type', 'application/json');
      res.end('{}'); return;
    }
    if (url.pathname === '/api/model') fs.writeFileSync(process.env.ENDPOINT_FILE + '.read', '');
    const catalog = JSON.parse(fs.readFileSync(process.env.CATALOG_FILE, 'utf8'))
      .filter(model => model.id !== 'slow-model' || Date.now() - started >= Number(process.env.DELAYED_CATALOG_MS || 0));
    const data = url.pathname === '/api/model'
      ? (++reads === 1 ? [] : catalog)
      : [{ name: 'review', description: 'Review changes' }];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ location: { directory: process.cwd() }, data }));
  });
  server.listen(0, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + server.address().port;
    fs.writeFileSync(process.env.ENDPOINT_FILE, url);
    fs.writeFileSync(process.env.ENDPOINT_FILE + '.pid', String(process.pid));
    setTimeout(() => process.stdout.write(JSON.stringify({ url: process.env.INVALID_READY === '1' ? 'https://example.com' : url }) + '\\n'), Number(process.env.READY_DELAY_MS || 0));
  });
  process.stdin.resume();
  process.stdin.on('end', () => server.close());
}
`;

let root: string;
let cliPath: string;
let environment: NodeJS.ProcessEnv;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-opencode-catalog-')));
  cliPath = path.join(root, 'opencode.cjs');
  writeFileSync(cliPath, cliFixture, { mode: 0o700 });
  environment = {
    ...process.env,
    OPENCODE_DB: path.join(root, 'native.db'),
    EXPECTED_DATABASE: path.join(root, 'native.db'),
    CATALOG_FILE: path.join(root, 'catalog.json'),
    ENDPOINT_FILE: path.join(root, 'endpoint'),
  };
  writeCatalog();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function writeCatalog(name = 'DeepSeek Chat'): void {
  writeFileSync(environment.CATALOG_FILE!, JSON.stringify([
    { providerID: 'deepseek', id: 'chat', name, enabled: true, variants: [{ id: 'high' }] },
    { providerID: 'deepseek', id: 'disabled', name: 'Disabled', enabled: false, variants: [] },
  ]));
}

function createPlugin(): any {
  const plugin: any = {
    app: { vault: { adapter: { basePath: root } } },
    getResolvedProviderCliPath: async () => cliPath,
    executionLifecycleRegistry: { registerTransitionHook: jest.fn(() => () => undefined) },
    notifyProviderChatOptionsChanged: () => undefined,
    settings: { providerConfigs: { opencode: {
      enabled: true,
      visibleModels: [],
      environmentVariables: Object.entries(environment)
        .filter(([key]) => ['OPENCODE_DB', 'EXPECTED_DATABASE', 'CATALOG_FILE', 'ENDPOINT_FILE', 'DELAYED_CATALOG_MS', 'READY_DELAY_MS'].includes(key))
        .map(([key, value]) => `${key}=${value}`).join('\n'),
    } } },
    mutateSettings: async (mutation: (settings: Record<string, unknown>) => void) => mutation(plugin.settings),
    mutateSettingsConditionally: async (mutation: (settings: Record<string, unknown>) => void) => mutation(plugin.settings),
  };
  return plugin;
}

it('refreshes the native catalog and commands without persisting the catalog or enabling models', async () => {
  const plugin = createPlugin();
  const service = new OpencodeMetadataService(plugin);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([
      { rawId: 'deepseek/chat', label: 'deepseek/DeepSeek Chat' },
    ]);
    writeCatalog('Updated Chat');
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels[0].label).toBe('deepseek/Updated Chat');
    await expect(service.loadCommands()).resolves.toMatchObject([{ name: 'review', description: 'Review changes' }]);
    await expect(service.warmModelMetadata('opencode:deepseek/chat')).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).thinkingOptionsByModel['deepseek/chat'])
      .toEqual(expect.arrayContaining([{ value: 'high', label: 'High' }, { value: 'default', label: 'Default' }]));
    const stored = projectOpencodeModelSettings(plugin.settings);
    expect(stored.discoveredModels).toBeUndefined();
    expect(stored.visibleModels).toEqual([]);
    expect((await fetch(readFileSync(environment.ENDPOINT_FILE!, 'utf8'))).status).toBe(403);
  } finally { await service.dispose(); }
  await expect(fetch(readFileSync(environment.ENDPOINT_FILE!, 'utf8'))).rejects.toThrow();
});

it('rejects a non-loopback readiness endpoint before sending authorization', async () => {
  const servers = new OpencodeServerService();
  const probe = new OpencodeV2MetadataProbe(await servers.acquire(cliPath, root, { ...environment, INVALID_READY: '1' }));
  try {
    await expect(probe.loadCatalog()).rejects.toThrow('Invalid OpenCode catalog server readiness response');
  } finally { await probe.dispose(); await servers.dispose(); }
});

it('cancels a probe waiting for native catalog initialization and closes its server', async () => {
  writeFileSync(environment.CATALOG_FILE!, '[]');
  const servers = new OpencodeServerService();
  const probe = new OpencodeV2MetadataProbe(await servers.acquire(cliPath, root, environment));
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

it.each([3_000, 7_500])('discovers models added after %i ms on the same metadata server', async (delayMs) => {
  environment.DELAYED_CATALOG_MS = String(delayMs);
  const catalog = JSON.parse(readFileSync(environment.CATALOG_FILE!, 'utf8'));
  catalog.push({ providerID: 'acme', id: 'slow-model', name: 'Slow Model', enabled: true, variants: [{ id: 'high' }] });
  writeFileSync(environment.CATALOG_FILE!, JSON.stringify(catalog));
  const plugin = createPlugin();
  const service = new OpencodeMetadataService(plugin);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    const endpoint = readFileSync(environment.ENDPOINT_FILE!, 'utf8');
    await new Promise(resolve => setTimeout(resolve, delayMs + 50));
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([
      { rawId: 'deepseek/chat', label: 'deepseek/DeepSeek Chat' },
      { rawId: 'acme/slow-model', label: 'acme/Slow Model' },
    ]);
    expect(readFileSync(environment.ENDPOINT_FILE!, 'utf8')).toBe(endpoint);
    await expect(service.warmModelMetadata('opencode:acme/slow-model')).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).thinkingOptionsByModel['acme/slow-model'])
      .toEqual(expect.arrayContaining([{ value: 'high', label: 'High' }]));
    expect(getOpencodeProviderSettings(plugin.settings).visibleModels).toEqual([]);
  } finally { await service.dispose(); }
}, 15_000);

it('waits for the requested model while other models are already available', async () => {
  environment.DELAYED_CATALOG_MS = '250';
  const catalog = JSON.parse(readFileSync(environment.CATALOG_FILE!, 'utf8'));
  catalog.push({ providerID: 'acme', id: 'slow-model', name: 'Slow Model', enabled: true, variants: [{ id: 'high' }] });
  writeFileSync(environment.CATALOG_FILE!, JSON.stringify(catalog));
  const service = new OpencodeMetadataService(createPlugin());
  try {
    await expect(service.warmModelMetadata('opencode:acme/slow-model')).resolves.toBe(true);
  } finally { await service.dispose(); }
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Fixture did not reach the expected state.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

it('cancels one reader during shared startup without stopping another reader', async () => {
  environment.READY_DELAY_MS = '1000';
  const service = new OpencodeMetadataService(createPlugin());
  const controller = new AbortController();
  try {
    const cancelled = service.loadCatalog(controller.signal);
    const other = service.loadCatalog();
    let otherSettled = false;
    void other.then(() => { otherSettled = true; });
    await waitUntil(() => existsSync(environment.ENDPOINT_FILE!));
    const endpoint = readFileSync(environment.ENDPOINT_FILE!, 'utf8');
    controller.abort();
    await expect(cancelled).resolves.toBe(false);
    expect(otherSettled).toBe(false);
    // The surviving query keeps the same startup and can still publish its catalog.
    await expect(other).resolves.toBe(true);
    expect(readFileSync(environment.ENDPOINT_FILE!, 'utf8')).toBe(endpoint);
    expect((await fetch(endpoint)).status).toBe(403);
  } finally { await service.dispose(); }
});

it('invalidates a retained server during startup and permits a fresh discovery', async () => {
  environment.READY_DELAY_MS = '1000';
  const service = new OpencodeMetadataService(createPlugin());
  try {
    const pending = service.loadCatalog();
    await waitUntil(() => existsSync(environment.ENDPOINT_FILE!));
    const endpoint = readFileSync(environment.ENDPOINT_FILE!, 'utf8');
    await service.invalidate();
    await expect(pending).resolves.toBe(false);
    await expect(fetch(endpoint)).rejects.toThrow();
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(readFileSync(environment.ENDPOINT_FILE!, 'utf8')).not.toBe(endpoint);
  } finally { await service.dispose(); }
});

it('closes the retained server across environment transitions and reads the new environment', async () => {
  const plugin = createPlugin();
  const service = new OpencodeMetadataService(plugin);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    const endpoint = readFileSync(environment.ENDPOINT_FILE!, 'utf8');
    const hooks = plugin.executionLifecycleRegistry.registerTransitionHook.mock.calls[0][1];
    await hooks.beforeTransition();
    await expect(fetch(endpoint)).rejects.toThrow();
    const pending = service.loadCatalog();
    const replacementCatalog = path.join(root, 'replacement.json');
    writeFileSync(replacementCatalog, JSON.stringify([
      { providerID: 'new', id: 'model', name: 'New Model', enabled: true, variants: [] },
    ]));
    plugin.settings.providerConfigs.opencode.environmentVariables =
      plugin.settings.providerConfigs.opencode.environmentVariables.replace(environment.CATALOG_FILE!, replacementCatalog);
    await hooks.afterTransition();
    await expect(pending).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([
      { rawId: 'new/model', label: 'new/New Model' },
    ]);
  } finally { await service.dispose(); }
});

it('replaces a crashed idle server on the next discovery', async () => {
  const service = new OpencodeMetadataService(createPlugin());
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    const endpoint = readFileSync(environment.ENDPOINT_FILE!, 'utf8');
    const pid = Number(readFileSync(environment.ENDPOINT_FILE! + '.pid', 'utf8'));
    process.kill(pid, 'SIGTERM');
    await waitUntil(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    });
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(readFileSync(environment.ENDPOINT_FILE!, 'utf8')).not.toBe(endpoint);
  } finally { await service.dispose(); }
});

it('keeps the shared server alive after an invalid catalog and permits retry after repair', async () => {
  const service = new OpencodeMetadataService(createPlugin());
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    const endpoint = readFileSync(environment.ENDPOINT_FILE!, 'utf8');
    writeFileSync(environment.CATALOG_FILE! + '.invalid', '');
    await expect(service.loadCatalog()).resolves.toBe(false);
    // A malformed catalog must not terminate unrelated chat sessions.
    expect((await fetch(endpoint)).status).toBe(403);
    rmSync(environment.CATALOG_FILE! + '.invalid');
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(readFileSync(environment.ENDPOINT_FILE!, 'utf8')).toBe(endpoint);
  } finally { await service.dispose(); }
});

it('retains initialization after a missing-model timeout so warmup can be retried', async () => {
  const service = new OpencodeMetadataService(createPlugin());
  try {
    await expect(service.warmModelMetadata('opencode:acme/slow-model')).resolves.toBe(false);
    const endpoint = readFileSync(environment.ENDPOINT_FILE!, 'utf8');
    writeFileSync(environment.CATALOG_FILE!, JSON.stringify([
      { providerID: 'acme', id: 'slow-model', name: 'Slow Model', enabled: true, variants: [{ id: 'high' }] },
    ]));
    await expect(service.warmModelMetadata('opencode:acme/slow-model')).resolves.toBe(true);
    expect(readFileSync(environment.ENDPOINT_FILE!, 'utf8')).toBe(endpoint);
  } finally { await service.dispose(); }
}, 10_000);


it('cancels one polling reader without stopping another or publishing its stale result', async () => {
  const plugin = createPlugin();
  const service = new OpencodeMetadataService(plugin);
  const controller = new AbortController();
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    const endpoint = readFileSync(environment.ENDPOINT_FILE!, 'utf8');
    writeFileSync(environment.CATALOG_FILE!, '[]');
    rmSync(environment.ENDPOINT_FILE! + '.read');
    const cancelled = service.loadCatalog(controller.signal);
    const other = service.loadCatalog();
    await waitUntil(() => existsSync(environment.ENDPOINT_FILE! + '.read'));
    controller.abort();
    await expect(cancelled).resolves.toBe(false);
    writeCatalog('Updated Chat');
    await expect(other).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([
      { rawId: 'deepseek/chat', label: 'deepseek/Updated Chat' },
    ]);
    expect(readFileSync(environment.ENDPOINT_FILE!, 'utf8')).toBe(endpoint);
  } finally { await service.dispose(); }
});

it('clears removed models when the retained server reports an empty catalog', async () => {
  const plugin = createPlugin();
  const service = new OpencodeMetadataService(plugin);
  try {
    await expect(service.loadCatalog()).resolves.toBe(true);
    writeFileSync(environment.CATALOG_FILE!, '[]');
    await expect(service.loadCatalog()).resolves.toBe(true);
    expect(getOpencodeProviderSettings(plugin.settings).discoveredModels).toEqual([]);
  } finally { await service.dispose(); }
}, 10_000);

it('does not start a server when disposed while resolving the CLI', async () => {
  const plugin = createPlugin();
  let resolveCli!: (value: string) => void;
  plugin.getResolvedProviderCliPath = () => new Promise<string>(resolve => { resolveCli = resolve; });
  const service = new OpencodeMetadataService(plugin);
  const pending = service.loadCatalog();
  const disposal = service.dispose();
  resolveCli(cliPath);
  await disposal;
  await expect(pending).resolves.toBe(false);
  expect(existsSync(environment.ENDPOINT_FILE!)).toBe(false);
});
