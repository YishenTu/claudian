import { createHash } from 'node:crypto';
import path from 'node:path';

import { COLLAB_MAIN_REF, collabMemberRef, type CollabProjectId } from '@claudian/collab-protocol';

import { AcceptCoordinator } from '@/app/collab/accept/AcceptCoordinator';
import { AcceptGitRepository } from '@/app/collab/accept/AcceptGitRepository';
import { AuthorityEventRepository } from '@/app/collab/authority/AuthorityEventRepository';
import { AuthorityIdempotencyRepository } from '@/app/collab/authority/AuthorityIdempotencyRepository';
import { HostTransferAuthorityService } from '@/app/collab/authority/HostTransferAuthorityService';
import { ManagerResponsibilityService } from '@/app/collab/authority/ManagerResponsibilityService';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import {
  ProjectRetirementAuthorityService,
} from '@/app/collab/authority/ProjectRetirementAuthorityService';
import { RequestCommentService } from '@/app/collab/authority/RequestCommentService';
import {
  createRequestEnsureGitPolicy,
} from '@/app/collab/authority/RequestEnsureGitPolicy';
import { RequestEnsureService } from '@/app/collab/authority/RequestEnsureService';
import { RequestQueryGitPolicy } from '@/app/collab/authority/RequestQueryGitPolicy';
import { RequestQueryService } from '@/app/collab/authority/RequestQueryService';
import { SqlJsProjectDatabase } from '@/app/collab/authority/SqlJsProjectDatabase';
import { TicketService } from '@/app/collab/authority/TicketService';
import { CloudBootstrapTransitionStore } from '@/app/collab/bootstrap/CloudBootstrapTransitionStore';
import {
  type CollabFilesystemDiagnosticSink,
} from '@/app/collab/CollabFilesystemBoundary';
import { CollabLocalProjectRepository } from '@/app/collab/CollabLocalProjectRepository';
import { CollabPathPolicy } from '@/app/collab/CollabPathPolicy';
import { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import {
  CollabLanDiscoveryService,
} from '@/app/collab/discovery/CollabLanDiscoveryService';
import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import {
  type GitRuntime,
  type GitRuntimeResolution,
  type GitRuntimeResolveInput,
  GitRuntimeResolver,
} from '@/app/collab/git/GitRuntimeResolver';
import type { CollabHostTransferService } from '@/app/collab/host-transfer/CollabHostTransferService';
import {
  HostTransferModule,
  type HostTransferModuleOptions,
} from '@/app/collab/host-transfer/HostTransferModule';
import { HostTrustTransitionService } from '@/app/collab/host-transfer/HostTrustTransitionService';
import { HostTransitionCandidateResolver } from '@/app/collab/HostTransitionCandidateResolver';
import { JoinProjectCoordinator } from '@/app/collab/join/JoinProjectCoordinator';
import {
  COLLAB_CONTROL_OPERATION_BINDINGS,
  collabControlOperationPath,
} from '@/app/collab/lan/CollabControlOperationBindings';
import {
  type CollabTrustedHost,
  PinnedCollabHttpClient,
} from '@/app/collab/lan/CollabHttpClient';
import type {
  HostedLifecycleControlPort,
} from '@/app/collab/lan/HostedProjectControlService';
import type { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { lanCollabControlOperationCodec } from '@/app/collab/lan/LanCollabControlOperationCodecs';
import type { AcknowledgeRetirementResponse } from '@/app/collab/lan/LanCollabControlOperations';
import {
  LanHostCoordinator,
  type LanHostCoordinatorOptions,
  type LanHostProjectRuntime,
} from '@/app/collab/lan/LanHostCoordinator';
import {
  ProjectEventHub,
  SqlJsProjectEventSource,
} from '@/app/collab/lan/ProjectEventHub';
import type {
  CollabTerminalProjectService,
} from '@/app/collab/lan/routes/RouteTypes';
import { LanHostTransitionProofClient } from '@/app/collab/reconnect/LanHostTransitionProofClient';
import { ReconnectProjectCoordinator } from '@/app/collab/reconnect/ReconnectProjectCoordinator';
import { ProjectRetirementCoordinator } from '@/app/collab/retirement/ProjectRetirementCoordinator';
import { createRetirementIntent } from '@/app/collab/retirement/RetirementIntent';
import {
  RetirementResponderExpiryScheduler,
} from '@/app/collab/retirement/RetirementResponderExpiryScheduler';
import {
  type RetirementAcknowledgementInput,
  RetirementTerminalClient,
} from '@/app/collab/retirement/RetirementTerminalClient';
import { RetirementTerminalService } from '@/app/collab/retirement/RetirementTerminalService';
import { RetirementTombstoneRepository } from '@/app/collab/retirement/RetirementTombstoneRepository';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import type { CollabRetirementResult, CollabRetireProjectRequest } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CollabLocalFoundation {
  readonly pathPolicy: CollabPathPolicy;
  readonly projects: CollabLocalProjectRepository;
  readonly workspace: CollabWorkspaceService;
}

export interface CollabGitFoundation {
  readonly repositories: GitRepositoryService;
  readonly runner: GitCommandRunner;
  readonly runtime: GitRuntime;
}

export interface CollabAuthorityFoundation {
  readonly authorityDirectory: string;
  readonly database: SqlJsProjectDatabase;
  readonly events: AuthorityEventRepository;
  readonly idempotency: AuthorityIdempotencyRepository;
  readonly projects: ProjectAuthorityRepository;
}

export interface CollabGitRuntimeResolver {
  resolve(input?: GitRuntimeResolveInput): Promise<GitRuntimeResolution>;
  rescan(input?: GitRuntimeResolveInput): Promise<GitRuntimeResolution>;
}

export interface ClaudianCollabServiceOptions {
  readonly createAuthorityDatabase?: (
    authorityDirectory: string,
  ) => SqlJsProjectDatabase;
  readonly getConfiguredGitPath: () => string;
  readonly getProjectsFolder?: () => string;
  readonly getEnvironment?: () => NodeJS.ProcessEnv;
  readonly gitRuntimeResolver?: CollabGitRuntimeResolver;
  readonly invitationCodec?: InvitationCodec;
  readonly lanHost?: Pick<
    LanHostCoordinatorOptions,
    | 'createAddressMonitor'
    | 'createInvitationCodec'
    | 'getPrivateIpv4Addresses'
    | 'portCandidates'
    | 'tlsIdentity'
  >;
  readonly obsidianConfigDirectory: string;
  readonly onDiagnostic?: CollabFilesystemDiagnosticSink;
  readonly vaultRoot: string;
}

interface RetirementCoordinatorFactoryInput {
  readonly admission: {
    quiesceAndDrain(projectId: CollabProjectId): Promise<void>;
    resume(projectId: CollabProjectId): Promise<void>;
  };
  activateTerminal(service: CollabTerminalProjectService): Promise<void>;
  deliver(result: CollabRetirementResult): Promise<void>;
  teardown(projectId: CollabProjectId): Promise<void>;
}

function collabServiceError(
  code:
    | 'git-capability-missing'
    | 'git-not-found'
    | 'git-version-unsupported'
    | 'not-initialized',
  reason: string,
  safeContext: Readonly<Record<string, unknown>> = {},
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'git-not-found'
      ? ['install-git', 'rescan-git', 'choose-git-path']
      : code === 'git-version-unsupported' || code === 'git-capability-missing'
        ? ['rescan-git', 'choose-git-path']
        : [],
    safeContext: { reason, ...safeContext },
  });
}

