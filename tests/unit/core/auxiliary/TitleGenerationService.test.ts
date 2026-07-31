import { TitleGenerationService } from '@/core/auxiliary/TitleGenerationService';
import type {
  TitleGenerationBackend,
  TitleGenerationBackendRequest,
} from '@/core/providers/types';

function createBackend(response = 'Generated title'): jest.Mocked<TitleGenerationBackend> {
  return {
    dispose: jest.fn(),
    query: jest.fn().mockResolvedValue(response),
  };
}

describe('TitleGenerationService', () => {
  it('resolves the title language for each generation', async () => {
    let locale = 'ja';
    const backends = [createBackend(), createBackend()];
    const service = new TitleGenerationService({
      createBackend: jest.fn()
        .mockReturnValueOnce(backends[0])
        .mockReturnValueOnce(backends[1]),
      resolveLocale: () => locale,
    });

    await service.generateTitle('conversation-1', 'First request', jest.fn());
    locale = 'fr';
    await service.generateTitle('conversation-2', 'Second request', jest.fn());

    expect(backends[0].query).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining('Write the title in Japanese'),
      userPrompt: expect.any(String),
    }));
    expect(backends[1].query).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: expect.stringContaining('Write the title in French'),
      userPrompt: expect.any(String),
    }));
    expect(backends[0].dispose).toHaveBeenCalledTimes(1);
    expect(backends[1].dispose).toHaveBeenCalledTimes(1);
  });

  it('aborts and disposes active backends when cancelled', async () => {
    let request: TitleGenerationBackendRequest | undefined;
    const backend = createBackend();
    backend.query.mockImplementation(async (nextRequest) => {
      request = nextRequest;
      return new Promise<string>((_resolve, reject) => {
        nextRequest.abortController.signal.addEventListener('abort', () => {
          reject(new Error('Cancelled'));
        });
      });
    });
    const service = new TitleGenerationService({
      createBackend: () => backend,
      resolveLocale: () => 'en',
    });
    const callback = jest.fn();
    const generation = service.generateTitle('conversation-1', 'Request', callback);
    await Promise.resolve();

    service.cancel();
    await generation;

    expect(request?.abortController.signal.aborted).toBe(true);
    expect(backend.dispose).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith('conversation-1', {
      error: 'Cancelled',
      success: false,
    });
  });
});
