import { RoutedTitleGenerationService } from '@/core/auxiliary/RoutedTitleGenerationService';

function setup(initializeProvider = jest.fn().mockResolvedValue(undefined)) {
  const native = {
    cancel: jest.fn(),
    generateTitle: jest.fn(async (id, _message, callback) => callback(id, { success: true, title: 'Generated title' })),
  };
  const service = new RoutedTitleGenerationService({
    resolveProviderId: () => 'claude',
    initializeProvider,
    createService: () => native,
  });
  return { service, native };
}

describe('RoutedTitleGenerationService failures', () => {
  it('reports initialization failure through the result callback', async () => {
    const { service, native } = setup(jest.fn().mockRejectedValue(new Error('Initialization failed')));
    const callback = jest.fn();
    await expect(service.generateTitle('conversation', 'Request', callback)).resolves.toBeUndefined();
    expect(callback).toHaveBeenCalledWith('conversation', { success: false, error: 'Initialization failed' });
    expect(native.generateTitle).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'replace'])('suppresses stale initialization failures after %s', async action => {
    let rejectInitialization!: (error: Error) => void;
    const initialize = jest.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectInitialization = reject; }))
      .mockResolvedValue(undefined);
    const { service } = setup(initialize);
    const callback = jest.fn();
    const previous = service.generateTitle('conversation', 'Old request', callback);
    if (action === 'cancel') service.cancel();
    else await service.generateTitle('conversation', 'New request', callback);
    rejectInitialization(new Error('Obsolete failure'));
    await expect(previous).resolves.toBeUndefined();
    expect(callback.mock.calls).toEqual(action === 'cancel' ? [] : [
      ['conversation', { success: true, title: 'Generated title' }],
    ]);
  });

  it('does not publish a second result when the callback rejects', async () => {
    const { service } = setup();
    const callback = jest.fn().mockRejectedValue(new Error('Failed to save title'));
    await service.generateTitle('conversation', 'Request', callback).catch(() => {});
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