function environmentPath(environment: NodeJS.ProcessEnv): string | undefined {
  const entry = Object.entries(environment).find(
    ([key]) => key.toLocaleLowerCase('en-US') === 'path',
  );
  return entry?.[1];
}

export class ClaudianCollabService {
  readonly cloudBootstrapTransitions: CloudBootstrapTransitionStore;
  readonly discovery: CollabLanDiscoveryService;
  readonly hostTransitionCandidates: HostTransitionCandidateResolver;
  readonly join: JoinProjectCoordinator;
  readonly lanHost: LanHostCoordinator;
  readonly local: CollabLocalFoundation;
  readonly reconnect: ReconnectProjectCoordinator;
  private readonly authorityFoundations = new Map<
    CollabProjectId,
    Promise<CollabAuthorityFoundation>
  >();
  private closed = false;
  private readonly createAuthorityDatabase: (
    authorityDirectory: string,
  ) => SqlJsProjectDatabase;
  private readonly getEnvironment: () => NodeJS.ProcessEnv;
  private readonly gitRuntimeResolver: CollabGitRuntimeResolver;
  private hostTransferModule: HostTransferModule | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly retirementResponders = new Map<
    CollabProjectId,
    CollabTerminalProjectService
  >();
  private readonly retirementResponderExpiry = new RetirementResponderExpiryScheduler(
    projectId => this.cleanupRetirementResponder(projectId),
  );
  private readonly retirementResponderCleanupPending = new Set<CollabProjectId>();
  private readonly retiredAuthorityCleanupComplete = new Set<CollabProjectId>();
  private readonly retirementTombstones: RetirementTombstoneRepository;
  private readonly retirementTerminalClient: RetirementTerminalClient;
  private retirementHandler: {
    handle(
      result: CollabRetirementResult,
      source: 'response' | 'terminal-fallback',
    ): Promise<void>;
  } | null = null;

