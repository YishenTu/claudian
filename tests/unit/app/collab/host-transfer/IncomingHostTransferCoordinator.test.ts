import { createHostTransferPackageManifest } from '@/app/collab/host-transfer/HostTransferPackage';
import type { HostTransferRecoveryRecord } from '@/app/collab/host-transfer/HostTransferRecoveryRecord';
import type { HostTransferActivationCertificate } from '@/app/collab/host-transfer/HostTrustTransitionService';
import {
  IncomingHostTransferCoordinator,
} from '@/app/collab/host-transfer/IncomingHostTransferCoordinator';

const NOW = '2026-08-08T00:00:00.000Z';
const TARGET_CA = '-----BEGIN CERTIFICATE-----\nTARGET\n-----END CERTIFICATE-----\n';
const TARGET_FINGERPRINT = 'b'.repeat(64);
const MANIFEST_DIGEST = 'c'.repeat(64);

describe('IncomingHostTransferCoordinator', () => {
  let record: HostTransferRecoveryRecord | null;
  let events: string[];
  let authority: { accept: jest.Mock };
  let preparation: {
    assertEligible: jest.Mock;
    cancelProvisional: jest.Mock;
    completeProvisional: jest.Mock;
    confirmTerminalReceipt: jest.Mock;
    restoreProvisional: jest.Mock;
    restoreTerminalReceipt: jest.Mock;
    startProvisional: jest.Mock;
  };
  let packages: { installAndActivate: jest.Mock; stageAndValidate: jest.Mock };
  let routeActivation: { activate: jest.Mock };
  let projections: {
    demoteSourceHost: jest.Mock;
    promoteTargetHost: jest.Mock;
    readPinnedSourceCa: jest.Mock;
  };
  let recovery: {
    load: jest.Mock;
    remove: jest.Mock;
    save: jest.Mock;
  };
  let trust: { verifyActivation: jest.Mock };
  let scheduledReceiptExpiry: (() => Promise<void>) | null;
  let currentNow: string;

  beforeEach(() => {
    record = null;
    events = [];
    authority = {
      accept: jest.fn(async () => {
        events.push('authority-accept');
        return { phase: 'accepted' };
      }),
    };
    preparation = {
      assertEligible: jest.fn(async () => events.push('eligible')),
      cancelProvisional: jest.fn(async () => undefined),
      completeProvisional: jest.fn(async () => events.push('complete-provisional')),
      confirmTerminalReceipt: jest.fn(async () => events.push('confirm-terminal')),
      restoreProvisional: jest.fn(async () => events.push('restore-provisional')),
      restoreTerminalReceipt: jest.fn(async () => events.push('restore-terminal')),
      startProvisional: jest.fn(async () => {
        events.push('provisional');
        return {
          endpoint: 'https://192.168.1.9:54545',
          receiverCredential: Buffer.alloc(32, 4).toString('base64url'),
          stagingDirectoryName: '.claudian-host-transfer-transfer-one',
          targetCaCertificatePem: TARGET_CA,
          targetCaFingerprint: TARGET_FINGERPRINT,
        };
      }),
    };
    packages = {
      installAndActivate: jest.fn(async () => {
        events.push('install-authority');
        return { eventSequence: 15 };
      }),
      stageAndValidate: jest.fn(async () => {
        events.push('stage');
        return { manifestDigest: MANIFEST_DIGEST };
      }),
    };
    routeActivation = {
      activate: jest.fn(async () => {
        events.push('activate-route');
        return { endpoint: 'https://192.168.1.9:54545' };
      }),
    };
    projections = {
      demoteSourceHost: jest.fn(),
      promoteTargetHost: jest.fn(async () => events.push('promote')),
      readPinnedSourceCa: jest.fn(async () => 'SOURCE CA'),
    };
    recovery = {
      load: jest.fn(async () => record),
      remove: jest.fn(async () => undefined),
      save: jest.fn(async value => {
        record = value;
        events.push(`save-${value.phase}`);
      }),
    };
    trust = { verifyActivation: jest.fn() };
    scheduledReceiptExpiry = null;
    currentNow = NOW;
  });

  function coordinator() {
    return new IncomingHostTransferCoordinator(
      authority as never,
      preparation,
      packages,
      routeActivation,
      projections,
      recovery,
      {
        now: () => new Date(currentNow),
        scheduleTerminalReceiptExpiry: (_delay, expire) => {
          scheduledReceiptExpiry = expire;
          return () => {
            scheduledReceiptExpiry = null;
          };
        },
        trust: trust as never,
      },
    );
  }

  async function acceptAndStage(instance = coordinator()) {
    await instance.accept({
      idempotencyKey: 'accept-one',
      projectId: 'project-alpha',
      sourceHostMemberId: 'member-host',
      targetHostMemberId: 'member-target',
      transferId: 'transfer-one',
    });
    const manifest = createHostTransferPackageManifest({
      authorityMainOid: 'a'.repeat(40),
      authoritySnapshot: { byteCount: 1, sha256: '1'.repeat(64) },
      createdAt: NOW,
      gitBundle: { byteCount: 1, sha256: '2'.repeat(64) },
      gitObjectFormat: 'sha1',
      projectId: 'project-alpha',
      proofChainDigest: '3'.repeat(64),
      sourceAuthorityGeneration: 5,
      targetCaFingerprint: TARGET_FINGERPRINT,
      targetHostMemberId: 'member-target',
      transferId: 'transfer-one',
    });
    async function* bytes() { yield Uint8Array.of(1); }
    await instance.stage({
      authoritySnapshot: bytes(),
      gitBundle: bytes(),
      manifest,
      projectId: 'project-alpha',
      transferId: 'transfer-one',
    });
    return instance;
  }

  function activation(): HostTransferActivationCertificate {
    return {
      cutoverAt: NOW,
      manifestDigest: MANIFEST_DIGEST,
      projectId: 'project-alpha',
      schemaVersion: 1,
      signature: 'A'.repeat(342),
      signatureAlgorithm: 'rsa-pss-sha256',
      targetCaFingerprint: TARGET_FINGERPRINT,
      targetHostMemberId: 'member-target',
      transferId: 'transfer-one',
    };
  }

  it('persists the provisional receiver before accepting and never activates before certificate', async () => {
    const instance = await acceptAndStage();

    expect(events.slice(0, 4)).toEqual([
      'eligible',
      'provisional',
      'save-accepted',
      'authority-accept',
    ]);
    expect(record?.phase).toBe('staged');
    expect(packages.installAndActivate).not.toHaveBeenCalled();

    await instance.activate('project-alpha', 'transfer-one', activation());
    expect(trust.verifyActivation).toHaveBeenCalled();
    expect(events).toEqual(expect.arrayContaining([
      'save-authority-relinquished',
      'install-authority',
      'promote',
      'activate-route',
      'save-target-active',
      'save-completed',
    ]));
    expect(projections.promoteTargetHost).toHaveBeenCalledWith({
      autoStart: true,
      endpoint: 'https://192.168.1.9:54545',
      eventSequence: 15,
      ownsAuthority: true,
      projectId: 'project-alpha',
      targetCaCertificatePem: TARGET_CA,
      targetCaFingerprint: TARGET_FINGERPRINT,
      targetHostMemberId: 'member-target',
      transferId: 'transfer-one',
    });
    expect(record?.phase).toBe('completed');
    expect(recovery.remove).not.toHaveBeenCalled();
  });

  it('recovers the same staged activation after a crash without guessing', async () => {
    const instance = await acceptAndStage();
    packages.installAndActivate.mockRejectedValueOnce(new Error('crash'));

    await expect(instance.activate(
      'project-alpha',
      'transfer-one',
      activation(),
    )).rejects.toThrow('crash');
    expect(record?.phase).toBe('authority-relinquished');
    expect(projections.promoteTargetHost).not.toHaveBeenCalled();

    await coordinator().resume('project-alpha');
    expect(packages.installAndActivate).toHaveBeenCalledTimes(2);
    expect(record?.phase).toBe('completed');
    expect(routeActivation.activate).toHaveBeenCalledTimes(1);
  });

  it('restores the provisional receiver after a staged target restart', async () => {
    await acceptAndStage();
    preparation.restoreProvisional.mockClear();

    await coordinator().resume('project-alpha');

    expect(record?.phase).toBe('staged');
    expect(preparation.restoreProvisional).toHaveBeenCalledWith(record);
    expect(packages.installAndActivate).not.toHaveBeenCalled();
    expect(routeActivation.activate).not.toHaveBeenCalled();
  });

  it('replays an ambiguous accepted authority mutation after target restart', async () => {
    const instance = coordinator();
    await instance.accept({
      idempotencyKey: 'accept-one',
      projectId: 'project-alpha',
      sourceHostMemberId: 'member-host',
      targetHostMemberId: 'member-target',
      transferId: 'transfer-one',
    });
    authority.accept.mockClear();
    preparation.restoreProvisional.mockClear();

    await coordinator().resume('project-alpha');

    expect(preparation.restoreProvisional).toHaveBeenCalledWith(record);
    expect(authority.accept).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: expect.stringMatching(/^accept-host-transfer-[a-f0-9]{64}$/),
      projectId: 'project-alpha',
      transferId: 'transfer-one',
    }));
  });

  it('durably replays a lost activation response until the source confirms completion', async () => {
    const instance = await acceptAndStage();
    const certificate = activation();

    await instance.activate('project-alpha', 'transfer-one', certificate);
    expect(record?.phase).toBe('completed');
    expect(recovery.remove).not.toHaveBeenCalled();
    expect(preparation.completeProvisional).not.toHaveBeenCalled();

    await instance.activate('project-alpha', 'transfer-one', certificate);
    expect(packages.installAndActivate).toHaveBeenCalledTimes(1);
    expect(routeActivation.activate).toHaveBeenCalledTimes(1);

    const completion = await instance.complete('project-alpha', 'transfer-one');
    expect(preparation.completeProvisional).not.toHaveBeenCalled();
    const completedRecord = record;
    await completion.afterResponseFlushed();
    expect(preparation.completeProvisional).toHaveBeenCalledWith(expect.objectContaining({
      ...completedRecord,
      receiverCredential: null,
      receiverCredentialHash: expect.any(String),
      stagingDirectoryName: '.claudian-host-transfer-transfer-one',
    }));
    expect(record).toMatchObject({
      phase: 'completed',
      receiverCredential: null,
      receiverCredentialHash: expect.any(String),
    });
    expect(preparation.restoreTerminalReceipt).toHaveBeenCalledWith(record);
    expect(scheduledReceiptExpiry).not.toBeNull();

    const replay = await instance.complete('project-alpha', 'transfer-one');
    await replay.afterResponseFlushed();
    expect(preparation.completeProvisional).toHaveBeenCalledTimes(1);

    const confirmation = await instance.confirm('project-alpha', 'transfer-one');
    await confirmation.afterResponseFlushed();
    expect(recovery.remove).toHaveBeenCalledWith('project-alpha', 'incoming');
    expect(scheduledReceiptExpiry).toBeNull();
  });

  it('expires an unconfirmed terminal receipt after the bounded replay window', async () => {
    const instance = await acceptAndStage();
    await instance.activate('project-alpha', 'transfer-one', activation());
    const completion = await instance.complete('project-alpha', 'transfer-one');
    await completion.afterResponseFlushed();
    expect(scheduledReceiptExpiry).not.toBeNull();

    currentNow = '2026-08-09T00:00:00.000Z';
    await scheduledReceiptExpiry!();

    expect(preparation.confirmTerminalReceipt).toHaveBeenCalledWith(record);
    expect(recovery.remove).toHaveBeenCalledWith('project-alpha', 'incoming');
  });

  it('cancels terminal receipt expiry and rejects late work after close', async () => {
    const instance = await acceptAndStage();
    await instance.activate('project-alpha', 'transfer-one', activation());
    const completion = await instance.complete('project-alpha', 'transfer-one');
    await completion.afterResponseFlushed();
    expect(scheduledReceiptExpiry).not.toBeNull();

    await instance.close();

    expect(scheduledReceiptExpiry).toBeNull();
    await expect(instance.resume('project-alpha')).rejects.toMatchObject({
      code: 'cancelled',
    });
  });

  it('restores a completed provisional receiver after target restart for activation replay', async () => {
    const instance = await acceptAndStage();
    await instance.activate('project-alpha', 'transfer-one', activation());
    preparation.restoreProvisional.mockClear();

    await coordinator().resume('project-alpha');

    expect(preparation.restoreProvisional).toHaveBeenCalledWith(record);
    expect(preparation.completeProvisional).not.toHaveBeenCalled();
    expect(recovery.remove).not.toHaveBeenCalled();
  });

  it('replays the same activation certificate independent of object key order', async () => {
    const instance = await acceptAndStage();
    const certificate = activation();
    packages.installAndActivate.mockRejectedValueOnce(new Error('crash'));
    await expect(instance.activate(
      'project-alpha',
      'transfer-one',
      certificate,
    )).rejects.toThrow('crash');

    const reordered: HostTransferActivationCertificate = {
      signature: certificate.signature,
      signatureAlgorithm: certificate.signatureAlgorithm,
      cutoverAt: certificate.cutoverAt,
      manifestDigest: certificate.manifestDigest,
      targetCaFingerprint: certificate.targetCaFingerprint,
      targetHostMemberId: certificate.targetHostMemberId,
      transferId: certificate.transferId,
      projectId: certificate.projectId,
      schemaVersion: certificate.schemaVersion,
    };
    await instance.activate('project-alpha', 'transfer-one', reordered);

    expect(record?.phase).toBe('completed');
  });

  it('persists cancellation but defers replayable provisional cleanup until the response flushes', async () => {
    const instance = coordinator();
    await instance.accept({
      idempotencyKey: 'accept-one',
      projectId: 'project-alpha',
      sourceHostMemberId: 'member-host',
      targetHostMemberId: 'member-target',
      transferId: 'transfer-one',
    });
    preparation.cancelProvisional.mockImplementationOnce(async value => {
      events.push(`cancel-provisional-after-${record?.phase}`);
      expect(value.phase).toBe('cancelled');
      throw new Error('cleanup interrupted');
    }).mockImplementationOnce(async () => {
      events.push(`cancel-provisional-after-${record?.phase}`);
    });

    const cancellation = await instance.cancel('project-alpha', 'transfer-one');
    expect(record).toMatchObject({
      phase: 'cancelled',
      receiverCredential: expect.any(String),
      receiverCredentialHash: null,
      stagingDirectoryName: '.claudian-host-transfer-transfer-one',
    });
    expect(preparation.cancelProvisional).not.toHaveBeenCalled();

    await expect(cancellation.afterResponseFlushed())
      .rejects.toThrow('cleanup interrupted');
    expect(record?.phase).toBe('cancelled');
    expect(events).toContain('cancel-provisional-after-cancelled');

    const replay = await instance.cancel('project-alpha', 'transfer-one');
    await replay.afterResponseFlushed();
    expect(preparation.cancelProvisional).toHaveBeenCalledTimes(2);
    expect(packages.installAndActivate).not.toHaveBeenCalled();
    expect(record).toMatchObject({
      phase: 'cancelled',
      receiverCredential: null,
      receiverCredentialHash: expect.any(String),
    });
  });

  it('recovers a crash after terminal receipt persistence but before provisional cleanup', async () => {
    const instance = coordinator();
    await instance.accept({
      idempotencyKey: 'accept-one',
      projectId: 'project-alpha',
      sourceHostMemberId: 'member-host',
      targetHostMemberId: 'member-target',
      transferId: 'transfer-one',
    });
    preparation.cancelProvisional.mockRejectedValueOnce(new Error('power loss'));
    const cancellation = await instance.cancel('project-alpha', 'transfer-one');

    await expect(cancellation.afterResponseFlushed()).rejects.toThrow('power loss');
    expect(record).toMatchObject({
      phase: 'cancelled',
      receiverCredential: null,
      receiverCredentialHash: expect.any(String),
      stagingDirectoryName: '.claudian-host-transfer-transfer-one',
    });

    await coordinator().resume('project-alpha');

    expect(preparation.cancelProvisional).toHaveBeenCalledTimes(2);
    expect(record).toMatchObject({
      receiverCredentialHash: expect.any(String),
      stagingDirectoryName: null,
    });
    expect(preparation.restoreTerminalReceipt).toHaveBeenCalledWith(record);
  });

  it('removes provisional state when the authority reports an exact expired Accept', async () => {
    authority.accept.mockResolvedValue({ phase: 'expired' });
    preparation.cancelProvisional.mockImplementation(async value => {
      events.push(`cancel-provisional-after-${value.phase}`);
    });

    await expect(coordinator().accept({
      idempotencyKey: 'accept-expired',
      projectId: 'project-alpha',
      sourceHostMemberId: 'member-host',
      targetHostMemberId: 'member-target',
      transferId: 'transfer-one',
    })).rejects.toMatchObject({
      code: 'operation-failed',
      safeContext: { reason: 'host-transfer-acceptance-expired' },
    });

    expect(events).toEqual(expect.arrayContaining([
      'save-accepted',
      'save-expired',
      'cancel-provisional-after-expired',
    ]));
    expect(recovery.remove).toHaveBeenCalledWith('project-alpha', 'incoming');
    expect(routeActivation.activate).not.toHaveBeenCalled();
  });
});
