import {
  type RetirementAcknowledgementClientPort,
  RetirementAcknowledgementWorker,
  type RetirementClientStore,
} from '@/app/collab/retirement/RetirementAcknowledgementWorker';
import type { RetirementRecord } from '@/app/collab/retirement/RetirementRecord';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const RETIRED_AT = '2026-08-13T00:00:00.000Z';
const ACKNOWLEDGED_AT = '2026-08-13T00:01:00.000Z';

describe('RetirementAcknowledgementWorker', () => {
  it('uses one durable acknowledgement identity and scrubs network credentials', async () => {
    const store = new MemoryRetirementStore(record());
    const client: jest.Mocked<RetirementAcknowledgementClientPort> = {
      acknowledge: jest.fn().mockResolvedValue({
        acknowledgedAt: ACKNOWLEDGED_AT,
        projectId: 'project-a',
        retiredAt: RETIRED_AT,
      }),
    };
    const worker = new RetirementAcknowledgementWorker(store, client);

    await expect(worker.run('project-a')).resolves.toBe('acknowledged');
    await expect(worker.run('project-a')).resolves.toBe('acknowledged');

    expect(client.acknowledge).toHaveBeenCalledTimes(1);
    expect(client.acknowledge).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'retire-local-one',
      memberCredential: 'A'.repeat(43),
      projectId: 'project-a',
      retiredAt: RETIRED_AT,
    }));
    expect(store.value).toMatchObject({
      acknowledgedAt: ACKNOWLEDGED_AT,
      acknowledgementStatus: 'acknowledged',
      hostCaCertificatePem: null,
      hostCaFingerprint: null,
      hostEndpoint: null,
      memberCredential: null,
    });
    expect(store.removed).toBe(true);
  });

  it.each(['endpoint-unreachable', 'tls-untrusted'] as const)(
    'keeps durable pending state and schedules a retry for transient %s failure',
    async code => {
    const store = new MemoryRetirementStore(record());
    const retry = jest.fn();
    const client: jest.Mocked<RetirementAcknowledgementClientPort> = {
      acknowledge: jest.fn()
        .mockRejectedValueOnce(new CollabError({ code }))
        .mockResolvedValueOnce({
          acknowledgedAt: ACKNOWLEDGED_AT,
          projectId: 'project-a',
          retiredAt: RETIRED_AT,
        }),
    };
    const worker = new RetirementAcknowledgementWorker(store, client, {
      scheduleRetry: retry,
    });

    await expect(worker.run('project-a')).resolves.toBe('retry-pending');
    expect(store.value.acknowledgementStatus).toBe('pending');
    expect(retry).toHaveBeenCalledWith('project-a', expect.any(Function), 1_000);
    await retry.mock.calls[0][1]();
    expect(store.value.acknowledgementStatus).toBe('acknowledged');
    },
  );

  it('cancels scheduled retries and aborts active acknowledgement work on close', async () => {
    const store = new MemoryRetirementStore(record());
    const cancelRetry = jest.fn();
    const scheduleRetry = jest.fn(() => cancelRetry);
    let observedSignal: AbortSignal | undefined;
    const client: jest.Mocked<RetirementAcknowledgementClientPort> = {
      acknowledge: jest.fn(async input => {
        observedSignal = input.signal;
        throw new CollabError({ code: 'endpoint-unreachable' });
      }),
    };
    const worker = new RetirementAcknowledgementWorker(store, client, { scheduleRetry });

    await expect(worker.run('project-a')).resolves.toBe('retry-pending');
    expect(observedSignal?.aborted).toBe(false);
    await worker.close();

    expect(observedSignal?.aborted).toBe(true);
    expect(cancelRetry).toHaveBeenCalledTimes(1);
    await expect(worker.run('project-a')).resolves.toBe('cancelled');
  });

  it('removes an independently queued acknowledgement after its 30-day window', async () => {
    const store = new MemoryRetirementStore(record());
    const client: jest.Mocked<RetirementAcknowledgementClientPort> = {
      acknowledge: jest.fn(),
    };
    const worker = new RetirementAcknowledgementWorker(store, client, {
      now: () => new Date('2026-09-12T00:00:00.000Z'),
    });

    await expect(worker.run('project-a')).resolves.toBe('expired');

    expect(client.acknowledge).not.toHaveBeenCalled();
    expect(store.removed).toBe(true);
  });
});

function record(): RetirementRecord {
  return {
    acknowledgedAt: null,
    acknowledgementStatus: 'pending',
    cleanupOperationId: 'retire-local-one',
    cleanupStatus: 'pending',
    createdAt: RETIRED_AT,
    hostCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
    hostCaFingerprint: 'a'.repeat(64),
    hostEndpoint: 'https://192.168.1.20:54545',
    kind: 'retirement',
    memberCredential: 'A'.repeat(43),
    memberId: 'member-a',
    projectId: 'project-a',
    retiredAt: RETIRED_AT,
    schemaVersion: 1,
    updatedAt: RETIRED_AT,
  };
}

class MemoryRetirementStore implements RetirementClientStore {
  removed = false;

  constructor(public value: RetirementRecord) {}

  async loadRetirementRecord(): Promise<RetirementRecord | null> {
    return this.value;
  }

  async updateRetirementRecord(
    _projectId: string,
    update: (record: RetirementRecord) => RetirementRecord,
  ): Promise<RetirementRecord> {
    this.value = update(this.value);
    return this.value;
  }

  async removeRetirementAcknowledgement(): Promise<boolean> {
    this.removed = true;
    return true;
  }
}
