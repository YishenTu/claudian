import type { HostedLifecycleControlPort } from '@/app/collab/lan/HostedProjectControlService';
import { HostTransferLifecycleOrchestrator } from '@/app/collab/lan/HostTransferLifecycleOrchestrator';

const summary = {
  canAccept: false,
  canCancel: true,
  canDecline: false,
  expiresAt: '2026-08-13T00:10:00.000Z',
  offeredAt: '2026-08-13T00:00:00.000Z',
  phase: 'accepted' as const,
  targetMemberId: 'member-target',
  transferId: 'transfer-a',
};

describe('HostTransferLifecycleOrchestrator', () => {
  function create() {
    const lifecycle = {
      acceptHostTransfer: jest.fn().mockResolvedValue(summary),
      cancelHostTransfer: jest.fn().mockResolvedValue({ ...summary, phase: 'cancelled' }),
    } as unknown as jest.Mocked<HostedLifecycleControlPort>;
    const outgoing = {
      cancelBeforeRelinquishment: jest.fn().mockResolvedValue(undefined),
      prepareAccepted: jest.fn().mockResolvedValue(undefined),
      prepareCancellation: jest.fn().mockResolvedValue(undefined),
      run: jest.fn().mockResolvedValue(undefined),
    };
    const onBackgroundError = jest.fn();
    const projectLifecycleAdmissionState: { error: Error | null } = { error: null };
    const projectLifecycleAdmission = async <T>(
      _projectId: string,
      operation: () => Promise<T>,
    ): Promise<T> => {
      if (projectLifecycleAdmissionState.error) {
        throw projectLifecycleAdmissionState.error;
      }
      return operation();
    };
    return {
      lifecycle,
      onBackgroundError,
      orchestrator: new HostTransferLifecycleOrchestrator(
        lifecycle,
        outgoing,
        { onBackgroundError, projectLifecycleAdmission },
      ),
      outgoing,
      projectLifecycleAdmission,
      projectLifecycleAdmissionState,
    };
  }

  it('acquires source lifecycle ownership before accepting authority transfer', async () => {
    const {
      lifecycle,
      orchestrator,
      outgoing,
      projectLifecycleAdmissionState,
    } = create();
    projectLifecycleAdmissionState.error = new Error('competing lifecycle owner');

    await expect(orchestrator.acceptHostTransfer('member-target', {
      idempotencyKey: 'accept-a',
      projectId: 'project-a',
      receiverCredential: Buffer.alloc(32, 1).toString('base64url'),
      targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
      targetCaFingerprint: 'b'.repeat(64),
      targetEndpoint: 'https://192.168.1.20:27001',
      transferId: 'transfer-a',
    })).rejects.toThrow('competing lifecycle owner');

    expect(lifecycle.acceptHostTransfer).not.toHaveBeenCalled();
    expect(outgoing.prepareAccepted).not.toHaveBeenCalled();
  });

  it('starts outgoing transfer only after the Accept response is flushed', async () => {
    const { lifecycle, orchestrator, outgoing } = create();
    const request = {
      idempotencyKey: 'accept-a',
      projectId: 'project-a',
      receiverCredential: Buffer.alloc(32, 1).toString('base64url'),
      targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
      targetCaFingerprint: 'b'.repeat(64),
      targetEndpoint: 'https://192.168.1.20:27001',
      transferId: 'transfer-a',
    };

    const result = await orchestrator.acceptHostTransfer('member-target', request);

    expect(lifecycle.acceptHostTransfer).toHaveBeenCalledWith('member-target', request);
    expect(outgoing.run).not.toHaveBeenCalled();
    expect(outgoing.prepareAccepted).toHaveBeenCalledWith('project-a', 'transfer-a');
    expect('response' in result && result.response).toEqual(summary);
    if (!('response' in result)) throw new Error('Expected deferred response');
    result.afterResponseFlushed?.();
    result.afterResponseSettled?.();
    await Promise.resolve();
    expect(outgoing.run).toHaveBeenCalledWith('project-a', 'transfer-a');
  });

  it('preserves a lower lifecycle response-flush callback before cutover starts', async () => {
    const { lifecycle, orchestrator, outgoing } = create();
    const lowerCallback = jest.fn();
    lifecycle.acceptHostTransfer.mockResolvedValue({
      afterResponseFlushed: lowerCallback,
      response: summary,
    });
    const result = await orchestrator.acceptHostTransfer('member-target', {
      idempotencyKey: 'accept-a',
      projectId: 'project-a',
      receiverCredential: Buffer.alloc(32, 1).toString('base64url'),
      targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
      targetCaFingerprint: 'b'.repeat(64),
      targetEndpoint: 'https://192.168.1.20:27001',
      transferId: 'transfer-a',
    });

    if (!('response' in result)) throw new Error('Expected deferred response');
    result.afterResponseFlushed?.();
    result.afterResponseSettled?.();
    await Promise.resolve();

    expect(lowerCallback).toHaveBeenCalledTimes(1);
    expect(lowerCallback.mock.invocationCallOrder[0]).toBeLessThan(
      outgoing.run.mock.invocationCallOrder[0],
    );
  });

  it('does not schedule outgoing work when the authority expires the Accept exactly', async () => {
    const { lifecycle, orchestrator, outgoing } = create();
    lifecycle.acceptHostTransfer.mockResolvedValue({ ...summary, phase: 'expired' });

    const result = await orchestrator.acceptHostTransfer('member-target', {
      idempotencyKey: 'accept-expired',
      projectId: 'project-a',
      receiverCredential: Buffer.alloc(32, 1).toString('base64url'),
      targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
      targetCaFingerprint: 'b'.repeat(64),
      targetEndpoint: 'https://192.168.1.20:27001',
      transferId: 'transfer-a',
    });

    expect('response' in result && result.response.phase).toBe('expired');
    if (!('response' in result)) throw new Error('Expected deferred response');
    result.afterResponseFlushed?.();
    result.afterResponseSettled?.();
    await Promise.resolve();
    expect(outgoing.run).not.toHaveBeenCalled();
  });

  it('starts accepted outgoing recovery when the response closes before it flushes', async () => {
    const { orchestrator, outgoing } = create();
    const result = await orchestrator.acceptHostTransfer('member-target', {
      idempotencyKey: 'accept-a',
      projectId: 'project-a',
      receiverCredential: Buffer.alloc(32, 1).toString('base64url'),
      targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
      targetCaFingerprint: 'b'.repeat(64),
      targetEndpoint: 'https://192.168.1.20:27001',
      transferId: 'transfer-a',
    });

    if (!('response' in result)) throw new Error('Expected deferred response');
    expect(outgoing.run).not.toHaveBeenCalled();
    result.afterResponseSettled?.();
    await Promise.resolve();

    expect(outgoing.run).toHaveBeenCalledWith('project-a', 'transfer-a');
  });

  it('finishes target cancellation before reporting source Cancel success', async () => {
    const { lifecycle, orchestrator, outgoing } = create();
    const request = {
      expectedHostMemberId: 'member-source',
      idempotencyKey: 'cancel-a',
      projectId: 'project-a',
      transferId: 'transfer-a',
    };

    await orchestrator.cancelHostTransfer('member-source', request);

    expect(outgoing.prepareCancellation).toHaveBeenCalledWith(
      'project-a',
      'transfer-a',
    );
    expect(lifecycle.cancelHostTransfer).toHaveBeenCalledWith('member-source', request);
    expect(outgoing.cancelBeforeRelinquishment).toHaveBeenCalledWith(
      'project-a',
      'transfer-a',
    );
    expect(outgoing.prepareCancellation.mock.invocationCallOrder[0]).toBeLessThan(
      lifecycle.cancelHostTransfer.mock.invocationCallOrder[0],
    );
  });

  it('acquires source lifecycle ownership before cancellation recovery', async () => {
    const {
      lifecycle,
      orchestrator,
      outgoing,
      projectLifecycleAdmissionState,
    } = create();
    projectLifecycleAdmissionState.error = new Error('competing lifecycle owner');

    await expect(orchestrator.cancelHostTransfer('member-source', {
      expectedHostMemberId: 'member-source',
      idempotencyKey: 'cancel-a',
      projectId: 'project-a',
      transferId: 'transfer-a',
    })).rejects.toThrow('competing lifecycle owner');

    expect(outgoing.prepareCancellation).not.toHaveBeenCalled();
    expect(lifecycle.cancelHostTransfer).not.toHaveBeenCalled();
  });

  it('does not discard the authority credential when cancellation recovery cannot persist', async () => {
    const { lifecycle, orchestrator, outgoing } = create();
    outgoing.prepareCancellation.mockRejectedValue(new Error('recovery write failed'));

    await expect(orchestrator.cancelHostTransfer('member-source', {
      expectedHostMemberId: 'member-source',
      idempotencyKey: 'cancel-a',
      projectId: 'project-a',
      transferId: 'transfer-a',
    })).rejects.toThrow('recovery write failed');

    expect(lifecycle.cancelHostTransfer).not.toHaveBeenCalled();
    expect(outgoing.cancelBeforeRelinquishment).not.toHaveBeenCalled();
  });

  it('serializes Cancel behind durable outgoing preparation after Accept', async () => {
    const { lifecycle, orchestrator, outgoing } = create();
    let releasePreparation!: () => void;
    outgoing.prepareAccepted.mockImplementation(() => new Promise<void>(resolve => {
      releasePreparation = resolve;
    }));
    const accept = orchestrator.acceptHostTransfer('member-target', {
      idempotencyKey: 'accept-a',
      projectId: 'project-a',
      receiverCredential: Buffer.alloc(32, 1).toString('base64url'),
      targetCaCertificatePem: '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n',
      targetCaFingerprint: 'b'.repeat(64),
      targetEndpoint: 'https://192.168.1.20:27001',
      transferId: 'transfer-a',
    });
    await Promise.resolve();
    const cancel = orchestrator.cancelHostTransfer('member-source', {
      expectedHostMemberId: 'member-source',
      idempotencyKey: 'cancel-a',
      projectId: 'project-a',
      transferId: 'transfer-a',
    });
    await Promise.resolve();

    expect(lifecycle.cancelHostTransfer).not.toHaveBeenCalled();
    releasePreparation();
    await accept;
    await cancel;

    expect(lifecycle.cancelHostTransfer).toHaveBeenCalledTimes(1);
  });
});