  constructor(private readonly options: ClaudianCollabServiceOptions) {
    const pathPolicy = new CollabPathPolicy({
      obsidianConfigDirectory: options.obsidianConfigDirectory,
    });
    const projects = new CollabLocalProjectRepository(options.vaultRoot, {
      onDiagnostic: options.onDiagnostic,
    });
    this.local = Object.freeze({
      pathPolicy,
      projects,
      workspace: new CollabWorkspaceService(options.vaultRoot, {
        obsidianConfigDirectory: options.obsidianConfigDirectory,
        onDiagnostic: options.onDiagnostic,
        pathPolicy,
      }),
    });
    this.getEnvironment = options.getEnvironment ?? (() => process.env);
    this.gitRuntimeResolver = options.gitRuntimeResolver ?? new GitRuntimeResolver({
      environment: this.getEnvironment(),
    });
    this.createAuthorityDatabase = options.createAuthorityDatabase
      ?? (authorityDirectory => new SqlJsProjectDatabase(authorityDirectory));
    this.retirementTombstones = new RetirementTombstoneRepository(projects);
    this.discovery = new CollabLanDiscoveryService({
      ...(options.invitationCodec ? { invitationCodec: options.invitationCodec } : {}),
    });
    const hostTransitionProofClient = new LanHostTransitionProofClient();
    const hostTrustTransitions = new HostTrustTransitionService();
    this.hostTransitionCandidates = new HostTransitionCandidateResolver({
      discovery: this.discovery,
      proofClient: hostTransitionProofClient,
      trustTransitions: hostTrustTransitions,
    });
    this.join = new JoinProjectCoordinator(this, {
      ...(options.invitationCodec ? { invitationCodec: options.invitationCodec } : {}),
      ...(options.getProjectsFolder ? { getProjectsFolder: options.getProjectsFolder } : {}),
      vaultRoot: options.vaultRoot,
    });
    this.reconnect = new ReconnectProjectCoordinator(this, {
      hostTransitionProofClient,
      hostTrustTransitionVerifier: hostTrustTransitions,
      ...(options.invitationCodec ? { invitationCodec: options.invitationCodec } : {}),
      vaultRoot: options.vaultRoot,
    });
    this.retirementTerminalClient = new RetirementTerminalClient({
      hostTransitionCandidates: this.hostTransitionCandidates,
      request: (trust, input) => this.sendRetirementAcknowledgement(trust, input),
    });
    this.cloudBootstrapTransitions = new CloudBootstrapTransitionStore(options.vaultRoot);
    this.lanHost = new LanHostCoordinator({
      ...options.lanHost,
      discovery: this.discovery,
      localProjects: projects,
      openProject: projectId => this.openLanHostProject(projectId),
      runWithProjectStartGuard: (projectId, operation) => (
        this.cloudBootstrapTransitions.runWithLanHostStartGuard(projectId, operation)
      ),
      vaultRoot: options.vaultRoot,
    });
  }

  resolveGitRuntime(rescan = false): Promise<GitRuntimeResolution> {
    this.assertOpen();
    const environment = this.getEnvironment();
    const input = {
      configuredPath: this.options.getConfiguredGitPath(),
      pathEnvironment: environmentPath(environment),
    };
    return rescan
      ? this.gitRuntimeResolver.rescan(input)
      : this.gitRuntimeResolver.resolve(input);
  }

  async requireGitFoundation(): Promise<CollabGitFoundation> {
    const resolution = await this.resolveGitRuntime();
    if (resolution.status === 'missing') {
      throw collabServiceError('git-not-found', resolution.reason);
    }
    if (resolution.status === 'incompatible') {
      if (resolution.missingCapabilities.length > 0) {
        throw collabServiceError(
          'git-capability-missing',
          'required-git-capability-missing',
          { missingCapabilities: resolution.missingCapabilities },
        );
      }
      throw collabServiceError(
        'git-version-unsupported',
        'git-version-too-old',
        {
          minimumVersion: resolution.minimumVersion,
          version: resolution.version,
        },
      );
    }

    const emptyConfigPath = await this.local.projects.ensureGitEmptyConfig();
    const runner = new GitCommandRunner({
      baseEnvironment: this.getEnvironment(),
      emptyConfigPath,
      executablePath: resolution.runtime.executablePath,
    });
    return {
      repositories: new GitRepositoryService(runner, this.local.pathPolicy),
      runner,
      runtime: resolution.runtime,
    };
  }

