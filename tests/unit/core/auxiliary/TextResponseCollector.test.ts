import { FakeAuxiliarySession } from '@test/helpers/core/auxiliary/AuxiliaryExecutionTestHarness';

import { TextResponseCollector } from '@/core/auxiliary/TextResponseCollector';

describe('TextResponseCollector', () => {
  it('collects deltas and requires completion', async () => {
    const session = new FakeAuxiliarySession();
    const run = session.execute({} as any);
    const result = new TextResponseCollector().collect(run);

    session.emitText('Hello');
    session.emitText(' world');
    session.complete();

    await expect(result).resolves.toBe('Hello world');
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
