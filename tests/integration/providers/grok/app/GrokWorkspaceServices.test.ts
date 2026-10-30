// @test-ci {"native":true,"inputs":["tests/fixtures/providers/grok/runtime/models-list.json","tests/fixtures/providers/grok/runtime/models-list-byok.json","tests/fixtures/providers/grok/runtime/GrokModelCatalogProcess.mjs"]}
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { once } from 'node:events';
import * as path from 'node:path';
import { setImmediate } from 'node:timers/promises';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { writeGrokCatalog } from '@test/helpers/providers/grokSettings';
import spawn from 'cross-spawn';

import { GrokCommandMetadataProbe } from '@/providers/grok/app/GrokCommandMetadataProbe';
import { createGrokWorkspaceServices, grokWorkspaceRegistration } from '@/providers/grok/app/GrokWorkspaceServices';
import type { GrokExecutionNativeCreateOptions } from '@/providers/grok/execution/GrokExecutionBackend';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const peer = path.resolve('tests/fixtures/providers/grok/runtime/GrokModelCatalogProcess.mjs');
let children: ChildProcess[];
let waiting: (() => void) | undefined;

beforeEach(() => {
  children = [];
  waiting = undefined;
  vi.mocked(spawn).mockImplementation((_command, args, options) => {
    const child = nodeSpawn(process.execPath, [peer, ...(args ?? [])], options ?? {});
    children.push(child);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('fixture/waiting')) waiting?.();
    });
    return child;
  });
});

afterEach(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  vi.mocked(spawn).mockReset();
});

async function createFixture(scenario = '') {
  const fixture = await createProviderHostFixture({
    settings: { providerConfigs: { grok: { enabled: true, visibleModels: ['grok-4.5'], environmentVariables: `GROK_CATALOG_SCENARIO=${scenario}` } } },
    overrides: { workingDirectory: process.cwd(), getResolvedProviderCliPath: async () => 'fixture-grok' },
  });
  writeGrokCatalog(fixture.settings, {
    defaultModelId: 'grok-4.5', fingerprint: 'cached-fingerprint', refreshedAt: Date.now(),
    models: [{ displayName: 'Cached model', rawId: 'grok-4.5', reasoningEfforts: [], supportsReasoning: false }],
  });
  return fixture;
}

it('exposes the cached catalog without a warmup process and refreshes from the native peer on demand', async () => {
  const { host, lifecycle } = await createFixture();
  const services = await lifecycle.runTransition(['grok'], transitionScope => grokWorkspaceRegistration.initialize({ plugin: host, transitionScope }));
  try {
    expect(services.modelCatalogCoordinator.getCachedCatalog()).toMatchObject({ fingerprint: 'cached-fingerprint' });
    expect(spawn).not.toHaveBeenCalled();
    await services.modelCatalog!.refresh({ force: true });
    expect(services.modelCatalogCoordinator.getCachedCatalog()?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ rawId: 'grok-4.6', displayName: 'Grok 4.6' }),
    ]));
    expect(children.length).toBeGreaterThan(0);
    expect(children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  } finally { await services.dispose(); }
});

it.each([
  ['dispose', 'catalog'], ['dispose', 'coordinator'],
  ['transition', 'catalog'], ['transition', 'coordinator'],
] as const)('drains an active native model probe before %s completes through the %s', async (action, entry) => {
  const { host, lifecycle } = await createFixture('hang-list');
  const services = await createGrokWorkspaceServices(host);
  const blocked = new Promise<void>(resolve => { waiting = resolve; });
  const observed = vi.fn();
  services.modelCatalog!.observe(observed);
  const refresh = entry === 'catalog' ? services.modelCatalog!.refresh() : services.modelCatalogCoordinator.refresh();
  await blocked;
  const child = children.at(-1)!;
  const exited = once(child, 'exit');
  const aliveAtMutation: boolean[] = [];
  try {
    if (action === 'dispose') await services.dispose();
    else await lifecycle.runTransition(['grok'], async () => {
      aliveAtMutation.push(child.exitCode === null && child.signalCode === null);
    });
    expect(aliveAtMutation).toEqual(action === 'transition' ? [false] : []);
    expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    await Promise.all([refresh, exited]);
    await services.dispose();
    observed.mockClear();
    await services.modelCatalog!.refresh({ force: true });
    expect(observed).not.toHaveBeenCalled();
    const quiesce = vi.spyOn(services.modelCatalogCoordinator, 'quiesceForEnvironmentChange');
    await lifecycle.runTransition(['grok'], async () => undefined);
    expect(quiesce).not.toHaveBeenCalled();
  } finally { await services.dispose(); }
});

