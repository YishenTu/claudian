import { createHash, randomUUID } from 'node:crypto';

import type {
  CollabMemberId,
  CollabProjectId,
  CollabProjectMembershipOperationMap,
  CollabProjectRetirementAcknowledgement,
  CollabProjectRetirementOperationMap,
} from '@claudian-collab/protocol';

import type {
  CollabLocalCloudMembershipRecord,
} from '@/app/collab/CollabLocalProjectRepository';
import type {
  CloudAuthorityConnection,
  CloudAuthorityConnectionInput,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { CloudAuthorityRejection } from '@/app/collab/remote-authority/CloudAuthorityError';
import {
  type CloudRetirementIntent,
  decodeCloudRetirementIntent,
} from '@/app/collab/retirement/CloudRetirementIntent';
import type { RetirementDeliverySource } from '@/app/collab/retirement/RetirementClientHandler';
import type {
  CollabCloudProjectSnapshot,
  CollabOperationOptions,
  CollabRetirementResult,
  CollabRetireProjectRequest,
} from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CloudRetirementAuthorityClientPort {
  dispose(): void;
  listProjectMembers(
    request: CollabProjectMembershipOperationMap['listProjectMembers']['request'],
    options?: { readonly signal?: AbortSignal },
  ): Promise<CollabProjectMembershipOperationMap['listProjectMembers']['response']>;
  readSnapshot(
    projectId: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CollabCloudProjectSnapshot>;
  retireProject(
    request: CollabProjectRetirementOperationMap['retireProject']['request'],
    options?: { readonly signal?: AbortSignal },
  ): Promise<CollabProjectRetirementOperationMap['retireProject']['response']>;
}

export interface CloudRetirementIntentStore {
  listProjectIds(): Promise<readonly CollabProjectId[]>;
  load(projectId: CollabProjectId): Promise<CloudRetirementIntent | null>;
  loadRetirementRecord(projectId: CollabProjectId): Promise<{ readonly projectId: CollabProjectId } | null>;
  remove(projectId: CollabProjectId): Promise<boolean>;
  save(intent: CloudRetirementIntent): Promise<void>;
}

export interface CloudRetirementActivityPort {
  complete(projectId: CollabProjectId): Promise<void>;
  resume(projectId: CollabProjectId): Promise<void>;
  suspend(projectId: CollabProjectId): Promise<void>;
}

export interface CloudRetirementClientOptions {
  readonly activity: CloudRetirementActivityPort;
  readonly connect: (
    binding: CloudAuthorityConnectionInput,
  ) => Promise<CloudAuthorityConnection>;
  readonly connectRetirement: (
    binding: {
      readonly authorityGeneration: number;
      readonly memberId: CollabMemberId;
      readonly personalRef: string;
      readonly projectId: CollabProjectId;
      readonly serverUrl: string;
    },
    options?: CollabOperationOptions,
  ) => Promise<CloudRetirementAuthorityClientPort>;
  readonly createIdempotencyKey?: () => string;
  readonly intents: CloudRetirementIntentStore;
  readonly now?: () => Date;
  readonly terminal: {
    handle(result: CollabRetirementResult, source: RetirementDeliverySource): Promise<void>;
    resume(projectId: CollabProjectId): Promise<void>;
  };
}

export interface CloudRetirementAcknowledgementTarget extends CloudAuthorityConnectionInput {
  readonly retirementId: string;
}

function retirementError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

/** Owns the durable Cloud Retire request until the terminal handler accepts it. */
export class CloudRetirementClient {
  readonly #createIdempotencyKey: () => string;
  readonly #now: () => Date;

  constructor(private readonly options: CloudRetirementClientOptions) {
    this.#createIdempotencyKey = options.createIdempotencyKey
      ?? (() => `retire-${randomUUID().replaceAll('-', '')}`);
    this.#now = options.now ?? (() => new Date());
  }

  async retire(
    membership: CollabLocalCloudMembershipRecord,
    request: CollabRetireProjectRequest,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    if (membership.project.id !== request.projectId) {
      throw retirementError('cloud-retirement-manager-membership-mismatch');
    }
    const existing = await this.options.intents.load(request.projectId);
    if (existing && existing.phase !== 'rejected') {
      await this.#settle(existing, options, 'response');
      return;
    }
    if (membership.member.role !== 'manager') {
      throw retirementError('cloud-retirement-manager-membership-mismatch');
    }
    const idempotencyKey = this.#createIdempotencyKey();
    if (idempotencyKey === existing?.request.idempotencyKey) {
      throw retirementError('cloud-retirement-idempotency-key-reused');
    }
    if (existing) await this.options.intents.remove(request.projectId);
    const intent = await this.#prepare(membership, idempotencyKey, options);
    await this.#settle(intent, options, 'response');
  }

  async resume(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<void> {
    const intent = await this.options.intents.load(projectId);
    if (!intent) throw new CollabError({ code: 'project-not-found' });
    if (intent.phase === 'rejected') {
      await this.options.activity.resume(projectId);
      return;
    }
    await this.#settle(intent, options, 'terminal-fallback');
  }

  async acknowledge(
    target: CloudRetirementAcknowledgementTarget,
    options: CollabOperationOptions = {},
  ): Promise<CollabProjectRetirementAcknowledgement> {
    const session = await this.options.connect(target);
    try {
      if (!session.supports('project-retirement')) {
        throw retirementError('cloud-retirement-capability-unavailable');
      }
      return await session.lifecycle.retirement('acknowledgeProjectRetirement', {
        idempotencyKey: this.#acknowledgementIdempotencyKey(target.retirementId),
        projectId: target.projectId,
        retirementId: target.retirementId,
      }, options);
    } finally {
      session.dispose();
    }
  }

  async #prepare(
    membership: CollabLocalCloudMembershipRecord,
    idempotencyKey: string,
    options: CollabOperationOptions,
  ): Promise<CloudRetirementIntent> {
    const client = await this.#connect(membership, options);
    try {
      const requestOptions = options.signal ? { signal: options.signal } : {};
      const snapshot = await client.readSnapshot(membership.project.id, requestOptions);
      const members = await client.listProjectMembers(
        { projectId: membership.project.id },
        requestOptions,
      );
      const matching = members.projectId === membership.project.id
        ? members.members.filter(member => member.memberId === membership.member.id)
        : [];
      if (
        snapshot.project.id !== membership.project.id
        || snapshot.project.authorityGeneration !== membership.authority.authorityGeneration
        || snapshot.currentMember.id !== membership.member.id
        || snapshot.currentMember.personalRef !== membership.member.personalRef
        || snapshot.currentMember.role !== 'manager'
        || matching.length !== 1
        || matching[0]?.bindingState !== 'bound'
        || matching[0].role !== 'manager'
      ) throw retirementError('cloud-retirement-snapshot-mismatch');
      const timestamp = this.#now().toISOString();
      const intent = decodeCloudRetirementIntent({
        authorityGeneration: membership.authority.authorityGeneration,
        createdAt: timestamp,
        kind: 'cloud-retirement-intent',
        memberId: membership.member.id,
        personalRef: membership.member.personalRef,
        phase: 'prepared',
        projectId: membership.project.id,
        request: {
          expectedAuthorityGeneration: membership.authority.authorityGeneration,
          expectedMainOid: snapshot.project.mainOid,
          idempotencyKey,
          projectId: membership.project.id,
        },
        result: null,
        schemaVersion: 1,
        serverUrl: membership.authority.serverUrl,
        updatedAt: timestamp,
      });
      await this.options.intents.save(intent);
      return intent;
    } finally {
      client.dispose();
    }
  }

  async #settle(
    initial: CloudRetirementIntent,
    options: CollabOperationOptions,
    source: RetirementDeliverySource,
  ): Promise<void> {
    await this.options.activity.suspend(initial.projectId);
    if (await this.options.intents.loadRetirementRecord(initial.projectId)) {
      await this.options.terminal.resume(initial.projectId);
      await this.options.intents.remove(initial.projectId);
      await this.options.activity.complete(initial.projectId);
      return;
    }
    let intent = initial;
    if (intent.phase === 'terminal-retained') {
      await this.#adoptTerminal(intent, source);
      return;
    }
    if (intent.phase === 'prepared') {
      intent = await this.#save(intent, { phase: 'submitted', result: null });
    }
    if (intent.phase !== 'submitted') {
      throw retirementError('cloud-retirement-intent-not-submittable');
    }
    try {
      const result = await this.#withClient(intent, options, client => client.retireProject(
        intent.request,
        options.signal ? { signal: options.signal } : {},
      ));
      if (result.projectId !== intent.projectId) {
        throw new CollabError({
          code: 'authority-integrity-error',
          safeContext: { reason: 'cloud-retirement-result-mismatch' },
        });
      }
      intent = await this.#save(intent, { phase: 'terminal-retained', result });
      if (intent.phase !== 'terminal-retained') throw new TypeError('Expected terminal intent');
      await this.#adoptTerminal(intent, source);
    } catch (error) {
      if (intent.phase !== 'submitted') throw error;
      const terminal = this.#terminalResultFromError(intent.projectId, error);
      if (terminal) {
        await this.options.terminal.handle(terminal, 'terminal-fallback');
        await this.options.intents.remove(intent.projectId);
        await this.options.activity.complete(intent.projectId);
        return;
      }
      if (!(error instanceof CloudAuthorityRejection)) throw error;
      await this.#recoverRejected(intent, options);
      await this.#save(intent, { phase: 'rejected', result: null });
      await this.options.activity.resume(intent.projectId);
      throw error;
    }
  }

  async #recoverRejected(
    intent: CloudRetirementIntent,
    options: CollabOperationOptions,
  ): Promise<void> {
    await this.#withClient(intent, options, async client => {
      const requestOptions = options.signal ? { signal: options.signal } : {};
      const snapshot = await client.readSnapshot(intent.projectId, requestOptions);
      const members = await client.listProjectMembers(
        { projectId: intent.projectId },
        requestOptions,
      );
      const matching = members.projectId === intent.projectId
        ? members.members.filter(member => member.memberId === intent.memberId)
        : [];
      if (
        snapshot.project.id !== intent.projectId
        || snapshot.project.authorityGeneration !== intent.authorityGeneration
        || snapshot.currentMember.id !== intent.memberId
        || snapshot.currentMember.personalRef !== intent.personalRef
        || matching.length !== 1
        || matching[0]?.bindingState !== 'bound'
        || matching[0].role !== snapshot.currentMember.role
      ) throw new CollabError({
        code: 'authority-integrity-error',
        safeContext: { reason: 'cloud-retirement-rejection-barrier-mismatch' },
      });
    });
  }

  async #adoptTerminal(
    intent: Extract<CloudRetirementIntent, { readonly phase: 'terminal-retained' }>,
    source: RetirementDeliverySource,
  ): Promise<void> {
    await this.options.terminal.handle({
      projectId: intent.result.projectId,
      retiredAt: intent.result.retiredAt,
      retirementId: intent.result.retirementId,
    }, source);
    await this.options.intents.remove(intent.projectId);
    await this.options.activity.complete(intent.projectId);
  }

  async #save(
    intent: CloudRetirementIntent,
    patch: {
      readonly phase: 'submitted' | 'rejected';
      readonly result: null;
    } | {
      readonly phase: 'terminal-retained';
      readonly result: CollabProjectRetirementOperationMap['retireProject']['response'];
    },
  ): Promise<CloudRetirementIntent> {
    const updated = decodeCloudRetirementIntent({
      ...intent,
      ...patch,
      updatedAt: this.#now().toISOString(),
    });
    await this.options.intents.save(updated);
    return updated;
  }

  #connect(
    membership: CollabLocalCloudMembershipRecord,
    options: CollabOperationOptions,
  ): Promise<CloudRetirementAuthorityClientPort> {
    return this.options.connectRetirement({
      authorityGeneration: membership.authority.authorityGeneration,
      memberId: membership.member.id,
      personalRef: membership.member.personalRef,
      projectId: membership.project.id,
      serverUrl: membership.authority.serverUrl,
    }, options);
  }

  async #withClient<T>(
    intent: CloudRetirementIntent,
    options: CollabOperationOptions,
    operation: (client: CloudRetirementAuthorityClientPort) => Promise<T>,
  ): Promise<T> {
    const client = await this.options.connectRetirement({
      authorityGeneration: intent.authorityGeneration,
      memberId: intent.memberId,
      personalRef: intent.personalRef,
      projectId: intent.projectId,
      serverUrl: intent.serverUrl,
    }, options);
    try {
      return await operation(client);
    } finally {
      client.dispose();
    }
  }

  #terminalResultFromError(
    projectId: CollabProjectId,
    error: unknown,
  ): CollabRetirementResult | null {
    if (!(error instanceof CollabError) || error.code !== 'project-retired') return null;
    const retiredAt = error.safeContext.retiredAt;
    const contextProjectId = error.safeContext.projectId;
    const retirementId = error.safeContext.operationId;
    if (
      contextProjectId !== projectId
      || typeof retiredAt !== 'string'
      || !Number.isFinite(Date.parse(retiredAt))
      || new Date(retiredAt).toISOString() !== retiredAt
      || typeof retirementId !== 'string'
    ) throw new CollabError({
      code: 'authority-integrity-error',
      safeContext: { reason: 'cloud-retirement-terminal-result-invalid' },
    });
    return { projectId, retiredAt, retirementId };
  }

  #acknowledgementIdempotencyKey(retirementId: string): string {
    return `retire-ack-${createHash('sha256')
      .update(retirementId, 'utf8')
      .digest('hex')
      .slice(0, 32)}`;
  }
}
