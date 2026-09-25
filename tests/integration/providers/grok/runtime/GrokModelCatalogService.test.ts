import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import * as path from 'node:path';

jest.mock('cross-spawn', () => jest.fn());
import spawn from 'cross-spawn';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import { GrokModelCatalogService } from '@/providers/grok/runtime/GrokModelCatalogService';

const fixture = path.resolve('tests/fixtures/providers/grok/runtime/GrokModelCatalogProcess.mjs');
let children: ChildProcess[];
let onWaiting: (() => void) | undefined;

function makeService(scenario = '', timeoutMs = 2_000): GrokModelCatalogService {
  const host = {
    app: { vault: { adapter: { basePath: process.cwd() } } },
    getResolvedProviderCliPath: async () => 'fixture-grok',
    settings: {
      providerConfigs: { grok: {
        enabled: true,
        environmentVariables: `GROK_CATALOG_SCENARIO=${scenario}`,
      } },
    },
  } as unknown as ProviderHost;
  return new GrokModelCatalogService(host, { modelCommandTimeoutMs: timeoutMs });
}

beforeEach(() => {
  children = [];
  onWaiting = undefined;
  jest.mocked(spawn).mockImplementation((_command, args, options) => {
    const child = nodeSpawn(process.execPath, [fixture, ...(args ?? [])], options ?? {});
    children.push(child);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('fixture/waiting')) onWaiting?.();
    });
    return child;
  });
});

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  jest.mocked(spawn).mockReset();
});

function expectProcessesClosed(): void {
  expect(children.length).toBeGreaterThan(0);
  expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
}

it('discovers distinct native effort menus without a chat session and closes the process', async () => {
  const result = await makeService().discoverCatalog();

  expect(result).toMatchObject({
    kind: 'completed',
    defaultModelId: 'grok-4.6',
    models: [
      expect.objectContaining({
        rawId: 'grok-4.6', displayName: 'Grok 4.6', defaultReasoningEffort: 'high',
        reasoningMetadataResolved: true,
        supportsReasoning: true,
        reasoningEfforts: [
          expect.objectContaining({ value: 'xhigh', label: 'Extra High Effort' }),
          expect.objectContaining({ value: 'high', label: 'High Effort' }),
          expect.objectContaining({ value: 'medium', label: 'Medium Effort' }),
          expect.objectContaining({ value: 'low', label: 'Low Effort' }),
        ],
      }),
      expect.objectContaining({
        rawId: 'grok-4.5', defaultReasoningEffort: 'high', reasoningMetadataResolved: true,
        reasoningEfforts: [
          expect.objectContaining({ value: 'high' }),
          expect.objectContaining({ value: 'medium' }),
          expect.objectContaining({ value: 'low' }),
        ],
      }),
    ],
  });
  expectProcessesClosed();
});

it.each(['unsupported', 'malformed', 'extension-error'])(
  'falls back to CLI model discovery after %s and closes both processes', async scenario => {
    const result = await makeService(scenario).discoverCatalog();

    expect(result).toMatchObject({
      kind: 'completed', defaultModelId: 'legacy-model',
      models: [{ rawId: 'legacy-model', reasoningEfforts: [] }],
    });
    expect(JSON.stringify(result)).not.toContain('private provider diagnostic');
    expectProcessesClosed();
  },
);

it('preserves an authoritative empty catalog', async () => {
  expect(await makeService('empty').discoverCatalog()).toMatchObject({
    kind: 'completed', models: [],
  });
  expectProcessesClosed();
});

it.each(['hang-initialize', 'hang-list'])(
  'cancels %s without falling back and closes the process', async scenario => {
    const controller = new AbortController();
    onWaiting = () => controller.abort();

    expect(await makeService(scenario).discoverCatalog(controller.signal)).toMatchObject({
      kind: 'completed', models: [], diagnostics: 'Grok models was cancelled',
    });
    expectProcessesClosed();
  },
);

it.each(['hang-initialize', 'hang-list'])(
  'times out %s, closes the process, and uses the legacy catalog', async scenario => {
    expect(await makeService(scenario, 200).discoverCatalog()).toMatchObject({
      kind: 'completed', models: [{ rawId: 'legacy-model' }],
    });
    expectProcessesClosed();
  },
);

it('distinguishes configurable Grok 4.7 reasoning from non-reasoning API-key models', async () => {
  expect(await makeService('byok').discoverCatalog()).toMatchObject({
    kind: 'completed',
    models: [
      { rawId: 'grok-4.20-0309-non-reasoning', reasoningMetadataResolved: true, reasoningEfforts: [], supportsReasoning: false },
      {
        rawId: 'grok-4.7', reasoningMetadataResolved: true, defaultReasoningEffort: 'high',
        reasoningEfforts: [
          expect.objectContaining({ value: 'low' }),
          expect.objectContaining({ value: 'medium' }),
          expect.objectContaining({ value: 'high' }),
          expect.objectContaining({ value: 'xhigh' }),
        ],
      },
    ],
  });
  expectProcessesClosed();
});
