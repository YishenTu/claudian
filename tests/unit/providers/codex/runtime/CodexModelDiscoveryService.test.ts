import { CodexModelDiscoveryService } from '@/providers/codex/runtime/CodexModelDiscoveryService';

const mockTransportRequest = jest.fn();
const mockTransportDispose = jest.fn();
const mockTransportStart = jest.fn();
const mockProcessStart = jest.fn();
const mockProcessShutdown = jest.fn().mockResolvedValue(undefined);
const mockProcessStderr = jest.fn().mockReturnValue('');
const mockResolveLaunchSpec = jest.fn();
const mockInitializeTransport = jest.fn();

jest.mock('@/providers/codex/runtime/CodexRpcTransport', () => ({
  CodexRpcTransport: jest.fn().mockImplementation(() => ({
    request: mockTransportRequest,
    dispose: mockTransportDispose,
    start: mockTransportStart,
    notify: jest.fn(),
  })),
}));

jest.mock('@/providers/codex/runtime/CodexAppServerProcess', () => ({
  CodexAppServerProcess: jest.fn().mockImplementation(() => ({
    start: mockProcessStart,
    shutdown: mockProcessShutdown,
    getStderrSnapshot: mockProcessStderr,
  })),
}));

jest.mock('@/providers/codex/runtime/codexAppServerSupport', () => ({
  initializeCodexAppServerTransport: (...args: unknown[]) => mockInitializeTransport(...args),
  resolveCodexAppServerLaunchSpec: (...args: unknown[]) => mockResolveLaunchSpec(...args),
}));

function makeWireModel(model: string, isDefault = false) {
  return {
    id: model,
    model,
    displayName: model,
    description: `${model} description`,
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium', description: 'Balanced' },
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault,
  };
}

function createPlugin(enabled = true) {
  return {
    settings: {
      providerConfigs: {
        codex: { enabled },
      },
    },
  } as any;
}