it.each(['dispose', 'transition'] as const)('cancels an active command probe and joins native shutdown before %s completes', async action => {
  const { host, lifecycle } = await createFixture();
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let shutdownStarted!: () => void;
  const shuttingDown = new Promise<void>(resolve => { shutdownStarted = resolve; });
  let releaseShutdown!: () => void;
  const shutdownGate = new Promise<void>(resolve => { releaseShutdown = resolve; });
  let aborted = false;
  let shutdownCompleted = false;
  const shutdown = vi.fn(async () => {
    shutdownStarted();
    await shutdownGate;
    shutdownCompleted = true;
  });
  const commandMetadataProbe = new GrokCommandMetadataProbe(host.getRuntimeHost('grok'), {
    create: () => ({
      cancel: vi.fn(), initialize: vi.fn(async () => undefined),
      listCommands: (_cwd, signal) => new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => {
          aborted = true;
          reject(signal!.reason);
        }, { once: true });
        started();
      }),
      loadSession: vi.fn(), newSession: vi.fn(), onNotification: vi.fn(() => vi.fn()),
      prompt: vi.fn(), setMode: vi.fn(), setModel: vi.fn(), shutdown,
    }),
  });
  const services = await createGrokWorkspaceServices(host, { commandMetadataProbe });
  const loading = services.commandLoader!.loadCommands({ allowIsolatedMetadataCreation: true, conversation: null, plugin: host });
  await entered;
  let finished = false;
  const shutdownAtMutation: boolean[] = [];
  const completion = (action === 'dispose' ? services.dispose() : lifecycle.runTransition(['grok'], async () => {
    shutdownAtMutation.push(shutdownCompleted);
  })).then(() => { finished = true; });
  try {
    expect(await Promise.race([
      shuttingDown.then(() => 'shutdown'), completion.then(() => 'completed'),
    ])).toBe('shutdown');
    expect(aborted).toBe(true);
    // The native shutdown gate is held; a task turn only bounds a forbidden early completion.
    await setImmediate();
    expect(finished).toBe(false);
    expect(shutdownAtMutation).toEqual([]);
    releaseShutdown();
    await Promise.all([completion, loading]);
    expect(shutdownCompleted).toBe(true);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdownAtMutation).toEqual(action === 'transition' ? [true] : []);
  } finally {
    releaseShutdown();
    await commandMetadataProbe.dispose();
    await Promise.all([completion, loading]);
    await services.dispose();
  }
});

it('fences command and model discovery throughout the real workspace transition', async () => {
  const { host, lifecycle } = await createFixture();
  let cliPath = '/configured/grok-a';
  vi.spyOn(host, 'getResolvedProviderCliPath').mockImplementation(async () => cliPath);
  const nativeCreate = vi.fn((options: GrokExecutionNativeCreateOptions) => ({
    cancel: vi.fn(), initialize: vi.fn(async () => undefined),
    listCommands: vi.fn(async () => [{ content: '', id: `grok:${options.command}`, kind: 'command' as const,
      name: `from-${options.command}`, source: 'sdk' as const }]),
    loadSession: vi.fn(), newSession: vi.fn(), onNotification: vi.fn(() => vi.fn()),
    prompt: vi.fn(), setMode: vi.fn(), setModel: vi.fn(), shutdown: vi.fn(async () => undefined),
  }));
  const commandMetadataProbe = new GrokCommandMetadataProbe(host.getRuntimeHost('grok'), { create: nativeCreate });
  const services = await createGrokWorkspaceServices(host, { commandMetadataProbe });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let admitted!: () => void;
  const inMutation = new Promise<void>(resolve => { admitted = resolve; });
  const transition = lifecycle.runTransition(['grok'], async () => { admitted(); await gate; cliPath = '/configured/grok-b'; });
  await inMutation;
  const commandLoad = services.commandLoader!.loadCommands({ allowIsolatedMetadataCreation: true, conversation: null, plugin: host });
  const refresh = services.modelCatalog!.refresh();
  try {
    // The transition mutation is the barrier: neither discovery can cross its fence.
    expect(nativeCreate).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    release();
    await transition;
    await expect(commandLoad).resolves.toMatchObject({ items: [expect.objectContaining({ name: 'from-/configured/grok-b' })], status: 'ready' });
    await refresh;
    expect(services.modelCatalogCoordinator.getCachedCatalog()?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ rawId: 'grok-4.6' }),
    ]));
    expect(nativeCreate).toHaveBeenCalledTimes(1);
  } finally { release(); await transition; await services.dispose(); }
});
