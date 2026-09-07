import {
  type CollabProjectId,
  type CollabProjectRetirementAcknowledgement,
} from '@claudian-collab/protocol';

import type { AcknowledgeRetirementResponse } from '@/app/collab/lan/LanCollabControlOperations';
import type {
  CollabProjectLifecycleAdmission,
} from '@/app/collab/lifecycle/CollabProjectLifecycleAdmission';
import type { RetirementRecord } from '@/app/collab/retirement/RetirementRecord';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface RetirementClientStore {
  removeRetirementAcknowledgement(projectId: CollabProjectId): Promise<boolean>;
  loadRetirementRecord(projectId: CollabProjectId): Promise<RetirementRecord | null>;
  updateRetirementRecord(
    projectId: CollabProjectId,
    update: (record: RetirementRecord) => RetirementRecord,
  ): Promise<RetirementRecord>;
}

export interface RetirementAcknowledgementClientPort {
  acknowledge(input: {
    readonly hostCaCertificatePem: string;
    readonly hostCaFingerprint: string;
    readonly hostEndpoint: string;
    readonly idempotencyKey: string;
    readonly memberCredential: string;
    readonly projectId: CollabProjectId;
    readonly retiredAt: string;
    readonly signal?: AbortSignal;
  }): Promise<AcknowledgeRetirementResponse>;
  acknowledgeCloud(input: {
    readonly developmentActorId: string;
    readonly projectId: CollabProjectId;
    readonly retirementId: string;
    readonly serverUrl: string;
    readonly signal?: AbortSignal;
  }): Promise<CollabProjectRetirementAcknowledgement>;
}

export interface RetirementAcknowledgementScheduler {
  schedule(projectId: CollabProjectId): void;
}

export interface RetirementAcknowledgementWorkerOptions {
  readonly now?: () => Date;
  readonly projectRecoveryAdmission: CollabProjectLifecycleAdmission;
  readonly scheduleRetry?: (
    projectId: CollabProjectId,
    retry: () => Promise<void>,
    delayMs: number,
  ) => (() => void) | void;
}

export type RetirementAcknowledgementRunResult =
  | 'acknowledged'
  | 'cancelled'
  | 'expired'
  | 'missing'
  | 'retry-pending';

const RETRYABLE_CODES = new Set([
  'offline',
  'host-stopped',
  'endpoint-unreachable',
  'local-network-permission-required',
  'operation-timeout',
  'operation-failed',
  'tls-ca-mismatch',
  'tls-untrusted',
]);

