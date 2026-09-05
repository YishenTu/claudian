import { randomUUID } from 'node:crypto';

import type {
  CollabAuthorityTransferStatus,
  CollabProjectId,
} from '@claudian-collab/protocol';
import { COLLAB_AUTHORITY_TRANSFER_CANCELLABLE_PHASES } from '@claudian-collab/protocol';

import type {
  AuthorityTransferModule,
  LanToCloudSourceProposalView,
} from '@/app/collab/authority-transfer/AuthorityTransferModule';
import {
  authorityTransferChildIdempotencyKey,
} from '@/app/collab/authority-transfer/AuthorityTransferOperationIdentity';
import {
  type CollabLocalMembershipRecord,
  isCollabLocalLanMembership,
} from '@/app/collab/CollabLocalProjectRepository';
import {
  LanAuthorityTransferClient,
  type LanAuthorityTransferTrustedHost,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferClient';
import type { CloudMembershipClaimInvitation } from '@/app/collab/project/CloudProjectInvitation';
import type {
  CloudAuthorityConnection,
  CloudAuthorityConnectionInput,
} from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { validateCloudServerUrl } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import type {
  CollabBeginCloudToLanTransferRequest,
  CollabCloudToLanTargetPreparationDescriptor,
  CollabCloudToLanTransferHandle,
  CollabCloudToLanTransferView,
  CollabLanToCloudTransferRequest,
  CollabLanToCloudTransferSelectionRequest,
  CollabLanToCloudTransferView,
  CollabOperationOptions,
  CollabPrepareCloudToLanTargetRequest,
  CollabWithdrawCloudToLanTargetRequest,
} from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

interface RetainedLanToCloudSource {
  readonly connection: CloudAuthorityConnection;
  readonly targetUrl: string;
  readonly transferId: string;
}

interface PendingLanToCloudAcceptance {
  readonly promise: Promise<CollabAuthorityTransferStatus>;
  readonly transferId: string;
}

export interface AuthorityTransferEntryServiceOptions {
  readonly connectCloud: (
    input: CloudAuthorityConnectionInput & { readonly allowCredentialCreation: boolean },
    options?: CollabOperationOptions,
  ) => Promise<CloudAuthorityConnection>;
  readonly createIdempotencyKey?: () => string;
  readonly createLanClient?: (
    trust: LanAuthorityTransferTrustedHost,
  ) => LanAuthorityTransferClient;
  readonly loadMembership: (
    projectId: CollabProjectId,
  ) => Promise<CollabLocalMembershipRecord | null>;
  readonly module: AuthorityTransferModule;
}

function entryError(reason: string): CollabError {
  return new CollabError({
    code: 'operation-failed',
    recoveryActions: ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
}

function isTerminal(status: CollabAuthorityTransferStatus): boolean {
  return status.state === 'cancelled' || status.state === 'completed';
}

export class AuthorityTransferEntryService {
  readonly #connectCloud: AuthorityTransferEntryServiceOptions['connectCloud'];
  readonly #createIdempotencyKey: () => string;
  readonly #createLanClient: NonNullable<AuthorityTransferEntryServiceOptions['createLanClient']>;
  readonly #loadMembership: AuthorityTransferEntryServiceOptions['loadMembership'];
  readonly #module: AuthorityTransferModule;
  readonly #sharedAcceptController = new AbortController();
  readonly #pendingAccepts = new Map<CollabProjectId, PendingLanToCloudAcceptance>();
  readonly #pendingSources = new Map<
    CollabProjectId,
    Promise<RetainedLanToCloudSource>
  >();
  readonly #retainedSources = new Map<CollabProjectId, RetainedLanToCloudSource>();
  #closed = false;

  constructor(options: AuthorityTransferEntryServiceOptions) {
    this.#connectCloud = options.connectCloud;
    this.#createIdempotencyKey = options.createIdempotencyKey
      ?? (() => `lan-to-cloud-${randomUUID().replaceAll('-', '')}`);
    this.#createLanClient = options.createLanClient
      ?? (trust => new LanAuthorityTransferClient(trust));
    this.#loadMembership = options.loadMembership;
    this.#module = options.module;
  }

  async proposeLanToCloudTransfer(
    request: CollabLanToCloudTransferRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus> {
    throwIfCancelled(options.signal);
    const serverUrl = validateCloudServerUrl(request.serverUrl, 'serverUrl');
    const membership = await this.#requireLanMembership(request.projectId, false);
    throwIfCancelled(options.signal);
    const requester = this.#module.createLanToCloudRequester({
      lanClient: this.#createLanClient({
        caCertificatePem: membership.authority.hostCaCertificatePem!,
        caFingerprint: membership.authority.hostCaFingerprint!,
        endpoint: membership.authority.endpoint!,
        projectId: request.projectId,
      }),
      memberCredential: membership.member.credential,
      memberId: membership.member.id,
      projectId: request.projectId,
    });
    const existing = await requester.resumeMatching({
      expectedAuthorityGeneration: membership.authority.authorityGeneration,
      projectId: request.projectId,
      targetUrl: serverUrl,
    }, options);
    if (existing) return existing;
    return requester.propose({
      expectedAuthorityGeneration: membership.authority.authorityGeneration,
      idempotencyKey: this.#createIdempotencyKey(),
      projectId: request.projectId,
      targetUrl: serverUrl,
    }, options);
  }

  async readLanToCloudTransfer(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabLanToCloudTransferView | null> {
    throwIfCancelled(options.signal);
    const [proposal, membership] = await Promise.all([
      this.#module.readLanToCloudTransfer(projectId),
      this.#loadMembership(projectId),
    ]);
    throwIfCancelled(options.signal);
    if (!proposal) return null;
    return Object.freeze({
      proposedByMemberId: proposal.proposedByMemberId,
      serverUrl: proposal.request.targetUrl,
      sourceOwned: proposal.entryRole === 'source'
        && membership !== null
        && isCollabLocalLanMembership(membership)
        && membership.project.id === projectId
        && membership.hostOwnership.ownsAuthority,
      status: proposal.status,
    });
  }

  readCloudToLanTransfer(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<CollabCloudToLanTransferView | null> {
    throwIfCancelled(options.signal);
    return this.#module.readCloudToLanTransfer(projectId);
  }

  async acceptLanToCloudTransfer(
    request: CollabLanToCloudTransferSelectionRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus> {
    if (this.#closed) throw entryError('authority-transfer-entry-service-closed');
    throwIfCancelled(options.signal);
    const pending = this.#pendingAccepts.get(request.projectId);
    if (pending) {
      if (pending.transferId !== request.transferId) {
        throw entryError('authority-transfer-source-proposal-stale');
      }
      return this.#waitForSharedAcceptance(pending.promise, options.signal);
    }
    const promise = this.#acceptLanToCloudTransfer(request, {
      signal: this.#sharedAcceptController.signal,
    });
    const acceptance = { promise, transferId: request.transferId };
    this.#pendingAccepts.set(request.projectId, acceptance);
    const clear = () => {
      if (this.#pendingAccepts.get(request.projectId) === acceptance) {
        this.#pendingAccepts.delete(request.projectId);
      }
    };
    void promise.then(clear, clear);
    return this.#waitForSharedAcceptance(promise, options.signal);
  }

  async #acceptLanToCloudTransfer(
    request: CollabLanToCloudTransferSelectionRequest,
    options: CollabOperationOptions,
  ): Promise<CollabAuthorityTransferStatus> {
    throwIfCancelled(options.signal);
    const [membership, proposal] = await Promise.all([
      this.#requireLanMembership(request.projectId, true),
      this.#requireProposal(request.projectId),
    ]);
    throwIfCancelled(options.signal);
    if (proposal.status.transferId !== request.transferId) {
      throw entryError('authority-transfer-source-proposal-stale');
    }
    const generation = membership.authority.authorityGeneration;
    if (generation !== proposal.request.expectedAuthorityGeneration) {
      throw entryError('authority-transfer-source-generation-stale');
    }
    await this.#module.assertLanToCloudSourceInstallationOwner(
      request.projectId,
      proposal.request.expectedAuthorityGeneration,
    );
    throwIfCancelled(options.signal);
    const runtime = await this.#requireSourceRuntime(proposal, options);
    const result = await this.#module.acceptLanToCloudTransferTarget({
      expectedAuthorityGeneration: proposal.request.expectedAuthorityGeneration,
      idempotencyKey: authorityTransferChildIdempotencyKey(
        proposal.request.idempotencyKey,
        'accept',
      ),
      projectId: request.projectId,
      targetUrl: proposal.request.targetUrl,
      transferId: proposal.status.transferId,
    }, {
      cloudSession: runtime.connection,
      expectedSourceEndpoint: membership.authority.endpoint!,
      expectedTargetUrl: proposal.request.targetUrl,
      projectId: request.projectId,
    }, options);
    if (isTerminal(result)) await this.#releaseSource(request.projectId, runtime);
    return result;
  }

  async cancelLanToCloudTransfer(
    request: CollabLanToCloudTransferSelectionRequest,
    options: CollabOperationOptions = {},
  ): Promise<CollabAuthorityTransferStatus> {
    throwIfCancelled(options.signal);
    const [membership, proposal] = await Promise.all([
      this.#requireLanMembership(request.projectId, true),
      this.#requireProposal(request.projectId),
    ]);
    if (proposal.status.transferId !== request.transferId) {
      throw entryError('authority-transfer-source-proposal-stale');
    }
    const generation = membership.authority.authorityGeneration;
    if (generation !== proposal.request.expectedAuthorityGeneration) {
      throw entryError('authority-transfer-source-generation-stale');
    }
    if (!COLLAB_AUTHORITY_TRANSFER_CANCELLABLE_PHASES.includes(
      proposal.status.phase as never,
    )) throw entryError('authority-transfer-phase-not-cancellable');
    const result = await this.#module.cancelLanToCloudTransfer({
      expectedAuthorityGeneration: generation,
      expectedPhase: proposal.status.phase as (
        typeof COLLAB_AUTHORITY_TRANSFER_CANCELLABLE_PHASES
      )[number],
      idempotencyKey: authorityTransferChildIdempotencyKey(
        proposal.request.idempotencyKey,
        'cancel',
      ),
      projectId: request.projectId,
      transferId: proposal.status.transferId,
    });
    if (isTerminal(result)) await this.#releaseSource(request.projectId);
    return result;
  }

  prepareCloudToLanTarget(
    input: CollabPrepareCloudToLanTargetRequest & Readonly<{ readonly operationIntentId: string }>,
    options?: CollabOperationOptions,
  ): Promise<CollabCloudToLanTargetPreparationDescriptor> {
    return this.#module.prepareCloudToLanTarget(input, options);
  }

  beginCloudToLanTransfer(
    input: CollabBeginCloudToLanTransferRequest & Readonly<{ readonly operationIntentId: string }>,
    options?: CollabOperationOptions,
  ): Promise<CollabCloudToLanTransferHandle> {
    return this.#module.beginCloudToLanTransfer(input, options);
  }

  acceptCloudToLanTransfer(
    input: Readonly<{ readonly handle: CollabCloudToLanTransferHandle }>,
    options?: CollabOperationOptions,
  ): Promise<CollabAuthorityTransferStatus> {
    return this.#module.acceptCloudToLanTransfer(input, options);
  }

  withdrawCloudToLanTarget(
    input: CollabWithdrawCloudToLanTargetRequest,
    options?: CollabOperationOptions,
  ): Promise<void> {
    return this.#module.withdrawCloudToLanTarget(input, options);
  }

  observeCloudToLanTransfer(
    projectId: CollabProjectId,
    options?: CollabOperationOptions,
  ): Promise<CollabAuthorityTransferStatus> {
    return this.#module.observeCloudToLanTransfer(projectId, options);
  }

  cancelCloudToLanTransfer(
    handle: CollabCloudToLanTransferHandle,
    options?: CollabOperationOptions,
  ): Promise<CollabAuthorityTransferStatus> {
    return this.#module.cancelCloudToLanTransfer(handle, options);
  }

  redeemManagerReissuedClaim(
    invitation: CloudMembershipClaimInvitation,
    options?: CollabOperationOptions,
  ): Promise<void> {
    return this.#module.redeemManagerReissuedClaim(invitation, options);
  }

  beginClose(): void {
    this.#closed = true;
    this.#sharedAcceptController.abort();
  }

  async close(): Promise<void> {
    this.beginClose();
    await Promise.allSettled([...this.#pendingAccepts.values()].map(({ promise }) => promise));
    try {
      await this.#module.close();
    } finally {
      await Promise.allSettled(this.#pendingSources.values());
      const retained = [...this.#retainedSources.values()];
      this.#retainedSources.clear();
      for (const runtime of retained) runtime.connection.dispose();
    }
  }

  async #requireLanMembership(
    projectId: CollabProjectId,
    requireOwner: boolean,
  ) {
    const membership = await this.#loadMembership(projectId);
    if (
      !membership
      || !isCollabLocalLanMembership(membership)
      || membership.project.id !== projectId
      || !membership.authority.endpoint
      || !membership.authority.gitRemoteUrl
      || !membership.authority.hostCaCertificatePem
      || !membership.authority.hostCaFingerprint
      || (requireOwner && !membership.hostOwnership.ownsAuthority)
    ) throw entryError('authority-transfer-lan-membership-unavailable');
    return membership;
  }

  async #requireProposal(projectId: CollabProjectId): Promise<LanToCloudSourceProposalView> {
    const proposal = await this.#module.readLanToCloudSourceProposal(projectId);
    if (!proposal) throw entryError('authority-transfer-source-proposal-missing');
    return proposal;
  }

  async #requireSourceRuntime(
    proposal: LanToCloudSourceProposalView,
    options: CollabOperationOptions,
  ): Promise<RetainedLanToCloudSource> {
    if (this.#closed) throw entryError('authority-transfer-entry-service-closed');
    const retained = this.#retainedSources.get(proposal.request.projectId);
    if (retained) return this.#validateSourceRuntime(proposal, retained);
    const pending = this.#pendingSources.get(proposal.request.projectId);
    if (pending) {
      return this.#validateSourceRuntime(proposal, await pending);
    }
    const creation = this.#createSourceRuntime(proposal, options);
    this.#pendingSources.set(proposal.request.projectId, creation);
    try {
      return await creation;
    } finally {
      if (this.#pendingSources.get(proposal.request.projectId) === creation) {
        this.#pendingSources.delete(proposal.request.projectId);
      }
    }
  }

  async #createSourceRuntime(
    proposal: LanToCloudSourceProposalView,
    options: CollabOperationOptions,
  ): Promise<RetainedLanToCloudSource> {
    const connection = await this.#connectCloud({
      allowCredentialCreation: proposal.beginSubmission !== 'possibly-sent',
      projectId: proposal.request.projectId,
      serverUrl: proposal.request.targetUrl,
    }, options);
    if (
      this.#closed
      || connection.projectId !== proposal.request.projectId
      || connection.serverUrl !== proposal.request.targetUrl
      || !connection.supports('authority-transfer')
    ) {
      connection.dispose();
      throw entryError(this.#closed
        ? 'authority-transfer-entry-service-closed'
        : 'authority-transfer-cloud-capability-unavailable');
    }
    const runtime = {
      connection,
      targetUrl: proposal.request.targetUrl,
      transferId: proposal.status.transferId,
    };
    this.#retainedSources.set(proposal.request.projectId, runtime);
    return runtime;
  }

  #validateSourceRuntime(
    proposal: LanToCloudSourceProposalView,
    runtime: RetainedLanToCloudSource,
  ): RetainedLanToCloudSource {
    if (
      runtime.targetUrl !== proposal.request.targetUrl
      || runtime.transferId !== proposal.status.transferId
    ) throw entryError('authority-transfer-source-runtime-stale');
    return runtime;
  }

  #waitForAcceptance(
    promise: Promise<CollabAuthorityTransferStatus>,
    signal?: AbortSignal,
    abortError = new CollabError({ code: 'cancelled' }),
  ): Promise<CollabAuthorityTransferStatus> {
    if (!signal) return promise;
    throwIfCancelled(signal);
    return new Promise<CollabAuthorityTransferStatus>((resolve, reject) => {
      const onAbort = () => reject(abortError);
      signal.addEventListener('abort', onAbort, { once: true });
      void promise.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    });
  }

  #waitForSharedAcceptance(
    promise: Promise<CollabAuthorityTransferStatus>,
    callerSignal?: AbortSignal,
  ): Promise<CollabAuthorityTransferStatus> {
    return this.#waitForAcceptance(
      this.#waitForAcceptance(
        promise,
        this.#sharedAcceptController.signal,
        entryError('authority-transfer-entry-service-closed'),
      ),
      callerSignal,
    );
  }

  async #releaseSource(
    projectId: CollabProjectId,
    expected?: RetainedLanToCloudSource,
  ): Promise<void> {
    const retained = this.#retainedSources.get(projectId);
    if (!retained || (expected && retained !== expected)) return;
    this.#retainedSources.delete(projectId);
    retained.connection.dispose();
  }
}