  async retireProject(
    request: CollabRetireProjectRequest,
    signal?: AbortSignal,
  ): Promise<CollabRetirementResult> {
    this.assertOpen();
    const { idempotencyKey } = createRetirementIntent(request);
    const membership = await this.requireTrustedMembership(request.projectId);
    const protocolRequest = {
      expectedHostMemberId: request.expectedHostMemberId,
      idempotencyKey,
      managerActorMemberId: request.managerActorMemberId,
      projectId: request.projectId,
    };
    try {
      const operation = 'retireProject' as const;
      return await new PinnedCollabHttpClient(membership.trust, 10_000).requestWithMember({
        body: protocolRequest,
        decode: lanCollabControlOperationCodec(operation).decodeResponse,
        idempotencyKey,
        method: COLLAB_CONTROL_OPERATION_BINDINGS[operation].method,
        path: collabControlOperationPath(operation, request.projectId),
      }, membership.credential, signal ? { signal } : {});
    } catch (error) {
      const replay = retirementResultFromError(request.projectId, error);
      if (replay) return replay;
      throw error;
    }
  }

  async acknowledgeRetirement(input: {
    readonly hostCaCertificatePem: string;
    readonly hostCaFingerprint: string;
    readonly hostEndpoint: string;
    readonly idempotencyKey: string;
    readonly memberCredential: string;
    readonly projectId: CollabProjectId;
    readonly retiredAt: string;
    readonly signal?: AbortSignal;
  }): Promise<AcknowledgeRetirementResponse> {
    this.assertOpen();
    return this.retirementTerminalClient.acknowledge(input);
  }

  private sendRetirementAcknowledgement(
    trust: CollabTrustedHost,
    input: RetirementAcknowledgementInput,
  ): Promise<AcknowledgeRetirementResponse> {
    const request = {
      idempotencyKey: input.idempotencyKey,
      projectId: input.projectId,
      retiredAt: input.retiredAt,
    };
    const operation = 'acknowledgeRetirement' as const;
    return new PinnedCollabHttpClient(trust, 10_000).requestWithMember({
      body: request,
      decode: lanCollabControlOperationCodec(operation).decodeResponse,
      idempotencyKey: input.idempotencyKey,
      method: COLLAB_CONTROL_OPERATION_BINDINGS[operation].method,
      path: collabControlOperationPath(operation, input.projectId),
    }, input.memberCredential, input.signal ? { signal: input.signal } : {});
  }

  setRetirementHandler(handler: NonNullable<ClaudianCollabService['retirementHandler']>): void {
    this.assertOpen();
    this.retirementHandler = handler;
  }

  async restoreRetirementResponders(): Promise<void> {
    this.assertOpen();
    const restored = await this.retirementTombstones.restore();
    let firstError: unknown;
    for (const projectId of restored.expiredProjectIds) {
      await this.restoreExpiredRetirementResponder(projectId).catch(error => {
        firstError ??= error;
      });
    }
    for (const tombstone of restored.tombstones) {
      await this.restoreRetirementResponder(tombstone).catch(error => {
        firstError ??= error;
      });
    }
    if (firstError instanceof Error) throw firstError;
    if (firstError) {
      throw collabServiceError('not-initialized', 'retirement-responder-restore-failed');
    }
  }

  private async restoreExpiredRetirementResponder(projectId: CollabProjectId): Promise<void> {
    await this.lanHost.stopTerminalProject(projectId).catch(() => undefined);
    await this.closeAuthority(projectId).catch(() => undefined);
    await this.local.projects.removeAuthorityDirectory(projectId);
    await this.retirementTombstones.remove(projectId);
  }

  private async restoreRetirementResponder(tombstone: {
    readonly projectId: CollabProjectId;
    readonly result: CollabRetirementResult;
  }): Promise<void> {
    await this.startRetirementResponder(tombstone.projectId);
    const [index, retirement] = await Promise.all([
      this.local.projects.loadIndex(),
      this.local.projects.loadRetirementRecord(tombstone.projectId),
    ]);
    if (
      retirement !== null
      || index.projects.some(project => project.id === tombstone.projectId)
    ) {
      await this.retirementHandler?.handle(tombstone.result, 'terminal-fallback')
        .catch(() => undefined);
    }
    await this.closeAuthority(tombstone.projectId).catch(() => undefined);
    await this.local.projects.removeAuthorityDirectory(tombstone.projectId);
    this.retiredAuthorityCleanupComplete.add(tombstone.projectId);
    if (this.retirementResponderCleanupPending.delete(tombstone.projectId)) {
      await this.cleanupRetirementResponder(tombstone.projectId);
    }
  }

