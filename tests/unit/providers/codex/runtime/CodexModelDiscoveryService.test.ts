import type { CodexAppServerRuntime } from '@/providers/codex/runtime/CodexAppServerRuntime';
import { CodexModelDiscoveryService } from '@/providers/codex/runtime/CodexModelDiscoveryService';

const mockTransportRequest = jest.fn();
const mockAcquire = jest.fn();
const mockRelease = jest.fn().mockResolvedValue(undefined);
const mockProcessStderr = jest.fn().mockReturnValue('');
const runtime = { acquire: mockAcquire } as unknown as CodexAppServerRuntime;

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
    jest.resetAllMocks();
    mockAcquire.mockResolvedValue({
      connection: { transport: { request: mockTransportRequest }, process: { getStderrSnapshot: mockProcessStderr } },
      release: mockRelease,
    });
  });

  it('does not launch Codex when the provider is disabled', async () => {
    const result = await new CodexModelDiscoveryService(createPlugin(false), runtime).discoverModels();

    expect(result).toEqual({ kind: 'skipped', reason: 'provider-disabled' });
    expect(mockAcquire).not.toHaveBeenCalled();
    expect(mockTransportRequest).not.toHaveBeenCalled();
  });

  it('loads and normalizes every model page from a shared connection', async () => {
    mockTransportRequest
      .mockResolvedValueOnce({
        data: [makeWireModel('gpt-5.6-sol', true)],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        data: [makeWireModel('gpt-5.6-luna')],
        nextCursor: null,
      });

    const result = await new CodexModelDiscoveryService(createPlugin(), runtime).discoverModels();

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
    }, undefined, undefined);
    expect(mockTransportRequest).toHaveBeenNthCalledWith(2, 'model/list', {
      cursor: 'page-2',
      includeHidden: false,
      limit: 100,
    }, undefined, undefined);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('returns diagnostics and releases its lease when discovery fails', async () => {
    mockTransportRequest.mockRejectedValueOnce(new Error('Method not found'));
    mockProcessStderr.mockReturnValueOnce('codex app-server stderr');

    const result = await new CodexModelDiscoveryService(createPlugin(), runtime).discoverModels();

    expect(result).toEqual({
      diagnostics: 'Method not found\n\ncodex app-server stderr',
      kind: 'completed',
      models: [],
    });
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('returns diagnostics when launch-spec resolution fails before process startup', async () => {
    mockAcquire.mockImplementationOnce(() => {
      throw new Error('Unable to determine the WSL distro');
    });

    await expect(
      new CodexModelDiscoveryService(createPlugin(), runtime).discoverModels(),
    ).resolves.toEqual({
      diagnostics: 'Unable to determine the WSL distro',
      kind: 'completed',
      models: [],
    });
    expect(mockTransportRequest).not.toHaveBeenCalled();
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('reports request cancellation and releases only its lease', async () => {
    const controller = new AbortController();
    mockTransportRequest.mockImplementation(async () => {
      controller.abort();
      throw new Error('Request aborted');
    });
    await expect(new CodexModelDiscoveryService(createPlugin(), runtime).discoverModels(controller.signal))
      .resolves.toEqual({ kind: 'completed', diagnostics: 'Codex CLI model discovery was cancelled', models: [] });
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('returns cancellation diagnostics when already aborted before start', async () => {
    const service = new CodexModelDiscoveryService(createPlugin(), runtime);
    const controller = new AbortController();
    controller.abort();

    const result = await service.discoverModels(controller.signal);
    if (result.kind !== 'completed') {
      throw new Error('Expected completed Codex model discovery');
    }

    expect(result.diagnostics).toMatch(/cancelled/i);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it('rejects repeated pagination cursors without publishing a partial catalog', async () => {
    mockTransportRequest.mockResolvedValue({ data: [makeWireModel('model')], nextCursor: 'same' });
    await expect(new CodexModelDiscoveryService(createPlugin(), runtime).discoverModels())
      .resolves.toEqual({ kind: 'completed', diagnostics: 'Codex CLI model/list returned a repeated cursor', models: [] });
    expect(mockTransportRequest).toHaveBeenCalledTimes(2);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
