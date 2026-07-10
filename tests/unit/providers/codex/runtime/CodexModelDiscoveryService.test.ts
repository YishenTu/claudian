import { CodexModelDiscoveryService } from '@/providers/codex/runtime/CodexModelDiscoveryService';

const mockTransportRequest = jest.fn();
const mockTransportDispose = jest.fn();
const mockTransportStart = jest.fn();
const mockProcessStart = jest.fn();
const mockProcessShutdown = jest.fn().mockResolvedValue(undefined);
const mockProcessStderr = jest.fn().mockReturnValue('');
const mockResolveLaunchSpec = jest.fn();

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
  initializeCodexAppServerTransport: jest.fn().mockResolvedValue({
    userAgent: 'test/0.1',
    codexHome: '/home/user/.codex',
    platformFamily: 'unix',
    platformOs: 'linux',
  }),
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

describe('CodexModelDiscoveryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveLaunchSpec.mockReturnValue({
      targetCwd: '/workspace',
      command: 'codex',
      args: ['app-server', '--listen', 'stdio://'],
      spawnCwd: '/workspace',
      env: {},
    });
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

    const result = await new CodexModelDiscoveryService({} as any).discoverModels();

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

    const result = await new CodexModelDiscoveryService({} as any).discoverModels();

    expect(result).toEqual({
      diagnostics: 'Method not found\n\ncodex app-server stderr',
      models: [],
    });
    expect(mockTransportDispose).toHaveBeenCalledTimes(1);
    expect(mockProcessShutdown).toHaveBeenCalledTimes(1);
  });
});
