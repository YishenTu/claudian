import type { ProviderHost } from '@/core/providers/ProviderHost';
import { GrokCommandMetadataProbe } from '@/providers/grok/app/GrokCommandMetadataProbe';
import type {
  GrokExecutionNativeConnection,
  GrokExecutionNativeCreateOptions,
  GrokExecutionNativeFactory,
} from '@/providers/grok/execution/GrokExecutionBackend';

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class FakeMetadataNative implements GrokExecutionNativeConnection {
  readonly listStarted = new Deferred<void>();
  shutdownCalls = 0;

  constructor(
    private readonly commandName: string,
    private readonly waitForAbort: boolean,
  ) {}

  cancel(): void {}
  async initialize(): Promise<void> {}
  async loadSession(): Promise<never> { throw new Error('unused'); }
  async newSession(): Promise<never> { throw new Error('unused'); }
  onNotification(): () => void { return () => undefined; }
  async prompt(): Promise<never> { throw new Error('unused'); }
  async setMode(): Promise<void> {}
  async setModel(): Promise<Record<string, never>> {
    return {};
  }

  async listCommands(_cwd: string, signal?: AbortSignal): Promise<any[]> {
    this.listStarted.resolve();
    if (this.waitForAbort) {
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => reject(new Error('metadata probe aborted'));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    }
    return [{
      content: '',
      id: `grok:${this.commandName}`,
      kind: 'command',
      name: this.commandName,
      source: 'sdk',
    }];
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }
}

describe('GrokCommandMetadataProbe', () => {
  it('registers a load before a synchronously started transition quiesces', async () => {
    const cliResolution = new Deferred<string | null>();
    const nativeFactory: GrokExecutionNativeFactory = {
      create: jest.fn(() => new FakeMetadataNative('stale', false)),
    };
    const plugin = {
      app: { vault: { adapter: { basePath: '/tmp/grok-vault' } } },
      getResolvedProviderCliPath: jest.fn(() => cliResolution.promise),
      manifest: { version: 'test' },
      settings: {},
    } as unknown as ProviderHost;
    const probe = new GrokCommandMetadataProbe(plugin, nativeFactory);

    const load = probe.load();
    probe.beginEnvironmentTransition();
    let quiesced = false;
    const quiescence = probe.quiesceForEnvironmentChange().then(() => {
      quiesced = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(quiesced).toBe(false);
    cliResolution.resolve('/configured/grok');
    await expect(load).rejects.toThrow();
    await quiescence;
    expect(nativeFactory.create).not.toHaveBeenCalled();

    probe.endEnvironmentTransition();
    await probe.dispose();
  });

  it('quiesces an in-flight configured-CLI probe before resolving the next CLI', async () => {
    let configuredCli = '/configured/grok-a';
    const first = new FakeMetadataNative('from-a', true);
    const second = new FakeMetadataNative('from-b', false);
    const createOptions: GrokExecutionNativeCreateOptions[] = [];
    const nativeFactory: GrokExecutionNativeFactory = {
      create: jest.fn((options) => {
        createOptions.push(options);
        return options.command === '/configured/grok-a' ? first : second;
      }),
    };
    const plugin = {
      app: { vault: { adapter: { basePath: '/tmp/grok-vault' } } },
      getResolvedProviderCliPath: jest.fn(async () => configuredCli),
      manifest: { version: 'test' },
      settings: {},
    } as unknown as ProviderHost;
    const probe = new GrokCommandMetadataProbe(plugin, nativeFactory);

    const firstLoad = probe.load();
    await first.listStarted.promise;
    const quiescing = probe.quiesceForEnvironmentChange();
    configuredCli = '/configured/grok-b';

    await expect(firstLoad).rejects.toThrow('aborted');
    await quiescing;
    await expect(probe.load()).resolves.toEqual([
      expect.objectContaining({ name: 'from-b' }),
    ]);

    expect(createOptions.map(options => options.command)).toEqual([
      '/configured/grok-a',
      '/configured/grok-b',
    ]);
    expect(first.shutdownCalls).toBe(1);
    expect(second.shutdownCalls).toBe(1);
    await probe.dispose();
  });

  it('releases aborted and disposed callers waiting behind a transition fence', async () => {
    const nativeFactory: GrokExecutionNativeFactory = {
      create: jest.fn(() => new FakeMetadataNative('unused', false)),
    };
    const plugin = {
      app: { vault: { adapter: { basePath: '/tmp/grok-vault' } } },
      getResolvedProviderCliPath: jest.fn(async () => '/configured/grok'),
      manifest: { version: 'test' },
      settings: {},
    } as unknown as ProviderHost;
    const probe = new GrokCommandMetadataProbe(plugin, nativeFactory);
    probe.beginEnvironmentTransition();

    const controller = new AbortController();
    const aborted = probe.load(controller.signal);
    const disposed = probe.load();
    controller.abort();

    await expect(aborted).rejects.toThrow();
    await probe.dispose();
    await expect(disposed).rejects.toThrow('disposed');
    expect(nativeFactory.create).not.toHaveBeenCalled();
  });

  it('normalizes a non-Error abort reason while waiting behind a transition fence', async () => {
    const nativeFactory: GrokExecutionNativeFactory = {
      create: jest.fn(() => new FakeMetadataNative('unused', false)),
    };
    const plugin = {
      app: { vault: { adapter: { basePath: '/tmp/grok-vault' } } },
      getResolvedProviderCliPath: jest.fn(async () => '/configured/grok'),
      manifest: { version: 'test' },
      settings: {},
    } as unknown as ProviderHost;
    const probe = new GrokCommandMetadataProbe(plugin, nativeFactory);
    const controller = new AbortController();
    probe.beginEnvironmentTransition();

    const load = probe.load(controller.signal);
    controller.abort('caller cancelled');

    await expect(load).rejects.toMatchObject({
      cause: 'caller cancelled',
      message: 'Grok command metadata probe aborted',
    });
    await probe.dispose();
  });
});
