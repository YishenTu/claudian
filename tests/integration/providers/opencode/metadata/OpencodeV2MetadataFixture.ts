import { mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import * as ProcessProbe from '@/core/process/ProcessProbe';

// These suites test native metadata and lifecycle behavior, not cold-launch speed.
jest.setTimeout(45_000);
// Keep probing real, with the same default allowance as the other native OpenCode suites.
const runProcessProbe = ProcessProbe.runProcessProbe;
let probe: jest.SpyInstance;
beforeEach(() => {
  probe = jest.spyOn(ProcessProbe, 'runProcessProbe').mockImplementation((options, timeoutMs = 30_000) => runProcessProbe(options, timeoutMs));
});
afterEach(() => probe.mockRestore());

// External OpenCode boundary: its native catalog endpoints and stdio ownership lease.
const cliFixture = `#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
if (process.argv.includes('--version')) {
  process.stdout.write('opencode v2.0.12\\n');
} else {
  if (!process.argv.includes('--stdio') || process.env.OPENCODE_DB !== process.env.EXPECTED_DATABASE) process.exit(2);
  let reads = 0, commandReads = 0;
  let activated = !process.env.ACTIVATION_DELAY_MS, activation;
  const server = http.createServer(async (req, res) => {
    const auth = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_PASSWORD).toString('base64');
    const url = new URL(req.url, 'http://localhost');
    if (req.headers.authorization !== auth || url.searchParams.get('location[directory]') !== process.cwd()) {
      res.writeHead(403); res.end(); return;
    }
    if (req.method !== 'GET' || !['/api/model', '/api/command', '/api/skill', '/api/integration'].includes(url.pathname)) {
      res.writeHead(405); res.end(); return;
    }
    activation ??= new Promise(resolve => setTimeout(() => { activated = true; resolve(); }, Number(process.env.ACTIVATION_DELAY_MS || 0)));
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
    if (url.pathname === '/api/model' && fs.existsSync(process.env.CATALOG_FILE + '.hang')) return;
    const catalog = JSON.parse(fs.readFileSync(process.env.CATALOG_FILE, 'utf8'))
      .filter(model => activated || model.providerID !== 'opencode-go');
    // A fresh native instance loads its command catalog after its first read.
    const data = url.pathname === '/api/model'
      ? (++reads === 1 && !process.env.ACTIVATION_DELAY_MS ? [] : catalog)
      : url.pathname === '/api/skill'
        ? [{ id: 'writing', name: 'writing', description: 'Writing guide', path: '/skills/writing/SKILL.md', content: '' }]
        : (++commandReads === 1 ? [] : [{ name: 'review', description: 'Review changes' }]);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ location: { directory: process.cwd() }, data }));
    if (url.pathname === '/api/model') fs.writeFileSync(process.env.ENDPOINT_FILE + '.read', String(reads));
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

const pluginEnvironmentKeys = [
  'OPENCODE_DB',
  'EXPECTED_DATABASE',
  'CATALOG_FILE',
  'ENDPOINT_FILE',
  'READY_DELAY_MS',
  'ACTIVATION_DELAY_MS',
  'INTEGRATION_STATUS',
];

export interface OpencodeV2MetadataFixture {
  readonly root: string;
  readonly cliPath: string;
  readonly environment: NodeJS.ProcessEnv;
  writeCatalog(name?: string): void;
  createPlugin(): any;
  dispose(): void;
}

/** Creates an isolated native OpenCode CLI fixture with its catalog and endpoint files. */
export function createOpencodeV2MetadataFixture(): OpencodeV2MetadataFixture {
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
      executionLifecycleRegistry: { registerTransitionHook: jest.fn(() => () => undefined) },
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
