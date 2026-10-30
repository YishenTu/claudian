import { mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { MockInstance } from 'vitest';

import * as ProcessProbe from '@/core/process/ProcessProbe';



// These suites test native metadata and lifecycle behavior, not cold-launch speed.
vi.setConfig({ testTimeout: 45_000 });
// Keep probing real, with the same default allowance as the other native OpenCode suites.
const runProcessProbe = ProcessProbe.runProcessProbe;
let probe: MockInstance;
beforeEach(() => {
  probe = vi.spyOn(ProcessProbe, 'runProcessProbe').mockImplementation((options, timeoutMs = 30_000) => runProcessProbe(options, timeoutMs));
});
afterEach(() => probe.mockRestore());

// External OpenCode boundary: its native catalog endpoints and stdio ownership lease.
const cliFixture = `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
if (process.argv.includes('--version')) {
  process.stdout.write('opencode v2.2.0\\n');
} else {
  if (!process.argv.includes('--stdio') || process.env.OPENCODE_DB !== process.env.EXPECTED_DATABASE) process.exit(2);
  let reads = 0, commandReads = 0, skillReads = 0;
  const feeds = new Set();
  const emit = type => { for (const feed of feeds) feed.write('data: ' + JSON.stringify({ type, data: {} }) + '\\n\\n'); };
  if (!process.env.NO_CATALOG_EVENTS) fs.watchFile(process.env.CATALOG_FILE, { interval: 20 }, () => emit('model.updated'));
  if (!process.env.NO_CATALOG_EVENTS) fs.watchFile(process.env.CATALOG_FILE + '.providers', { interval: 20 }, () => emit('provider.updated'));
  if (!process.env.NO_CATALOG_EVENTS) fs.watchFile(process.env.CATALOG_FILE + '.commands', { interval: 20 }, () => emit('command.updated'));
  if (!process.env.NO_CATALOG_EVENTS) fs.watchFile(process.env.CATALOG_FILE + '.skills', { interval: 20 }, () => emit('skill.updated'));
  const waitForRelease = async suffix => {
    while (fs.existsSync(process.env.CATALOG_FILE + suffix)) await new Promise(resolve => setTimeout(resolve, 10).unref());
  };
  let activated = !process.env.ACTIVATION_DELAY_MS && !fs.existsSync(process.env.CATALOG_FILE + '.activation-hold'), activation;
  const server = http.createServer(async (req, res) => {
    const auth = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_PASSWORD).toString('base64');
    const url = new URL(req.url, 'http://localhost');
    if (req.headers.authorization !== auth || url.searchParams.get('location[directory]') !== process.cwd()) {
      res.writeHead(403); res.end(); return;
    }
    if (url.pathname === '/api/event') {
      fs.writeFileSync(process.env.ENDPOINT_FILE + '.event-pending', '');
      res.on('close', () => fs.writeFileSync(process.env.ENDPOINT_FILE + '.event-closed', ''));
      while (fs.existsSync(process.env.CATALOG_FILE + '.event-hold')) await new Promise(resolve => setTimeout(resolve, 10));
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      feeds.add(res);
      res.write('data: ' + JSON.stringify({ type: 'server.connected', data: {} }) + '\\n\\n');
      res.on('close', () => feeds.delete(res));
      fs.writeFileSync(process.env.ENDPOINT_FILE + '.subscribed', '');
      return;
    }
    if (req.method !== 'GET' || !['/api/model', '/api/command', '/api/skill', '/api/integration', '/api/provider'].includes(url.pathname)) {
      res.writeHead(405); res.end(); return;
    }
    // Provider display names are optional: without a providers file the endpoint is absent, as in older versions.
    if (url.pathname === '/api/provider') {
      if (!fs.existsSync(process.env.CATALOG_FILE + '.providers')) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ location: { directory: process.cwd() }, data: JSON.parse(fs.readFileSync(process.env.CATALOG_FILE + '.providers', 'utf8')) }));
      return;
    }
    activation ??= (async () => {
      await waitForRelease('.activation-hold');
      if (process.env.ACTIVATION_DELAY_MS) await new Promise(resolve => setTimeout(resolve, Number(process.env.ACTIVATION_DELAY_MS)));
      activated = true;
    })();
    if (url.pathname === '/api/integration') {
      fs.writeFileSync(process.env.ENDPOINT_FILE + '.integration', '');
      if (process.env.INTEGRATION_STATUS === 'hang') {
        res.on('close', () => fs.writeFileSync(process.env.ENDPOINT_FILE + '.integration-aborted', ''));
        return;
      }
      if (process.env.INTEGRATION_STATUS) { res.writeHead(Number(process.env.INTEGRATION_STATUS)).end(); return; }
      await activation;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [] })); return;
    }
    if (fs.existsSync(process.env.CATALOG_FILE + '.invalid')) {
      res.setHeader('Content-Type', 'application/json');
      res.end('{}'); return;
    }
    if (url.pathname === '/api/model' && fs.existsSync(process.env.CATALOG_FILE + '.error')) {
      const error = JSON.parse(fs.readFileSync(process.env.CATALOG_FILE + '.error', 'utf8'));
      res.writeHead(error.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(error.body)); return;
    }
    if (url.pathname === '/api/model') {
      reads++;
      fs.writeFileSync(process.env.ENDPOINT_FILE + '.read', String(reads));
      if (fs.existsSync(process.env.CATALOG_FILE + '.hang') || reads > 1 && fs.existsSync(process.env.CATALOG_FILE + '.hang-after-first')) {
        fs.writeFileSync(process.env.ENDPOINT_FILE + '.model-pending', '');
        res.on('close', () => fs.writeFileSync(process.env.ENDPOINT_FILE + '.model-aborted', ''));
        return;
      }
      while (fs.existsSync(process.env.CATALOG_FILE + '.hold')) await new Promise(resolve => setTimeout(resolve, 10));
      if (res.destroyed) return;
    }
    const catalog = JSON.parse(fs.readFileSync(process.env.CATALOG_FILE, 'utf8'))
      .filter(model => activated || model.providerID !== 'opencode-go');
    // A fresh native instance loads its command catalog after its first read.
    let data = url.pathname === '/api/model'
      ? catalog
      : url.pathname === '/api/skill'
        ? (fs.existsSync(process.env.CATALOG_FILE + '.skills') ? JSON.parse(fs.readFileSync(process.env.CATALOG_FILE + '.skills', 'utf8')) : [{ id: 'writing', name: 'writing', description: 'Writing guide', path: '/skills/writing/SKILL.md', content: '' }])
        : (fs.existsSync(process.env.CATALOG_FILE + '.commands') ? JSON.parse(fs.readFileSync(process.env.CATALOG_FILE + '.commands', 'utf8')) : [{ name: 'review', description: 'Review changes' }]);
    // Older v2 instances can return empty startup snapshots before discovery completes, without events.
    const resourceReads = url.pathname === '/api/model' ? reads : url.pathname === '/api/command' ? ++commandReads : ++skillReads;
    if (resourceReads <= Number(process.env.EMPTY_INITIAL_READS || 0)) data = [];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ location: { directory: process.cwd() }, data }));
  });
  server.listen(0, '127.0.0.1', async () => {
    const url = 'http://127.0.0.1:' + server.address().port;
    // Publish atomically: tests poll for this file and read it immediately.
    fs.writeFileSync(process.env.ENDPOINT_FILE + '.tmp', url);
    fs.renameSync(process.env.ENDPOINT_FILE + '.tmp', process.env.ENDPOINT_FILE);
    fs.writeFileSync(process.env.ENDPOINT_FILE + '.pid', String(process.pid));
    await waitForRelease('.ready-hold');
    setTimeout(() => process.stdout.write(JSON.stringify({ url: process.env.INVALID_READY === '1' ? 'https://example.com' : url }) + '\\n'), Number(process.env.READY_DELAY_MS || 0));
  });
  process.stdin.resume();
  process.stdin.on('end', () => { fs.unwatchFile(process.env.CATALOG_FILE); fs.unwatchFile(process.env.CATALOG_FILE + '.providers'); fs.unwatchFile(process.env.CATALOG_FILE + '.commands'); fs.unwatchFile(process.env.CATALOG_FILE + '.skills'); for (const feed of feeds) feed.end(); server.close(); });
}
`;

const pluginEnvironmentKeys = [
  'OPENCODE_DB',
  'EXPECTED_DATABASE',
  'CATALOG_FILE',
  'ENDPOINT_FILE',
  'READY_DELAY_MS',
  'ACTIVATION_DELAY_MS',
  'INTEGRATION_STATUS',
  'NO_CATALOG_EVENTS',
  'EMPTY_INITIAL_READS',
];

export interface OpencodeHTTPMetadataFixture {
  readonly root: string;
  readonly cliPath: string;
  readonly environment: NodeJS.ProcessEnv;
  writeCatalog(name?: string): void;
  createPlugin(): any;
  dispose(): void;
}

/** Creates an isolated native OpenCode CLI fixture with its catalog and endpoint files. */
export function createOpencodeHTTPMetadataFixture(): OpencodeHTTPMetadataFixture {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-opencode-catalog-')));
  const cliPath = path.join(root, 'opencode.cjs');
  writeFileSync(cliPath, cliFixture, { mode: 0o700 });
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_DB: path.join(root, 'native.db'),
    EXPECTED_DATABASE: path.join(root, 'native.db'),
    CATALOG_FILE: path.join(root, 'catalog.json'),
    ENDPOINT_FILE: path.join(root, 'endpoint'),
  };

  const writeCatalog = (name = 'DeepSeek Chat'): void => {
    // The native fixture may read the catalog mid-update; a rename keeps it from parsing a truncated file.
    const pending = environment.CATALOG_FILE! + '.pending';
    writeFileSync(pending, JSON.stringify([
      { providerID: 'deepseek', id: 'chat', name, enabled: true, variants: [{ id: 'high' }] },
      { providerID: 'deepseek', id: 'disabled', name: 'Disabled', enabled: false, variants: [] },
    ]));
    renameSync(pending, environment.CATALOG_FILE!);
  };

  const createPlugin = (): any => {
    const plugin: any = {
      workingDirectory: root,
      getResolvedProviderCliPath: async () => cliPath,
      executionLifecycleRegistry: { registerTransitionHook: vi.fn(() => () => undefined) },
      notifyProviderChatOptionsChanged: () => undefined,
      settings: { providerConfigs: { opencode: {
        enabled: true,
        visibleModels: [],
        environmentVariables: Object.entries(environment)
          .filter(([key]) => pluginEnvironmentKeys.includes(key))
          .map(([key, value]) => `${key}=${value}`).join('\n'),
      } } },
      mutateSettings: async (mutation: (settings: Record<string, unknown>) => void) => mutation(plugin.settings),
      mutateSettingsConditionally: async (mutation: (settings: Record<string, unknown>) => void) => mutation(plugin.settings),
    };
    return plugin;
  };

  writeCatalog();
  return {
    root,
    cliPath,
    environment,
    writeCatalog,
    createPlugin,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

export async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 40_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Fixture did not reach the expected state.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
