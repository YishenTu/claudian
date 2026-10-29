import '@/providers';

import { runtimeHostFor } from '@test/helpers/providerRuntimeHost';

const mockTransportRequest = vi.fn();
const mockTransportSend = vi.fn();
const mockTransportStart = vi.fn();
const mockTransportDispose = vi.fn();
const mockTransportOnEvent = vi.fn();
const mockRemoveEventListener = vi.fn();
const mockProcessStart = vi.fn();
const mockProcessShutdown = vi.fn().mockResolvedValue(undefined);
const mockProcessOnClose = vi.fn();
const mockGetStderrSnapshot = vi.fn(() => '');
let mockEventHandler: ((event: Record<string, unknown>) => void) | null = null;

vi.mock('@/providers/pi/runtime/PiRPCTransport', () => ({
  PiRPCTransport: vi.fn().mockImplementation(function () { return ({
    dispose: mockTransportDispose,
    onEvent: mockTransportOnEvent,
    request: mockTransportRequest,
    send: mockTransportSend,
    start: mockTransportStart,
  }); }),
}));

vi.mock('@/providers/pi/runtime/PiSubprocess', () => ({
  PiSubprocess: vi.fn().mockImplementation(function () { return ({
    getStderrSnapshot: mockGetStderrSnapshot,
    onClose: mockProcessOnClose,
    shutdown: mockProcessShutdown,
    start: mockProcessStart,
    stdin: {},
    stdout: {},
  }); }),
}));

import { PiModelDiscoveryService } from '@/providers/pi/runtime/PiModelDiscoveryService';

function createPlugin() {
  return {
    workingDirectory: '/tmp/vault',
    getResolvedProviderCliPath: vi.fn(() => '/usr/local/bin/pi'),
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
    vi.clearAllMocks();
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

    const result = await new PiModelDiscoveryService(runtimeHostFor(plugin, 'pi')).discoverModels();

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
        thinkingLevelMap: {
          max: 'max',
        },
      }],
    });

    const result = await new PiModelDiscoveryService(runtimeHostFor(createPlugin(), 'pi')).discoverModels();

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
      thinkingLevels: ['off', 'minimal', 'low', 'medium', 'high', 'max'],
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

    await new PiModelDiscoveryService(runtimeHostFor(createPlugin(), 'pi')).discoverModels();

    expect(mockTransportSend).toHaveBeenCalledWith({
      cancelled: true,
      id: 'ui-1',
      type: 'extension_ui_response',
    });
  });

  it('returns diagnostics and still shuts down when discovery fails', async () => {
    mockTransportRequest.mockRejectedValue(new Error('not logged in'));
    mockGetStderrSnapshot.mockReturnValue('Pi stderr');

    const result = await new PiModelDiscoveryService(runtimeHostFor(createPlugin(), 'pi')).discoverModels();

    expect(result).toEqual({
      diagnostics: 'not logged in\n\nPi stderr',
      kind: 'completed',
      models: [],
    });
    expect(mockTransportDispose).toHaveBeenCalled();
    expect(mockProcessShutdown).toHaveBeenCalled();
  });
});
