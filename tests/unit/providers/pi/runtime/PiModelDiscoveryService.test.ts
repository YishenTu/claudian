import '@/providers';

const mockTransportRequest = jest.fn();
const mockTransportSend = jest.fn();
const mockTransportStart = jest.fn();
const mockTransportDispose = jest.fn();
const mockTransportOnEvent = jest.fn();
const mockRemoveEventListener = jest.fn();
const mockProcessStart = jest.fn();
const mockProcessShutdown = jest.fn().mockResolvedValue(undefined);
const mockProcessOnClose = jest.fn();
const mockGetStderrSnapshot = jest.fn(() => '');
let mockEventHandler: ((event: Record<string, unknown>) => void) | null = null;

jest.mock('@/providers/pi/runtime/PiRpcTransport', () => ({
  PiRpcTransport: jest.fn().mockImplementation(() => ({
    dispose: mockTransportDispose,
    onEvent: mockTransportOnEvent,
    request: mockTransportRequest,
    send: mockTransportSend,
    start: mockTransportStart,
  })),
}));

jest.mock('@/providers/pi/runtime/PiSubprocess', () => ({
  PiSubprocess: jest.fn().mockImplementation(() => ({
    getStderrSnapshot: mockGetStderrSnapshot,
    onClose: mockProcessOnClose,
    shutdown: mockProcessShutdown,
    start: mockProcessStart,
    stdin: {},
    stdout: {},
  })),
}));

import { PiModelDiscoveryService } from '@/providers/pi/runtime/PiModelDiscoveryService';

function createPlugin() {
  return {
    app: {
      vault: {
        adapter: {
          basePath: '/tmp/vault',
        },
      },
    },
    getResolvedProviderCliPath: jest.fn(() => '/usr/local/bin/pi'),
    settings: {
      providerConfigs: {
        pi: {
          enabled: true,
        },
      },
    },
  } as any;
}

describe('PiModelDiscoveryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEventHandler = null;
    mockGetStderrSnapshot.mockReturnValue('');
    mockTransportOnEvent.mockImplementation((handler: (event: Record<string, unknown>) => void) => {
      mockEventHandler = handler;
      return mockRemoveEventListener;
    });
  });

  it('does not launch Pi when the provider is disabled', async () => {
    const plugin = createPlugin();
    plugin.settings.providerConfigs.pi.enabled = false;

    const result = await new PiModelDiscoveryService(plugin).discoverModels();

    expect(result).toEqual({ kind: 'skipped', reason: 'provider-disabled' });
    expect(plugin.getResolvedProviderCliPath).not.toHaveBeenCalled();
    expect(mockProcessStart).not.toHaveBeenCalled();
    expect(mockTransportStart).not.toHaveBeenCalled();
    expect(mockTransportRequest).not.toHaveBeenCalled();
  });

  it('discovers and normalizes Pi models through a short-lived no-session runtime', async () => {
    mockTransportRequest.mockResolvedValue({
      models: [{
        contextWindow: 200000,
        id: 'gpt-5',
        input: ['text', 'image'],
        maxTokens: 8192,
        name: 'GPT-5',
        provider: 'openai',
        reasoning: true,
      }],
    });

    const result = await new PiModelDiscoveryService(createPlugin()).discoverModels();

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') {
      throw new Error('Expected completed Pi model discovery');
    }
    expect(result.diagnostics).toBeUndefined();
    expect(result.models).toEqual([{
      contextWindow: 200000,
      encodedId: 'pi:openai/gpt-5',
      id: 'gpt-5',
      input: ['text', 'image'],
      label: 'GPT-5',
      maxTokens: 8192,
      provider: 'openai',
      reasoning: true,
      thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high'],
    }]);
    expect(mockProcessStart).toHaveBeenCalled();
    expect(mockTransportStart).toHaveBeenCalled();
    expect(mockTransportRequest).toHaveBeenCalledWith('get_available_models', {}, 20_000);
    expect(mockRemoveEventListener).toHaveBeenCalled();
    expect(mockTransportDispose).toHaveBeenCalled();
    expect(mockProcessShutdown).toHaveBeenCalled();
  });

  it('cancels extension UI requests during discovery', async () => {
    mockTransportRequest.mockImplementation(async () => {
      mockEventHandler?.({
        id: 'ui-1',
        type: 'extension_ui_request',
      });
      return { models: [] };
    });

    await new PiModelDiscoveryService(createPlugin()).discoverModels();

    expect(mockTransportSend).toHaveBeenCalledWith({
      cancelled: true,
      id: 'ui-1',
      type: 'extension_ui_response',
    });
  });

  it('returns diagnostics and still shuts down when discovery fails', async () => {
    mockTransportRequest.mockRejectedValue(new Error('not logged in'));
    mockGetStderrSnapshot.mockReturnValue('Pi stderr');

    const result = await new PiModelDiscoveryService(createPlugin()).discoverModels();

    expect(result).toEqual({
      diagnostics: 'not logged in\n\nPi stderr',
      kind: 'completed',
      models: [],
    });
    expect(mockTransportDispose).toHaveBeenCalled();
    expect(mockProcessShutdown).toHaveBeenCalled();
  });
});
