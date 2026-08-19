import { createHash } from 'node:crypto';

import { type CollabIdempotencyKey, type CollabMemberId, type CollabOperationId, type CollabProjectId } from '@claudian/collab-protocol';

import type {
  HostTransferProjectionPort,
  HostTransferRecoveryStorePort,
  IncomingHostTransferActivationPort,
  IncomingHostTransferAuthorityClientPort,
  IncomingHostTransferPackagePort,
  IncomingHostTransferPreparationPort,
} from '@/app/collab/host-transfer/HostTransferCoordinatorPorts';
import {
  hostTransferAcceptanceIdempotencyKey,
} from '@/app/collab/host-transfer/HostTransferOperationIdentity';
import type { HostTransferPackageManifest } from '@/app/collab/host-transfer/HostTransferPackage';
import {
  advanceHostTransferRecoveryRecord,
  createHostTransferRecoveryRecord,
  parseHostTransferActivationCertificate,
} from '@/app/collab/host-transfer/HostTransferRecovery';
import type {
  HostTransferRecoveryRecord,
} from '@/app/collab/host-transfer/HostTransferRecoveryRecord';
import {
  type HostTransferActivationCertificate,
  HostTrustTransitionService,
} from '@/app/collab/host-transfer/HostTrustTransitionService';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface IncomingHostTransferCoordinatorOptions {
  readonly now?: () => Date;
  readonly scheduleTerminalReceiptExpiry?: (
    delayMs: number,
    expire: () => Promise<void>,
  ) => () => void;
  readonly terminalReceiptTtlMs?: number;
  readonly trust?: Pick<HostTrustTransitionService, 'verifyActivation'>;
}

export interface AcceptIncomingHostTransferInput {
  readonly idempotencyKey: CollabIdempotencyKey;
  readonly projectId: CollabProjectId;
  readonly sourceHostMemberId: CollabMemberId;
  readonly targetHostMemberId: CollabMemberId;
  readonly transferId: CollabOperationId;
  readonly signal?: AbortSignal;
}

export interface StageIncomingHostTransferInput {
  readonly authoritySnapshot: AsyncIterable<Uint8Array>;
  readonly gitBundle: AsyncIterable<Uint8Array>;
  readonly manifest: HostTransferPackageManifest;
  readonly projectId: CollabProjectId;
  readonly transferId: CollabOperationId;
  readonly signal?: AbortSignal;
}

export interface IncomingHostTransferTerminalResult {
  afterResponseFlushed(): Promise<void>;
}

function incomingError(
  reason: string,
  code: 'cancelled' | 'durable-progress-recovery-required' | 'operation-failed'
    = 'durable-progress-recovery-required',
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'cancelled' ? ['retry'] : ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw incomingError('host-transfer-incoming-cancelled', 'cancelled');
}

function sameActivationCertificate(
  left: HostTransferActivationCertificate,
  right: HostTransferActivationCertificate,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.projectId === right.projectId
    && left.transferId === right.transferId
    && left.targetHostMemberId === right.targetHostMemberId
    && left.targetCaFingerprint === right.targetCaFingerprint
    && left.manifestDigest === right.manifestDigest
    && left.cutoverAt === right.cutoverAt
    && left.signatureAlgorithm === right.signatureAlgorithm
    && left.signature === right.signature;
}

const DEFAULT_TERMINAL_RECEIPT_TTL_MS = 24 * 60 * 60 * 1_000;

export class IncomingHostTransferCoordinator {
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private readonly now: () => Date;
  private readonly receiptExpiry = new Map<CollabProjectId, () => void>();
  private readonly scheduleTerminalReceiptExpiry: NonNullable<
    IncomingHostTransferCoordinatorOptions['scheduleTerminalReceiptExpiry']
  >;
  private readonly terminalReceiptTtlMs: number;
  private readonly trust: Pick<HostTrustTransitionService, 'verifyActivation'>;
  private readonly operationQueue = new SerialTaskQueue();

  constructor(
    private readonly authority: IncomingHostTransferAuthorityClientPort,
    private readonly preparation: IncomingHostTransferPreparationPort,
    private readonly packages: IncomingHostTransferPackagePort,
    private readonly activation: IncomingHostTransferActivationPort,
    private readonly projections: HostTransferProjectionPort,
    private readonly recovery: HostTransferRecoveryStorePort,
    options: IncomingHostTransferCoordinatorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.scheduleTerminalReceiptExpiry = options.scheduleTerminalReceiptExpiry
      ?? ((delayMs, expire) => {
        const timer = window.setTimeout(() => void expire().catch(() => undefined), delayMs);
        return () => window.clearTimeout(timer);
      });
    this.terminalReceiptTtlMs = options.terminalReceiptTtlMs
      ?? DEFAULT_TERMINAL_RECEIPT_TTL_MS;
    if (!Number.isSafeInteger(this.terminalReceiptTtlMs) || this.terminalReceiptTtlMs < 1) {
      throw new TypeError('Invalid Host transfer terminal receipt TTL');
    }
    this.trust = options.trust ?? new HostTrustTransitionService();
  }

