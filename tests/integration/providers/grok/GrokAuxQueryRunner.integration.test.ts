import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import { GrokAuxiliaryLifecycleCoordinator } from '@/providers/grok/auxiliary/GrokAuxiliaryLifecycleCoordinator';
import { GrokAuxQueryRunner } from '@/providers/grok/runtime/GrokAuxQueryRunner';

const fixturePath = path.join(
  process.cwd(),
  'tests/fixtures/providers/grok/runtime/aux-notification-agent.mjs',
);

function createHost(vaultPath: string, logPath: string): ProviderHost {
  return {
    app: { vault: { adapter: { basePath: vaultPath } } },
    getResolvedProviderCliPath: jest.fn(async () => fixturePath),
    manifest: { version: 'integration-test' },
    settings: {
      providerConfigs: {
        grok: {
          enabled: true,
          environmentVariables: `GROK_AUX_FIXTURE_LOG=${logPath}`,
        },
      },
    },
  } as unknown as ProviderHost;
}

async function readEvents(logPath: string): Promise<Array<Record<string, unknown>>> {
  const content = await fs.readFile(logPath, 'utf8').catch(() => '');
  return content.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

describe('GrokAuxQueryRunner JSON-RPC integration', () => {
  let runner: GrokAuxQueryRunner | null = null;
  let tempDirectory = '';
  let logPath = '';

  beforeEach(async () => {
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'claudian-grok-aux-'));
    logPath = path.join(tempDirectory, 'agent.jsonl');
  });

  afterEach(async () => {
    await runner?.cleanup();
    runner = null;
    if (tempDirectory) await fs.rm(tempDirectory, { force: true, recursive: true });
  });

  it('aggregates xAI aliases and the exact wrapped notification from line-delimited transport', async () => {
    runner = new GrokAuxQueryRunner(createHost(tempDirectory, logPath), { timeoutMs: 2_000 });

    await expect(runner.query({ systemPrompt: 'Auxiliary prompt' }, 'aliases')).resolves.toBe(
      'alias-one alias-two wrapped',
    );

    await runner.cleanup();
    runner = null;
    const events = await readEvents(logPath);
    expect(events.filter(event => event.event === 'shutdown')).toHaveLength(1);
  });

  it.each(['title', 'refine', 'inline'])(
    'aggregates standard ACP session/update text for the %s workflow without alias duplication',
    async (workflow) => {
      runner = new GrokAuxQueryRunner(createHost(tempDirectory, logPath), { timeoutMs: 2_000 });
      const chunks: string[] = [];

      await expect(runner.query({
        onTextChunk: text => chunks.push(text),
        systemPrompt: `${workflow} prompt`,
      }, `standard-${workflow}`)).resolves.toBe(`${workflow}-one ${workflow}-two`);
      expect(chunks).toEqual([`${workflow}-one`, `${workflow}-one ${workflow}-two`]);
    },
  );

  it('recycles an aborted connection before an immediate follow-up and reloads the session', async () => {
    const abortController = new AbortController();
    runner = new GrokAuxQueryRunner(createHost(tempDirectory, logPath), { timeoutMs: 2_000 });

    await expect(runner.query({
      abortController,
      onTextChunk: () => abortController.abort(),
      systemPrompt: 'Auxiliary prompt',
    }, 'cancel')).rejects.toThrow('Cancelled');
    await expect(runner.query({ systemPrompt: 'Auxiliary prompt' }, 'follow-up')).resolves.toBe('new');

    await runner.cleanup();
    runner = null;
    const events = await readEvents(logPath);
    expect(events.filter(event => event.event === 'start')).toHaveLength(2);
    expect(events.filter(event => event.method === 'session/load')).toHaveLength(1);
    expect(events.filter(event => event.method === 'session/cancel')).toHaveLength(1);
    expect(events.findIndex(event => event.method === 'session/cancel')).toBeLessThan(
      events.findIndex(event => event.event === 'shutdown'),
    );
    expect(events.filter(event => event.event === 'shutdown')).toHaveLength(2);
  });

  it('delivers one timeout cancel before shutdown and reloads without an orphan process', async () => {
    runner = new GrokAuxQueryRunner(createHost(tempDirectory, logPath), { timeoutMs: 20 });

    await expect(runner.query({ systemPrompt: 'Auxiliary prompt' }, 'cancel')).rejects.toThrow(
      'Grok auxiliary query timed out after 20ms.',
    );
    await expect(runner.query({ systemPrompt: 'Auxiliary prompt' }, 'follow-up')).resolves.toBe('new');

    await runner.cleanup();
    runner = null;
    const events = await readEvents(logPath);
    expect(events.filter(event => event.method === 'session/cancel')).toHaveLength(1);
    expect(events.findIndex(event => event.method === 'session/cancel')).toBeLessThan(
      events.findIndex(event => event.event === 'shutdown'),
    );
    expect(events.filter(event => event.event === 'start')).toHaveLength(2);
    expect(events.filter(event => event.method === 'session/load')).toHaveLength(1);
    expect(events.filter(event => event.event === 'shutdown')).toHaveLength(2);
  });

  it('reloads the same auxiliary binding when returning from explicit to native default', async () => {
    runner = new GrokAuxQueryRunner(createHost(tempDirectory, logPath), { timeoutMs: 2_000 });

    await expect(runner.query({
      model: 'grok/model-a',
      systemPrompt: 'Retained instruction prompt',
    }, 'explicit-context')).resolves.toBe('seeded');
    await expect(runner.query({
      model: 'grok',
      systemPrompt: 'Retained instruction prompt',
    }, 'native-continuation')).resolves.toBe('continued');

    await runner.cleanup();
    runner = null;
    const events = await readEvents(logPath);
    expect(events.filter(event => event.event === 'start')).toHaveLength(2);
    expect(events.filter(event => event.method === 'session/new')).toHaveLength(1);
    expect(events.filter(event => event.method === 'session/load')).toEqual([
      expect.objectContaining({ sessionId: 'fixture-aux-session' }),
    ]);
    expect(events.filter(event => event.method === 'session/set_model')).toEqual([
      expect.objectContaining({ modelId: 'model-a', sessionId: 'fixture-aux-session' }),
    ]);
    expect(events.filter(event => event.method === 'session/prompt')).toEqual([
      expect.objectContaining({ sessionId: 'fixture-aux-session' }),
      expect.objectContaining({ sessionId: 'fixture-aux-session' }),
    ]);
    expect(events.filter(event => event.event === 'shutdown')).toHaveLength(2);
  });

  it('awaits environment shutdown and reloads the retained binding in the new context', async () => {
    const host = createHost(tempDirectory, logPath);
    const lifecycle = new GrokAuxiliaryLifecycleCoordinator();
    const config = (host.settings as any).providerConfigs.grok;
    config.environmentVariables += '\nGROK_PROFILE=old';
    runner = new GrokAuxQueryRunner(host, { lifecycle, timeoutMs: 2_000 });
    let sawOldChunk!: () => void;
    const oldChunk = new Promise<void>(resolve => { sawOldChunk = resolve; });
    const active = runner.query({
      onTextChunk: () => sawOldChunk(),
      systemPrompt: 'Retained instruction prompt',
    }, 'cancel');
    await oldChunk;

    const transition = await lifecycle.beginEnvironmentChange();
    await expect(active).rejects.toThrow('Cancelled');
    const continuation = runner.query({
      systemPrompt: 'Retained instruction prompt',
    }, 'follow-up');
    await new Promise(resolve => setImmediate(resolve));
    expect((await readEvents(logPath)).filter(event => event.event === 'start')).toEqual([
      expect.objectContaining({ profile: 'old' }),
    ]);
    config.environmentVariables = config.environmentVariables.replace('GROK_PROFILE=old', 'GROK_PROFILE=new');
    await transition.release();
    await expect(continuation).resolves.toBe('new');

    await runner.cleanup();
    runner = null;
    const events = await readEvents(logPath);
    expect(events.filter(event => event.event === 'start')).toEqual([
      expect.objectContaining({ profile: 'old' }),
      expect.objectContaining({ profile: 'new' }),
    ]);
    expect(events.filter(event => event.method === 'session/load')).toEqual([
      expect.objectContaining({ sessionId: 'fixture-aux-session' }),
    ]);
    expect(events.filter(event => event.event === 'shutdown')).toHaveLength(2);
  });

  it('aborts behind the environment gate without spawning or retaining a lifecycle participant', async () => {
    const lifecycle = new GrokAuxiliaryLifecycleCoordinator();
    const transition = await lifecycle.beginEnvironmentChange();
    const abortController = new AbortController();
    runner = new GrokAuxQueryRunner(createHost(tempDirectory, logPath), {
      lifecycle,
      timeoutMs: 2_000,
    });
    const quiesce = jest.spyOn(runner, 'quiesceForEnvironmentChange');

    const blocked = runner.query({
      abortController,
      systemPrompt: 'Blocked auxiliary prompt',
    }, 'blocked');
    await new Promise(resolve => setImmediate(resolve));
    abortController.abort();

    await expect(blocked).rejects.toThrow('Cancelled');
    expect(await readEvents(logPath)).toEqual([]);

    await transition.release();
    const nextTransition = await lifecycle.beginEnvironmentChange();
    expect(quiesce).not.toHaveBeenCalled();
    await nextTransition.release();
  });
});
