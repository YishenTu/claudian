import { mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createProviderHostFixture, type ProviderHostFixtureOptions } from '@test/helpers/providerRuntimeHost';
import { writeOpencodeNativePeer } from '@test/helpers/providers/opencode/OpencodeNativePeer';
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
  createHostFixture(options?: { config?: Record<string, unknown>; beforePersist?: ProviderHostFixtureOptions['beforePersist'] }): ReturnType<typeof createProviderHostFixture>;
  dispose(): void;
}

/** Creates an isolated native OpenCode CLI fixture with its catalog and endpoint files. */
export function createOpencodeHTTPMetadataFixture(): OpencodeHTTPMetadataFixture {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-opencode-catalog-')));
  const cliPath = path.join(root, 'opencode.cjs');
  writeOpencodeNativePeer(cliPath, { scenario: 'metadata', version: '2.2.0' });
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

  const createHostFixture = (options: { config?: Record<string, unknown>; beforePersist?: ProviderHostFixtureOptions['beforePersist'] } = {}) => createProviderHostFixture({
    settings: { providerConfigs: { opencode: {
      enabled: true, visibleModels: [],
      environmentVariables: Object.entries(environment)
        .filter(([key]) => pluginEnvironmentKeys.includes(key))
        .map(([key, value]) => `${key}=${value}`).join('\n'),
      ...options.config,
    } } },
    beforePersist: options.beforePersist,
    overrides: { workingDirectory: root, getResolvedProviderCliPath: async () => cliPath },
  });

  writeCatalog();
  return {
    root,
    cliPath,
    environment,
    writeCatalog,
    createHostFixture,
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
