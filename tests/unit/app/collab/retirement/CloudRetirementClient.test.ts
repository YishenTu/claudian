import {
  CloudRetirementClient,
} from '@/app/collab/retirement/CloudRetirementClient';

const PROJECT_ID = 'project-cloud-retire';

describe('CloudRetirementClient', () => {
  it('acknowledges from the minimal durable Cloud target', async () => {
    const retirement = jest.fn().mockResolvedValue({
      acknowledgedAt: '2026-08-27T00:00:11.000Z',
      idempotencyKey: 'retire-ack-cloud',
      projectId: PROJECT_ID,
      retirementId: 'retirement-cloud',
    });
    const dispose = jest.fn();
    const connect = jest.fn(async () => ({
      dispose,
      lifecycle: { retirement },
      supports: () => true,
    } as never));
    const client = new CloudRetirementClient({
      activity: {
        complete: async () => undefined,
        resume: async () => undefined,
        suspend: async () => undefined,
      },
      connect,
      connectRetirement: async () => { throw new Error('not expected'); },
      intents: {
        listProjectIds: async () => [],
        load: async () => null,
        loadRetirementRecord: async () => null,
        remove: async () => false,
        save: async () => undefined,
      },
      terminal: { handle: async () => undefined, resume: async () => undefined },
    });

    await client.acknowledge({
      projectId: PROJECT_ID,
      retirementId: 'retirement-cloud',
      serverUrl: 'https://cloud.example.test/',
    });

    expect(connect).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      retirementId: 'retirement-cloud',
      serverUrl: 'https://cloud.example.test/',
    });
    expect(retirement).toHaveBeenCalledWith(
      'acknowledgeProjectRetirement',
      {
        idempotencyKey: expect.stringMatching(/^retire-ack-[0-9a-f]{32}$/),
        projectId: PROJECT_ID,
        retirementId: 'retirement-cloud',
      },
      {},
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
