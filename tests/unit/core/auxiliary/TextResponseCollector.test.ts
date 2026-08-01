import { TextResponseCollector } from '@/core/auxiliary/TextResponseCollector';

import { FakeAuxiliarySession } from './AuxiliaryExecutionTestHarness';

describe('TextResponseCollector', () => {
  it('collects deltas, reports accumulated progress, and requires completion', async () => {
    const session = new FakeAuxiliarySession();
    const run = session.execute({} as any);
    const progress = jest.fn();
    const result = new TextResponseCollector().collect(run, progress);

    session.emitText('Hello');
    session.emitText(' world');
    session.complete();

    await expect(result).resolves.toBe('Hello world');
    expect(progress).toHaveBeenNthCalledWith(1, 'Hello');
    expect(progress).toHaveBeenNthCalledWith(2, 'Hello world');
  });

  it('turns normalized terminal failures into typed collector errors', async () => {
    const session = new FakeAuxiliarySession();
    const run = session.execute({} as any);
    const result = new TextResponseCollector().collect(run);
    session.fail('provider failed');

    await expect(result).rejects.toMatchObject({
      category: 'provider',
      message: 'provider failed',
      name: 'AuxiliaryExecutionError',
    });
  });
});