export class RetirementAcknowledgementWorker
implements RetirementAcknowledgementScheduler {
  private readonly active = new Map<CollabProjectId, Promise<RetirementAcknowledgementRunResult>>();
  private readonly controller = new AbortController();
  private closed = false;
  private readonly now: () => Date;
  private readonly projectRecoveryAdmission: CollabProjectLifecycleAdmission;
  private readonly retryScheduled = new Set<CollabProjectId>();
  private readonly retryAttempts = new Map<CollabProjectId, number>();
  private readonly retryCancellations = new Map<CollabProjectId, () => void>();
  private readonly scheduleRetry: NonNullable<RetirementAcknowledgementWorkerOptions['scheduleRetry']>;

  constructor(
    private readonly store: RetirementClientStore,
    private readonly client: RetirementAcknowledgementClientPort,
    options: RetirementAcknowledgementWorkerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.projectRecoveryAdmission = options.projectRecoveryAdmission;
    this.scheduleRetry = options.scheduleRetry ?? ((_projectId, retry, delayMs) => {
      const timer = window.setTimeout(() => void retry().catch(() => undefined), delayMs);
      return () => window.clearTimeout(timer);
    });
  }

  schedule(projectId: CollabProjectId): void {
    if (this.closed) return;
    void this.run(projectId).catch(() => undefined);
  }

  run(projectId: CollabProjectId): Promise<RetirementAcknowledgementRunResult> {
    if (this.closed) return Promise.resolve('cancelled');
    const existing = this.active.get(projectId);
    if (existing) return existing;
    const pending = this.runAdmitted(projectId);
    this.active.set(projectId, pending);
    const clear = () => {
      if (this.active.get(projectId) === pending) this.active.delete(projectId);
    };
    void pending.then(clear, clear);
    return pending;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    for (const cancel of this.retryCancellations.values()) cancel();
    this.retryCancellations.clear();
    this.retryScheduled.clear();
    this.retryAttempts.clear();
    await Promise.allSettled(this.active.values());
  }

  private async runUnlocked(
    projectId: CollabProjectId,
  ): Promise<RetirementAcknowledgementRunResult> {
    if (this.closed || this.controller.signal.aborted) return 'cancelled';
    const record = await this.store.loadRetirementRecord(projectId);
    if (this.closed || this.controller.signal.aborted) return 'cancelled';
    if (!record) {
      this.clearRetry(projectId);
      return 'missing';
    }
    if (record.acknowledgementStatus === 'acknowledged') {
      await this.store.removeRetirementAcknowledgement(projectId);
      this.clearRetry(projectId);
      return 'acknowledged';
    }
    if (
      record.acknowledgementStatus === 'expired'
      || this.now().getTime() >= Date.parse(record.retiredAt) + 30 * 24 * 60 * 60 * 1_000
    ) {
      if (record.acknowledgementStatus !== 'expired') {
        await this.store.updateRetirementRecord(projectId, current => ({
          ...current,
          acknowledgementStatus: 'expired',
          cloudDevelopmentActorId: null,
          cloudRetirementId: null,
          cloudServerUrl: null,
          hostCaCertificatePem: null,
          hostCaFingerprint: null,
          hostEndpoint: null,
          memberCredential: null,
          updatedAt: maxTimestamp(this.now().toISOString(), current.updatedAt),
        }));
      }
      await this.store.removeRetirementAcknowledgement(projectId);
      this.clearRetry(projectId);
      return 'expired';
    }
    const {
      cloudDevelopmentActorId,
      cloudRetirementId,
      cloudServerUrl,
      hostCaCertificatePem,
      hostCaFingerprint,
      hostEndpoint,
      memberCredential,
    } = record;
    const cloudAcknowledgement = cloudDevelopmentActorId
      && cloudRetirementId
      && cloudServerUrl;
    const lanAcknowledgement = hostCaCertificatePem
      && hostCaFingerprint
      && hostEndpoint
      && memberCredential;
    if (!cloudAcknowledgement && !lanAcknowledgement) {
      throw new CollabError({
        code: 'authority-integrity-error',
        safeContext: { reason: 'retirement-acknowledgement-material-missing' },
      });
    }
    let response: AcknowledgeRetirementResponse | CollabProjectRetirementAcknowledgement;
    try {
      response = cloudAcknowledgement
        ? await this.client.acknowledgeCloud({
            developmentActorId: cloudDevelopmentActorId,
            projectId,
            retirementId: cloudRetirementId,
            serverUrl: cloudServerUrl,
            signal: this.controller.signal,
          })
        : await this.client.acknowledge({
            hostCaCertificatePem: hostCaCertificatePem!,
            hostCaFingerprint: hostCaFingerprint!,
            hostEndpoint: hostEndpoint!,
            idempotencyKey: record.cleanupOperationId,
            memberCredential: memberCredential!,
            projectId,
            retiredAt: record.retiredAt,
            signal: this.controller.signal,
          });
    } catch (error) {
      if (error instanceof CollabError && RETRYABLE_CODES.has(error.code)) {
        this.requestRetry(projectId);
        return 'retry-pending';
      }
      throw error;
    }
    if (
      response.projectId !== projectId
      || ('retiredAt' in response
        ? response.retiredAt !== record.retiredAt
        : response.retirementId !== cloudRetirementId)
    ) {
      throw new CollabError({
        code: 'authority-integrity-error',
        safeContext: { reason: 'retirement-acknowledgement-result-mismatch' },
      });
    }
    await this.store.updateRetirementRecord(projectId, current => ({
      ...current,
      acknowledgedAt: response.acknowledgedAt,
      acknowledgementStatus: 'acknowledged',
      cloudDevelopmentActorId: null,
      cloudRetirementId: null,
      cloudServerUrl: null,
      hostCaCertificatePem: null,
      hostCaFingerprint: null,
      hostEndpoint: null,
      memberCredential: null,
      updatedAt: maxTimestamp(
        maxTimestamp(this.now().toISOString(), response.acknowledgedAt),
        current.updatedAt,
      ),
    }));
    await this.store.removeRetirementAcknowledgement(projectId);
    this.clearRetry(projectId);
    return 'acknowledged';
  }

  private async runAdmitted(
    projectId: CollabProjectId,
  ): Promise<RetirementAcknowledgementRunResult> {
    let result: RetirementAcknowledgementRunResult | null = null;
    await this.projectRecoveryAdmission(projectId, async () => {
      result = await this.runUnlocked(projectId);
    });
    if (result !== null) return result;
    throw new CollabError({
      code: 'durable-progress-recovery-required',
      recoveryActions: ['resume'],
      safeContext: { reason: 'retirement-acknowledgement-admission-incomplete' },
    });
  }

  private requestRetry(projectId: CollabProjectId): void {
    if (this.closed || this.retryScheduled.has(projectId)) return;
    this.retryScheduled.add(projectId);
    const attempt = (this.retryAttempts.get(projectId) ?? 0) + 1;
    this.retryAttempts.set(projectId, attempt);
    const delayMs = Math.min(1_000 * (2 ** (attempt - 1)), 30_000);
    const cancellation = this.scheduleRetry(projectId, async () => {
      this.retryCancellations.delete(projectId);
      this.retryScheduled.delete(projectId);
      if (this.closed) return;
      await this.run(projectId).then(() => undefined);
    }, delayMs);
    if (cancellation) this.retryCancellations.set(projectId, cancellation);
  }

  private clearRetry(projectId: CollabProjectId): void {
    this.retryCancellations.get(projectId)?.();
    this.retryCancellations.delete(projectId);
    this.retryScheduled.delete(projectId);
    this.retryAttempts.delete(projectId);
  }
}

function maxTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}
