import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

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
    const catalog = JSON.parse(fs.readFileSync(process.env.CATALOG_FILE, 'utf8'));
    const data = url.pathname === '/api/model'
      ? (++reads === 1 ? [] : catalog)
      : [{ name: 'review', description: 'Review changes' }];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ location: { directory: process.cwd() }, data }));
  });
  server.listen(0, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + server.address().port;
    fs.writeFileSync(process.env.ENDPOINT_FILE, url);
    process.stdout.write(JSON.stringify({ url: process.env.INVALID_READY === '1' ? 'https://example.com' : url }) + '\\n');
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

it('refreshes the native catalog and commands without persisting the catalog or enabling models', async () => {
  const plugin: any = {
    app: { vault: { adapter: { basePath: root } } },
    getResolvedProviderCliPath: async () => cliPath,
    executionLifecycleRegistry: { registerTransitionHook: () => () => undefined },
    notifyProviderChatOptionsChanged: () => undefined,
    settings: { providerConfigs: { opencode: {
      enabled: true,
      visibleModels: [],
      environmentVariables: Object.entries(environment)
        .filter(([key]) => ['OPENCODE_DB', 'EXPECTED_DATABASE', 'CATALOG_FILE', 'ENDPOINT_FILE'].includes(key))
        .map(([key, value]) => `${key}=${value}`).join('\n'),
    } } },
    mutateSettings: async (mutation: (settings: Record<string, unknown>) => void) => mutation(plugin.settings),
    mutateSettingsConditionally: async (mutation: (settings: Record<string, unknown>) => void) => mutation(plugin.settings),
  };
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
    await expect(fetch(readFileSync(environment.ENDPOINT_FILE!, 'utf8'))).rejects.toThrow();
  } finally { await service.dispose(); }
});

it('rejects a non-loopback readiness endpoint before sending authorization', async () => {
  const probe = new OpencodeV2MetadataProbe(cliPath, root, { ...environment, INVALID_READY: '1' });
  try {
    await expect(probe.loadCatalog()).rejects.toThrow('Invalid OpenCode catalog server readiness response');
  } finally { await probe.dispose(); }
});

it('cancels a probe waiting for native catalog initialization and closes its server', async () => {
  writeFileSync(environment.CATALOG_FILE!, '[]');
  const probe = new OpencodeV2MetadataProbe(cliPath, root, environment);
  const controller = new AbortController();
  const pending = probe.loadCatalog(controller.signal);
  const timer = setTimeout(() => controller.abort(), 150);
  try {
    await expect(pending).rejects.toThrow();
  } finally {
    clearTimeout(timer);
    await probe.dispose();
  }
});