  accept(input: AcceptIncomingHostTransferInput): Promise<void> {
    return this.enqueue(() => this.acceptUnlocked(input));
  }

  stage(input: StageIncomingHostTransferInput): Promise<{ readonly manifestDigest: string }> {
    return this.enqueue(() => this.stageUnlocked(input));
  }

  activate(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
    certificate: HostTransferActivationCertificate,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.enqueue(() => this.activateUnlocked(projectId, transferId, certificate, signal));
  }

  cancel(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
    signal?: AbortSignal,
  ): Promise<IncomingHostTransferTerminalResult> {
    return this.enqueue(() => this.cancelUnlocked(projectId, transferId, signal));
  }

  complete(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
    signal?: AbortSignal,
  ): Promise<IncomingHostTransferTerminalResult> {
    return this.enqueue(() => this.completeUnlocked(projectId, transferId, signal));
  }

  confirm(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
    signal?: AbortSignal,
  ): Promise<IncomingHostTransferTerminalResult> {
    return this.enqueue(() => this.confirmUnlocked(projectId, transferId, signal));
  }

  resume(projectId: CollabProjectId, signal?: AbortSignal): Promise<void> {
    return this.enqueue(async () => {
      const record = await this.recovery.load(projectId, 'incoming');
      if (!record) return;
      if (record.receiverCredentialHash) {
        if (record.stagingDirectoryName) {
          await this.finishTerminalCleanup(record, this.terminalKind(record));
          return;
        }
        if (this.isTerminalReceiptExpired(record)) {
          await this.removeTerminalReceipt(record);
          return;
        }
        await this.preparation.restoreTerminalReceipt(record);
        this.scheduleTerminalReceipt(record);
        return;
      }
      if (record.phase === 'completed') {
        await this.preparation.restoreProvisional(record);
        return;
      }
      throwIfCancelled(signal);
      if (record.phase === 'accepted') {
        await this.preparation.restoreProvisional(record);
        await this.acceptAuthority(record, {
          idempotencyKey: hostTransferAcceptanceIdempotencyKey(
            record.projectId,
            record.transferId,
            record.targetHostMemberId,
          ),
          projectId: record.projectId,
          receiverCredential: record.receiverCredential!,
          targetCaCertificatePem: record.targetCaCertificatePem!,
          targetCaFingerprint: record.targetCaFingerprint!,
          targetEndpoint: record.targetEndpoint!,
          transferId: record.transferId,
        });
        return;
      }
      if (record.phase === 'quiescing' || record.phase === 'staged') {
        await this.preparation.restoreProvisional(record);
        return;
      }
      if (record.phase === 'authority-relinquished' || record.phase === 'target-active') {
        await this.activateRecord(record, signal);
        return;
      }
      if (
        record.phase === 'cancelled'
        || record.phase === 'declined'
        || record.phase === 'expired'
      ) {
        await this.preparation.cancelProvisional(record);
        await this.recovery.remove(projectId, 'incoming');
      }
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    for (const cancel of this.receiptExpiry.values()) cancel();
    this.receiptExpiry.clear();
    this.closePromise = this.operationQueue.drain().then(() => {
      for (const cancel of this.receiptExpiry.values()) cancel();
      this.receiptExpiry.clear();
    });
    return this.closePromise;
  }

  private async acceptUnlocked(input: AcceptIncomingHostTransferInput): Promise<void> {
    throwIfCancelled(input.signal);
    const existing = await this.recovery.load(input.projectId, 'incoming');
    if (existing) {
      if (
        existing.transferId !== input.transferId
        || existing.targetHostMemberId !== input.targetHostMemberId
        || existing.sourceHostMemberId !== input.sourceHostMemberId
      ) throw incomingError('host-transfer-incoming-operation-mismatch');
      if (existing.phase !== 'offered') {
        if (
          existing.phase === 'cancelled'
          || existing.phase === 'declined'
          || existing.phase === 'expired'
        ) {
          await this.preparation.cancelProvisional(existing);
          await this.recovery.remove(existing.projectId, 'incoming');
          throw incomingError(`host-transfer-acceptance-${existing.phase}`, 'operation-failed');
        }
        await this.preparation.restoreProvisional(existing);
        if (existing.phase === 'accepted') {
          await this.acceptAuthority(existing, {
            idempotencyKey: input.idempotencyKey,
            projectId: input.projectId,
            receiverCredential: existing.receiverCredential!,
            targetCaCertificatePem: existing.targetCaCertificatePem!,
            targetCaFingerprint: existing.targetCaFingerprint!,
            targetEndpoint: existing.targetEndpoint!,
            transferId: input.transferId,
          });
          return;
        }
        return;
      }
    }
    await this.preparation.assertEligible({
      projectId: input.projectId,
      targetMemberId: input.targetHostMemberId,
      transferId: input.transferId,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    throwIfCancelled(input.signal);
    const provisional = await this.preparation.startProvisional(input);
    const now = this.now().toISOString();
    const record = createHostTransferRecoveryRecord({
      createdAt: now,
      direction: 'incoming',
      projectId: input.projectId,
      receiverCredential: provisional.receiverCredential,
      sourceHostMemberId: input.sourceHostMemberId,
      stagingDirectoryName: provisional.stagingDirectoryName,
      targetCaCertificatePem: provisional.targetCaCertificatePem,
      targetCaFingerprint: provisional.targetCaFingerprint,
      targetEndpoint: provisional.endpoint,
      targetHostMemberId: input.targetHostMemberId,
      transferId: input.transferId,
    });
    await this.recovery.save(record);
    await this.acceptAuthority(record, {
      idempotencyKey: input.idempotencyKey,
      projectId: input.projectId,
      receiverCredential: provisional.receiverCredential,
      targetCaCertificatePem: provisional.targetCaCertificatePem,
      targetCaFingerprint: provisional.targetCaFingerprint,
      targetEndpoint: provisional.endpoint,
      transferId: input.transferId,
    });
  }

  private async stageUnlocked(
    input: StageIncomingHostTransferInput,
  ): Promise<{ readonly manifestDigest: string }> {
    throwIfCancelled(input.signal);
    const record = await this.requireRecord(input.projectId, input.transferId);
    if (record.phase === 'staged' || record.phase === 'authority-relinquished'
      || record.phase === 'target-active' || record.phase === 'completed') {
      if (!record.manifestDigest) throw incomingError('host-transfer-manifest-missing');
      return { manifestDigest: record.manifestDigest };
    }
    if (record.phase !== 'accepted' && record.phase !== 'quiescing') {
      throw incomingError('host-transfer-incoming-not-stageable');
    }
    if (
      input.manifest.projectId !== record.projectId
      || input.manifest.transferId !== record.transferId
      || input.manifest.targetHostMemberId !== record.targetHostMemberId
      || input.manifest.targetCaFingerprint !== record.targetCaFingerprint
    ) throw incomingError('host-transfer-manifest-binding-mismatch');
    const staged = await this.packages.stageAndValidate({
      authoritySnapshot: input.authoritySnapshot,
      gitBundle: input.gitBundle,
      manifest: input.manifest,
      record,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    throwIfCancelled(input.signal);
    const updated = advanceHostTransferRecoveryRecord(
      record,
      'staged',
      this.now().toISOString(),
      { manifestDigest: staged.manifestDigest },
    );
    await this.recovery.save(updated);
    return staged;
  }

  private async activateUnlocked(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
    certificate: HostTransferActivationCertificate,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfCancelled(signal);
    const record = await this.requireRecord(projectId, transferId);
    if (record.phase === 'completed') {
      const persisted = parseHostTransferActivationCertificate(record);
      if (!sameActivationCertificate(persisted, certificate)) {
        throw incomingError('host-transfer-activation-replay-mismatch');
      }
      return;
    }
    if (record.phase === 'staged') {
      const previousCa = await this.projections.readPinnedSourceCa(record.projectId);
      this.trust.verifyActivation(certificate, previousCa, {
        cutoverAt: certificate.cutoverAt,
        manifestDigest: record.manifestDigest!,
        projectId: record.projectId,
        targetCaFingerprint: record.targetCaFingerprint!,
        targetHostMemberId: record.targetHostMemberId,
        transferId: record.transferId,
      });
      const relinquished = advanceHostTransferRecoveryRecord(
        record,
        'authority-relinquished',
        this.now().toISOString(),
        { activationCertificate: certificate },
      );
      await this.recovery.save(relinquished);
      await this.activateRecord(relinquished, signal);
      return;
    }
    if (record.phase === 'authority-relinquished' || record.phase === 'target-active') {
      const persisted = parseHostTransferActivationCertificate(record);
      if (!sameActivationCertificate(persisted, certificate)) {
        throw incomingError('host-transfer-activation-replay-mismatch');
      }
      await this.activateRecord(record, signal);
      return;
    }
    throw incomingError('host-transfer-incoming-not-activatable');
  }

  private async cancelUnlocked(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
    signal?: AbortSignal,
  ): Promise<IncomingHostTransferTerminalResult> {
    throwIfCancelled(signal);
    const record = await this.requireRecord(projectId, transferId);
    if (record.phase === 'cancelled') {
      return this.deferredTerminalCleanup(record, 'cancel');
    }
    if (record.phase !== 'accepted' && record.phase !== 'quiescing' && record.phase !== 'staged') {
      throw incomingError('host-transfer-incoming-cancel-unavailable');
    }
    const cancelled = advanceHostTransferRecoveryRecord(
      record,
      'cancelled',
      this.now().toISOString(),
    );
    await this.recovery.save(cancelled);
    throwIfCancelled(signal);
    return this.deferredTerminalCleanup(cancelled, 'cancel');
  }

  private async completeUnlocked(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
    signal?: AbortSignal,
  ): Promise<IncomingHostTransferTerminalResult> {
    throwIfCancelled(signal);
    const record = await this.requireRecord(projectId, transferId);
    if (record.phase !== 'completed') {
      throw incomingError('host-transfer-incoming-completion-unavailable');
    }
    return this.deferredTerminalCleanup(record, 'complete');
  }

  private async confirmUnlocked(
    projectId: CollabProjectId,
    transferId: CollabOperationId,
    signal?: AbortSignal,
  ): Promise<IncomingHostTransferTerminalResult> {
    throwIfCancelled(signal);
    const record = await this.requireRecord(projectId, transferId);
    if (!record.receiverCredentialHash) {
      throw incomingError('host-transfer-terminal-receipt-missing');
    }
    return {
      afterResponseFlushed: () => this.enqueue(async () => {
        const current = await this.requireRecord(projectId, transferId);
        if (current.receiverCredentialHash !== record.receiverCredentialHash) {
          throw incomingError('host-transfer-terminal-receipt-changed');
        }
        await this.removeTerminalReceipt(current);
      }),
    };
  }

  private async acceptAuthority(
    record: HostTransferRecoveryRecord,
    request: Parameters<IncomingHostTransferAuthorityClientPort['accept']>[0],
  ): Promise<void> {
    const result = await this.authority.accept(request);
    if (result.phase === 'accepted') return;
    const terminalPhase = result.phase === 'expired'
      ? 'expired' as const
      : result.phase === 'declined'
        ? 'declined' as const
        : 'cancelled' as const;
    const terminal = advanceHostTransferRecoveryRecord(
      record,
      terminalPhase,
      this.now().toISOString(),
    );
    await this.recovery.save(terminal);
    await this.preparation.cancelProvisional(terminal);
    await this.recovery.remove(record.projectId, 'incoming');
    throw incomingError(`host-transfer-acceptance-${result.phase}`, 'operation-failed');
  }

  private deferredTerminalCleanup(
    record: HostTransferRecoveryRecord,
    kind: 'cancel' | 'complete',
  ): IncomingHostTransferTerminalResult {
    return {
      afterResponseFlushed: () => this.enqueue(async () => {
        let current = await this.requireRecord(record.projectId, record.transferId);
        if (current.receiverCredentialHash && current.stagingDirectoryName === null) return;
        if (current.phase !== record.phase) {
          throw incomingError('host-transfer-terminal-cleanup-phase-mismatch');
        }
        if (!current.receiverCredentialHash) {
          current = advanceHostTransferRecoveryRecord(
            current,
            current.phase,
            this.now().toISOString(),
            {
            terminalReceiptCredentialHash: createHash('sha256')
              .update(Buffer.from(current.receiverCredential!, 'base64url'))
              .digest('hex'),
            },
          );
          await this.recovery.save(current);
        }
        await this.finishTerminalCleanup(current, kind);
      }),
    };
  }

  private async finishTerminalCleanup(
    record: HostTransferRecoveryRecord,
    kind: 'cancel' | 'complete',
  ): Promise<HostTransferRecoveryRecord> {
    if (!record.receiverCredentialHash) {
      throw incomingError('host-transfer-terminal-receipt-missing');
    }
    if (record.stagingDirectoryName !== null) {
      if (kind === 'cancel') await this.preparation.cancelProvisional(record);
      else await this.preparation.completeProvisional(record);
    }
    const receipt = record.stagingDirectoryName === null
      ? record
      : advanceHostTransferRecoveryRecord(
        record,
        record.phase,
        this.now().toISOString(),
        { terminalCleanupComplete: true },
      );
    if (receipt !== record) await this.recovery.save(receipt);
    await this.preparation.restoreTerminalReceipt(receipt);
    this.scheduleTerminalReceipt(receipt);
    return receipt;
  }

  private terminalKind(record: HostTransferRecoveryRecord): 'cancel' | 'complete' {
    return record.phase === 'completed' ? 'complete' : 'cancel';
  }

  private scheduleTerminalReceipt(record: HostTransferRecoveryRecord): void {
    if (this.closed) return;
    this.clearTerminalReceiptExpiry(record.projectId);
    const expiresAt = Date.parse(record.updatedAt) + this.terminalReceiptTtlMs;
    const delayMs = Math.max(0, expiresAt - this.now().getTime());
    const cancel = this.scheduleTerminalReceiptExpiry(delayMs, () => this.enqueue(async () => {
      const current = await this.recovery.load(record.projectId, 'incoming');
      if (
        !current
        || current.transferId !== record.transferId
        || current.receiverCredentialHash !== record.receiverCredentialHash
      ) return;
      if (!this.isTerminalReceiptExpired(current)) {
        this.scheduleTerminalReceipt(current);
        return;
      }
      await this.removeTerminalReceipt(current);
    }));
    this.receiptExpiry.set(record.projectId, cancel);
  }

  private isTerminalReceiptExpired(record: HostTransferRecoveryRecord): boolean {
    return this.now().getTime() >= Date.parse(record.updatedAt) + this.terminalReceiptTtlMs;
  }

  private async removeTerminalReceipt(record: HostTransferRecoveryRecord): Promise<void> {
    this.clearTerminalReceiptExpiry(record.projectId);
    await this.preparation.confirmTerminalReceipt(record);
    await this.recovery.remove(record.projectId, 'incoming');
  }

  private clearTerminalReceiptExpiry(projectId: CollabProjectId): void {
    this.receiptExpiry.get(projectId)?.();
    this.receiptExpiry.delete(projectId);
  }

  private async activateRecord(
    record: Awaited<ReturnType<HostTransferRecoveryStorePort['load']>> & {},
    signal?: AbortSignal,
  ): Promise<void> {
    const certificate = parseHostTransferActivationCertificate(record);
    const previousCa = await this.projections.readPinnedSourceCa(record.projectId);
    this.trust.verifyActivation(certificate, previousCa, {
      cutoverAt: certificate.cutoverAt,
      manifestDigest: record.manifestDigest!,
      projectId: record.projectId,
      targetCaFingerprint: record.targetCaFingerprint!,
      targetHostMemberId: record.targetHostMemberId,
      transferId: record.transferId,
    });
    throwIfCancelled(signal);
    const activated = await this.packages.installAndActivate({
      activationCertificate: certificate,
      manifestDigest: record.manifestDigest!,
      record,
      ...(signal ? { signal } : {}),
    });
    await this.projections.promoteTargetHost({
      autoStart: true,
      endpoint: record.targetEndpoint!,
      eventSequence: activated.eventSequence,
      ownsAuthority: true,
      projectId: record.projectId,
      targetCaCertificatePem: record.targetCaCertificatePem!,
      targetCaFingerprint: record.targetCaFingerprint!,
      targetHostMemberId: record.targetHostMemberId,
      transferId: record.transferId,
    });
    const active = await this.activation.activate({
      projectId: record.projectId,
      targetHostMemberId: record.targetHostMemberId,
      transferId: record.transferId,
    });
    if (active.endpoint !== record.targetEndpoint) {
      throw incomingError('host-transfer-target-endpoint-drift');
    }
    if (record.phase === 'authority-relinquished') {
      const targetActive = advanceHostTransferRecoveryRecord(
        record,
        'target-active',
        this.now().toISOString(),
      );
      await this.recovery.save(targetActive);
      const completed = advanceHostTransferRecoveryRecord(
        targetActive,
        'completed',
        this.now().toISOString(),
      );
      await this.recovery.save(completed);
      return;
    }
    const completed = advanceHostTransferRecoveryRecord(
      record,
      'completed',
      this.now().toISOString(),
    );
    await this.recovery.save(completed);
  }

  private async requireRecord(projectId: string, transferId: string) {
    const record = await this.recovery.load(projectId, 'incoming');
    if (!record || record.transferId !== transferId) {
      throw incomingError('host-transfer-incoming-record-missing');
    }
    return record;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(incomingError('host-transfer-incoming-closed', 'cancelled'));
    }
    return this.operationQueue.run(operation);
  }
}