  openAuthority(projectId: CollabProjectId): Promise<CollabAuthorityFoundation> {
    this.assertOpen();
    const existing = this.authorityFoundations.get(projectId);
    if (existing) return existing;
    const pending = this.createAndOpenAuthority(projectId);
    this.authorityFoundations.set(projectId, pending);
    void pending.catch(() => {
      if (this.authorityFoundations.get(projectId) === pending) {
        this.authorityFoundations.delete(projectId);
      }
    });
    return pending;
  }

  async closeAuthority(projectId: CollabProjectId): Promise<void> {
    const pending = this.authorityFoundations.get(projectId);
    if (!pending) return;
    this.authorityFoundations.delete(projectId);
    const foundation = await pending;
    await foundation.database.close();
  }

  async inspectAuthority(
    projectId: CollabProjectId,
  ): Promise<CollabAuthorityFoundation | null> {
    this.assertOpen();
    const existing = this.authorityFoundations.get(projectId);
    if (existing) return existing;
    if (await this.local.projects.findAuthorityDirectory(projectId) === null) {
      return null;
    }
    return this.openAuthority(projectId);
  }

  async discardProvisionalAuthority(projectId: CollabProjectId): Promise<void> {
    await this.closeAuthority(projectId);
    await this.local.projects.removeAuthorityDirectory(projectId);
  }

  createHostTransferService(
    snapshots: HostTransferModuleOptions['snapshots'],
  ): CollabHostTransferService {
    this.assertOpen();
    if (this.hostTransferModule) {
      throw collabServiceError('not-initialized', 'host-transfer-module-already-created');
    }
    const module = new HostTransferModule({
      activateTransferredAuthority: async input => {
        const membership = await this.local.projects.loadMembership(input.projectId);
        if (
          !membership
          || membership.project.id !== input.projectId
          || membership.member.id !== input.targetHostMemberId
          || !membership.hostOwnership.ownsAuthority
        ) {
          throw collabServiceError('not-initialized', 'host-transfer-target-projection-missing');
        }
        const session = await this.lanHost.startProject(input.projectId);
        return { endpoint: session.endpoint };
      },
      finalizeOldAuthority: async projectId => {
        await this.closeAuthority(projectId);
        await this.local.projects.removeAuthorityDirectory(projectId);
      },
      lanHost: this.lanHost,
      projects: this.local.projects,
      requireGitFoundation: () => this.requireGitFoundation(),
      snapshots,
      workspace: this.local.workspace,
    });
    this.hostTransferModule = module;
    return module.clientService;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.retirementHandler = null;
    this.closePromise = (async () => {
      let firstError: unknown;
      await this.retirementResponderExpiry.close().catch(error => {
        firstError = error;
      });
      this.retirementResponders.clear();
      this.retirementResponderCleanupPending.clear();
      this.retiredAuthorityCleanupComplete.clear();
      await this.lanHost.close().catch(error => {
        firstError ??= error;
      });
      await this.discovery.close().catch(error => {
        firstError ??= error;
      });
      const pending = [...this.authorityFoundations.values()];
      this.authorityFoundations.clear();
      const foundations = await Promise.all(pending.map(
        foundation => foundation.catch(() => null),
      ));
      const closeResults = await Promise.allSettled(
        foundations
          .filter((foundation): foundation is CollabAuthorityFoundation => foundation !== null)
          .map(foundation => foundation.database.close()),
      );
      firstError ??= closeResults.find(result => result.status === 'rejected')?.reason;
      if (firstError instanceof Error) throw firstError;
      if (firstError) throw collabServiceError('not-initialized', 'collab-close-failed');
    })();
    return this.closePromise;
  }

  private async createAndOpenAuthority(
    projectId: CollabProjectId,
  ): Promise<CollabAuthorityFoundation> {
    const membership = await this.local.projects.loadMembership(projectId);
    const authorityDirectory = await this.local.projects.ensureAuthorityDirectory(projectId, {
      claimLegacyOwnedDirectory: membership?.project.id === projectId
        && membership.hostOwnership.ownsAuthority,
    });
    const database = this.createAuthorityDatabase(authorityDirectory);
    try {
      await database.open();
    } catch (error) {
      await database.close().catch(() => undefined);
      throw error;
    }
    if (this.closed) {
      await database.close();
      throw collabServiceError('not-initialized', 'collab-service-closed');
    }
    return Object.freeze({
      authorityDirectory,
      database,
      events: new AuthorityEventRepository(),
      idempotency: new AuthorityIdempotencyRepository(),
      projects: new ProjectAuthorityRepository(),
    });
  }