describe('CodexModelDiscoveryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInitializeTransport.mockResolvedValue({
      userAgent: 'test/0.1',
      codexHome: '/home/user/.codex',
      platformFamily: 'unix',
      platformOs: 'linux',
    });
    mockResolveLaunchSpec.mockReturnValue({
      targetCwd: '/workspace',
      command: 'codex',
      args: ['app-server', '--listen', 'stdio://'],
      spawnCwd: '/workspace',
      env: {},
    });
  });

  it('does not launch Codex when the provider is disabled', async () => {
    const result = await new CodexModelDiscoveryService(createPlugin(false)).discoverModels();

    expect(result).toEqual({ kind: 'skipped', reason: 'provider-disabled' });
    expect(mockResolveLaunchSpec).not.toHaveBeenCalled();
    expect(mockProcessStart).not.toHaveBeenCalled();
    expect(mockTransportStart).not.toHaveBeenCalled();
    expect(mockTransportRequest).not.toHaveBeenCalled();
  });

  it('loads all visible model/list pages through a short-lived app-server', async () => {
    mockTransportRequest
      .mockResolvedValueOnce({
        data: [makeWireModel('gpt-5.6-sol', true)],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        data: [makeWireModel('gpt-5.6-luna')],
        nextCursor: null,
      });

    const result = await new CodexModelDiscoveryService(createPlugin()).discoverModels();

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') {
      throw new Error('Expected completed Codex model discovery');
    }
    expect(result.diagnostics).toBeUndefined();
    expect(result.models.map(model => model.model)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-luna',
    ]);
    expect(mockTransportRequest).toHaveBeenNthCalledWith(1, 'model/list', {
      includeHidden: false,
      limit: 100,
    });
    expect(mockTransportRequest).toHaveBeenNthCalledWith(2, 'model/list', {
      cursor: 'page-2',
      includeHidden: false,
      limit: 100,
    });
    expect(mockTransportDispose).toHaveBeenCalledTimes(1);
    expect(mockProcessShutdown).toHaveBeenCalledTimes(1);
  });

  it('returns diagnostics and always shuts down when discovery fails', async () => {
    mockTransportRequest.mockRejectedValueOnce(new Error('Method not found'));
    mockProcessStderr.mockReturnValueOnce('codex app-server stderr');

    const result = await new CodexModelDiscoveryService(createPlugin()).discoverModels();

    expect(result).toEqual({
      diagnostics: 'Method not found\n\ncodex app-server stderr',
      kind: 'completed',
      models: [],
    });
    expect(mockTransportDispose).toHaveBeenCalledTimes(1);
    expect(mockProcessShutdown).toHaveBeenCalledTimes(1);
  });

  it('returns diagnostics when launch-spec resolution fails before process startup', async () => {
    mockResolveLaunchSpec.mockImplementationOnce(() => {
      throw new Error('Unable to determine the WSL distro');
    });

    await expect(
      new CodexModelDiscoveryService(createPlugin()).discoverModels(),
    ).resolves.toEqual({
      diagnostics: 'Unable to determine the WSL distro',
      kind: 'completed',
      models: [],
    });
    expect(mockProcessStart).not.toHaveBeenCalled();
    expect(mockProcessShutdown).not.toHaveBeenCalled();
  });

  it('disposes transport and shuts down process when aborted', async () => {
    let finishInitialization!: (value: {
      codexHome: string;
      platformFamily: string;
      platformOs: string;
      userAgent: string;
    }) => void;
    mockInitializeTransport.mockReturnValueOnce(new Promise((resolve) => {
      finishInitialization = resolve;
    }));

    const service = new CodexModelDiscoveryService(createPlugin());
    const controller = new AbortController();

    const discoveryPromise = service.discoverModels(controller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    finishInitialization({
      userAgent: 'test/0.1',
      codexHome: '/home/user/.codex',
      platformFamily: 'unix',
      platformOs: 'linux',
    });

    const result = await discoveryPromise;
    if (result.kind !== 'completed') {
      throw new Error('Expected completed Codex model discovery');
    }
    expect(result.diagnostics).toMatch(/cancelled/i);
    expect(mockTransportDispose).toHaveBeenCalled();
    expect(mockProcessShutdown).toHaveBeenCalled();
  });

  it('returns cancellation diagnostics when already aborted before start', async () => {
    const service = new CodexModelDiscoveryService(createPlugin());
    const controller = new AbortController();
    controller.abort();

    const result = await service.discoverModels(controller.signal);
    if (result.kind !== 'completed') {
      throw new Error('Expected completed Codex model discovery');
    }

    expect(result.diagnostics).toMatch(/cancelled/i);
    expect(mockResolveLaunchSpec).not.toHaveBeenCalled();
    expect(mockProcessStart).not.toHaveBeenCalled();
  });

  it('does not start Codex when aborted during launch-spec resolution', async () => {
    let resolveLaunchSpec!: (value: {
      args: string[];
      command: string;
      env: Record<string, string>;
      spawnCwd: string;
      targetCwd: string;
    }) => void;
    mockResolveLaunchSpec.mockReturnValueOnce(new Promise((resolve) => {
      resolveLaunchSpec = resolve;
    }));

    const service = new CodexModelDiscoveryService(createPlugin());
    const controller = new AbortController();
    const discoveryPromise = service.discoverModels(controller.signal);

    controller.abort();
    resolveLaunchSpec({
      targetCwd: '/workspace',
      command: 'codex',
      args: ['app-server', '--listen', 'stdio://'],
      spawnCwd: '/workspace',
      env: {},
    });

    await expect(discoveryPromise).resolves.toEqual({
      kind: 'completed',
      diagnostics: 'Codex model discovery was cancelled',
      models: [],
    });
    expect(mockProcessStart).not.toHaveBeenCalled();
    expect(mockTransportStart).not.toHaveBeenCalled();
  });
});
