import {
  type RetirementAcknowledgementClientPort,
  RetirementAcknowledgementWorker,
  type RetirementClientStore,
} from '@/app/collab/retirement/RetirementAcknowledgementWorker';
import type { RetirementRecord } from '@/app/collab/retirement/RetirementRecord';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const RETIRED_AT = '2026-08-13T00:00:00.000Z';
const ACKNOWLEDGED_AT = '2026-08-13T00:01:00.000Z';

async function admitProjectRecovery(
  _projectId: string,
  operation: () => Promise<void>,
): Promise<void> {
  await operation();
}

describe('RetirementAcknowledgementWorker', () => {
  it('uses one durable acknowledgement identity and scrubs network credentials', async () => {
    const store = new MemoryRetirementStore(record());
    const projectRecoveryAdmission = jest.fn(async (
      _projectId: string,
      operation: () => Promise<void>,
    ) => operation());
    const client: jest.Mocked<RetirementAcknowledgementClientPort> = {
      acknowledge: jest.fn().mockResolvedValue({
        acknowledgedAt: ACKNOWLEDGED_AT,
        projectId: 'project-a',
        retiredAt: RETIRED_AT,
      }),
      acknowledgeCloud: jest.fn(),
    };
    const worker = new RetirementAcknowledgementWorker(store, client, {
      projectRecoveryAdmission,
    });

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
    expect(projectRecoveryAdmission).toHaveBeenCalledWith(
      'project-a',
      expect.any(Function),
    );
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
      acknowledgeCloud: jest.fn(),
    };
    const worker = new RetirementAcknowledgementWorker(store, client, {
      projectRecoveryAdmission: admitProjectRecovery,
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
      acknowledgeCloud: jest.fn(),
    };
    const worker = new RetirementAcknowledgementWorker(store, client, {
      projectRecoveryAdmission: admitProjectRecovery,
      scheduleRetry,
    });

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
      acknowledgeCloud: jest.fn(),
    };
    const worker = new RetirementAcknowledgementWorker(store, client, {
      now: () => new Date('2026-09-12T00:00:00.000Z'),
      projectRecoveryAdmission: admitProjectRecovery,
    });

    await expect(worker.run('project-a')).resolves.toBe('expired');

    expect(client.acknowledge).not.toHaveBeenCalled();
    expect(store.removed).toBe(true);
  });

  it('recovers a durable Cloud acknowledgement after a transient failure and restart', async () => {
    const store = new MemoryRetirementStore(cloudRecord());
    const firstClient: jest.Mocked<RetirementAcknowledgementClientPort> = {
      acknowledge: jest.fn(),
      acknowledgeCloud: jest.fn().mockRejectedValue(
        new CollabError({ code: 'endpoint-unreachable' }),
      ),
    };
    const first = new RetirementAcknowledgementWorker(store, firstClient, {
      projectRecoveryAdmission: admitProjectRecovery,
      scheduleRetry: jest.fn(),
    });

    await expect(first.run('project-a')).resolves.toBe('retry-pending');
    expect(store.value).toMatchObject({
      acknowledgementStatus: 'pending',
      cloudRetirementId: 'retirement-cloud-one',
      cloudServerUrl: 'https://cloud.example.test/',
    });
    await first.close();

    const secondClient: jest.Mocked<RetirementAcknowledgementClientPort> = {
      acknowledge: jest.fn(),
      acknowledgeCloud: jest.fn().mockResolvedValue({
        acknowledgedAt: ACKNOWLEDGED_AT,
        idempotencyKey: 'retire-ack-cloud',
        projectId: 'project-a',
        retirementId: 'retirement-cloud-one',
      }),
    };
    const resumed = new RetirementAcknowledgementWorker(store, secondClient, {
      projectRecoveryAdmission: admitProjectRecovery,
    });

    await expect(resumed.run('project-a')).resolves.toBe('acknowledged');
    expect(secondClient.acknowledgeCloud).toHaveBeenCalledWith({
      developmentActorId: 'principal-manager-device',
      projectId: 'project-a',
      retirementId: 'retirement-cloud-one',
      serverUrl: 'https://cloud.example.test/',
      signal: expect.any(AbortSignal),
    });
    expect(store.value).toMatchObject({
      acknowledgedAt: ACKNOWLEDGED_AT,
      acknowledgementStatus: 'acknowledged',
      cloudRetirementId: null,
      cloudServerUrl: null,
    });
  });
});

function record(): RetirementRecord {
  return {
    acknowledgedAt: null,
    acknowledgementStatus: 'pending',
    cleanupOperationId: 'retire-local-one',
    cleanupStatus: 'pending',
    cloudDevelopmentActorId: null,
    cloudRetirementId: null,
    cloudServerUrl: null,
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

function cloudRecord(): RetirementRecord {
  return {
    ...record(),
    cloudDevelopmentActorId: 'principal-manager-device',
    cloudRetirementId: 'retirement-cloud-one',
    cloudServerUrl: 'https://cloud.example.test/',
    hostCaCertificatePem: null,
    hostCaFingerprint: null,
    hostEndpoint: null,
    memberCredential: null,
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