  private async openLanHostProject(
    projectId: CollabProjectId,
  ): Promise<LanHostProjectRuntime> {
    const [authority, git] = await Promise.all([
      this.openAuthority(projectId),
      this.requireGitFoundation(),
    ]);
    const gitHttpBackendPath = git.runtime.httpBackendPath;
    if (!gitHttpBackendPath) {
      throw collabServiceError('git-capability-missing', 'git-http-backend-missing', {
        missingCapabilities: ['http-backend'],
      });
    }
    const repositoryPath = path.join(authority.authorityDirectory, 'repository.git');
    const requestEnsure = new RequestEnsureService(
      authority.database,
      createRequestEnsureGitPolicy(repositoryPath, git.repositories),
    );
    const requestQuery = new RequestQueryService(
      authority.database,
      new RequestQueryGitPolicy(repositoryPath, git.repositories),
    );
    const requestComments = new RequestCommentService(authority.database);
    const ticketService = new TicketService(authority.database);
    const accept = new AcceptCoordinator(
      authority.database,
      new AcceptGitRepository(repositoryPath, git.repositories),
    );
    try {
      await accept.recover();
    } catch (error) {
      if (!(error instanceof CollabError) || error.code !== 'acceptance-recovery-required') {
        throw error;
      }
    }
    const mutationQueue = new SerialTaskQueue();
    const requests = {
      accept: (...args: Parameters<AcceptCoordinator['accept']>) => (
        mutationQueue.run(() => accept.accept(...args))
      ),
      createComment: (...args: Parameters<RequestCommentService['create']>) => (
        mutationQueue.run(() => requestComments.create(...args))
      ),
      ensure: (...args: Parameters<RequestEnsureService['ensure']>) => (
        mutationQueue.run(() => requestEnsure.ensure(...args))
      ),
      read: requestQuery.read.bind(requestQuery),
      readComments: requestQuery.readComments.bind(requestQuery),
      updateMetadata: (...args: Parameters<RequestEnsureService['updateMetadata']>) => (
        mutationQueue.run(() => requestEnsure.updateMetadata(...args))
      ),
    };
    const tickets = {
      close: (...args: Parameters<TicketService['close']>) => (
        mutationQueue.run(() => ticketService.close(...args))
      ),
      comment: (...args: Parameters<TicketService['comment']>) => (
        mutationQueue.run(() => ticketService.comment(...args))
      ),
      create: (...args: Parameters<TicketService['create']>) => (
        mutationQueue.run(() => ticketService.create(...args))
      ),
      list: ticketService.list.bind(ticketService),
      listAcceptedRelations: ticketService.listAcceptedRelations.bind(ticketService),
      listComments: ticketService.listComments.bind(ticketService),
      read: ticketService.read.bind(ticketService),
      reopen: (...args: Parameters<TicketService['reopen']>) => (
        mutationQueue.run(() => ticketService.reopen(...args))
      ),
      updateContent: (...args: Parameters<TicketService['updateContent']>) => (
        mutationQueue.run(() => ticketService.updateContent(...args))
      ),
    };
    const readMainOid = async (): Promise<string> => {
      const oid = await git.repositories.resolveRef(repositoryPath, COLLAB_MAIN_REF);
      if (!oid) {
        throw new CollabError({
          code: 'repository-invalid',
          recoveryActions: ['open-diagnostics'],
          safeContext: { reason: 'authority-main-ref-missing' },
        });
      }
      return oid;
    };
    const events = new ProjectEventHub(
      projectId,
      new SqlJsProjectEventSource(authority.database, projectId),
    );
    const managerResponsibilities = new ManagerResponsibilityService({
      ...authority,
      presence: events,
    });
    const hostTransfers = new HostTransferAuthorityService(authority);
    const outgoingHostTransfer = this.hostTransferModule?.createOutgoingRuntime({
      accept,
      authority,
      git,
      hostTransfers,
      projectId,
      repositoryPath,
    });
    const tombstones = this.retirementTombstones;
    const retirementAuthority = new ProjectRetirementAuthorityService(
      authority.database,
      tombstones,
    );
    const lifecycle: NonNullable<LanHostProjectRuntime['lifecycle']> = {
      acceptHostTransfer: (actorMemberId, request) => (
        hostTransfers.accept(actorMemberId, request)
      ),
      acknowledgeManagerResponsibility: (actorMemberId, request) => (
        managerResponsibilities.acknowledge(actorMemberId, request)
      ),
      cancelHostTransfer: (actorMemberId, request) => (
        hostTransfers.cancel(actorMemberId, request)
      ),
      cancelManagerResponsibilityOffer: (actorMemberId, request) => (
        managerResponsibilities.cancel(actorMemberId, request)
      ),
      createHostTransfer: (actorMemberId, request) => (
        hostTransfers.create(actorMemberId, request)
      ),
      createManagerResponsibilityOffer: (actorMemberId, request) => (
        managerResponsibilities.create(actorMemberId, request)
      ),
      createRetirementCoordinator: (
        input: RetirementCoordinatorFactoryInput,
      ): Pick<HostedLifecycleControlPort, 'retireProject'> => {
        const coordinator = new ProjectRetirementCoordinator(
          input.admission,
          retirementAuthority,
          {
            activate: async () => {
              await input.activateTerminal(this.createRetirementTerminalService(projectId));
              await this.scheduleRetirementResponderExpiry(projectId);
            },
          },
          {
            deliver: async result => {
              void input.deliver(result).catch(() => undefined);
              await this.retirementHandler?.handle(result, 'response');
            },
          },
          { teardown: retiredProjectId => input.teardown(retiredProjectId) },
        );
        return {
          retireProject: (actorMemberId, request) => coordinator.retire(actorMemberId, {
            expectedHostMemberId: request.expectedHostMemberId,
            idempotencyKey: request.idempotencyKey,
            managerActorMemberId: request.managerActorMemberId,
            operationId: retirementOperationId(request.idempotencyKey),
            projectId: request.projectId,
            requestFingerprint: createRetirementIntent(request).requestFingerprint,
          }),
        };
      },
      declineHostTransfer: (actorMemberId, request) => (
        hostTransfers.decline(actorMemberId, request)
      ),
      declineManagerResponsibility: (actorMemberId, request) => (
        managerResponsibilities.decline(actorMemberId, request)
      ),
      getCurrentManagerResponsibilityOffer: (actorMemberId, request) => (
        managerResponsibilities.getCurrent(actorMemberId, request.projectId)
      ),
      getCurrentHostTransfer: (actorMemberId, currentProjectId) => (
        hostTransfers.getCurrent(actorMemberId, currentProjectId)
      ),
      getHostTransitions: async request => ({
        projectId: request.projectId,
        proofs: await hostTransfers.listProofs(),
      }),
      getManagerResponsibilityOffer: (actorMemberId, request) => (
        managerResponsibilities.getById(actorMemberId, request.projectId, request.offerId)
      ),
    };
    return {
      authority,
      authorityDirectory: authority.authorityDirectory,
      events,
      git: {
        baseEnvironment: this.getEnvironment(),
        emptyConfigPath: await this.local.projects.ensureGitEmptyConfig(),
        gitExecutablePath: git.runtime.executablePath,
        gitHttpBackendPath,
        prepareMemberRef: async memberId => {
          const ref = collabMemberRef(memberId);
          if (await git.repositories.resolveRef(repositoryPath, ref)) return;
          const mainOid = await readMainOid();
          try {
            await git.repositories.createRef(repositoryPath, ref, mainOid);
          } catch (error) {
            if (await git.repositories.resolveRef(repositoryPath, ref)) return;
            throw error;
          }
        },
        repository: git.repositories,
      },
      lifecycle,
      ...(outgoingHostTransfer ? { outgoingHostTransfer } : {}),
      onPendingExpired: async member => {
        const ref = collabMemberRef(member.id);
        const [mainOid, memberOid] = await Promise.all([
          readMainOid(),
          git.repositories.resolveRef(repositoryPath, ref),
        ]);
        if (memberOid === null) return;
        if (memberOid !== mainOid) {
          throw new CollabError({
            code: 'repository-invalid',
            recoveryActions: ['open-diagnostics'],
            safeContext: { reason: 'expired-pending-ref-diverged' },
          });
        }
        const deleted = await git.repositories.deleteRefIfMatches(
          repositoryPath,
          ref,
          memberOid,
        );
        if (!deleted.updated && deleted.currentOid !== null) {
          throw new CollabError({
            code: 'stale-main',
            recoveryActions: ['retry', 'open-diagnostics'],
            safeContext: { reason: 'expired-pending-ref-delete-raced' },
          });
        }
      },
      readMainOid,
      retireAuthority: async () => {
        await this.closeAuthority(projectId);
        await this.local.projects.removeAuthorityDirectory(projectId);
        this.retiredAuthorityCleanupComplete.add(projectId);
        if (this.retirementResponderCleanupPending.delete(projectId)) {
          await this.cleanupRetirementResponder(projectId);
        }
      },
      requests,
      tickets,
      validate: () => git.repositories.assertHealthy(repositoryPath),
    };
  }

  private assertOpen(): void {
    if (this.closed) throw collabServiceError('not-initialized', 'collab-service-closed');
  }

  private createRetirementTerminalService(
    projectId: CollabProjectId,
  ): CollabTerminalProjectService {
    const existing = this.retirementResponders.get(projectId);
    if (existing) return existing;
    const terminal = new RetirementTerminalService(this.retirementTombstones);
    const service: CollabTerminalProjectService = {
      acknowledgeRetirement: async (memberCredential, request) => {
        const result = await terminal.acknowledge(
          request.projectId,
          memberCredential,
          request.retiredAt,
        );
        return { response: result.body };
      },
      getHostTransitions: async request => ({
        projectId: request.projectId,
        proofs: await terminal.getHostTransitions(request.projectId),
      }),
      getRetirement: memberCredential => terminal.getResult(projectId, memberCredential),
    };
    this.retirementResponders.set(projectId, service);
    return service;
  }

  private async startRetirementResponder(
    projectId: CollabProjectId,
    scheduleExpiry = true,
  ): Promise<void> {
    await this.lanHost.startTerminalProject({
      projectId,
      service: this.createRetirementTerminalService(projectId),
    });
    if (scheduleExpiry) await this.scheduleRetirementResponderExpiry(projectId);
  }

  private async scheduleRetirementResponderExpiry(projectId: CollabProjectId): Promise<void> {
    const tombstone = await this.retirementTombstones.load(projectId);
    if (!tombstone) {
      throw new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['resume', 'open-diagnostics'],
        safeContext: { reason: 'retirement-tombstone-missing' },
      });
    }
    this.retirementResponderExpiry.schedule(projectId, tombstone.expiresAt);
  }

  private async cleanupRetirementResponder(projectId: CollabProjectId): Promise<void> {
    if (!this.retiredAuthorityCleanupComplete.has(projectId)) {
      this.retirementResponderCleanupPending.add(projectId);
      return;
    }
    await this.lanHost.stopTerminalProject(projectId);
    try {
      await this.retirementTombstones.remove(projectId);
    } catch (error) {
      await this.startRetirementResponder(projectId, false).catch(() => undefined);
      throw error;
    }
    this.retirementResponders.delete(projectId);
    this.retirementResponderExpiry.cancel(projectId);
    this.retirementResponderCleanupPending.delete(projectId);
    this.retiredAuthorityCleanupComplete.delete(projectId);
  }

  private async requireTrustedMembership(projectId: CollabProjectId): Promise<{
    readonly credential: string;
    readonly trust: {
      readonly caCertificatePem: string;
      readonly caFingerprint: string;
      readonly endpoint: string;
      readonly projectId: string;
    };
  }> {
    const membership = await this.local.projects.loadMembership(projectId);
    const endpoint = membership?.authority.endpoint;
    const caCertificatePem = membership?.authority.hostCaCertificatePem;
    const caFingerprint = membership?.authority.hostCaFingerprint;
    if (!membership || !endpoint || !caCertificatePem || !caFingerprint) {
      throw new CollabError({
        code: 'host-stopped',
        safeContext: { reason: 'retirement-host-trust-unavailable' },
      });
    }
    return {
      credential: membership.member.credential,
      trust: { caCertificatePem, caFingerprint, endpoint, projectId },
    };
  }
}

function retirementResultFromError(
  projectId: CollabProjectId,
  error: unknown,
): CollabRetirementResult | null {
  if (!(error instanceof CollabError) || error.code !== 'project-retired') return null;
  const contextProjectId = error.safeContext.projectId;
  const retiredAt = error.safeContext.retiredAt;
  if (
    contextProjectId !== projectId
    || typeof retiredAt !== 'string'
    || Number.isNaN(Date.parse(retiredAt))
    || new Date(retiredAt).toISOString() !== retiredAt
  ) {
    throw new CollabError({
      code: 'authority-integrity-error',
      safeContext: { reason: 'retirement-terminal-result-invalid' },
    });
  }
  return { projectId, retiredAt };
}

function retirementOperationId(idempotencyKey: string): string {
  return `retire-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
}
