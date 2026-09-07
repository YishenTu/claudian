import { createHash } from 'node:crypto';
import path from 'node:path';

import { COLLAB_MAIN_REF, collabMemberRef, type CollabProjectId } from '@claudian-collab/protocol';

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
import type {
  AuthorityTransferModule,
} from '@/app/collab/authority-transfer/AuthorityTransferModule';
import {
  AuthorityTransferPersistence,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import {
  bindLegacyCloudBootstrapSourceOwner,
} from '@/app/collab/bootstrap/CloudBootstrapTransitionRecord';
import { CloudBootstrapTransitionStore } from '@/app/collab/bootstrap/CloudBootstrapTransitionStore';
import {
  type CollabFilesystemDiagnosticSink,
} from '@/app/collab/CollabFilesystemBoundary';
import {
  type CollabLocalLanMembershipRecord,
  CollabLocalProjectRepository,
  isCollabLocalLanMembership,
  type OwnedAuthorityDirectoryCapability,
  type ProvisionalAuthorityDirectoryCapability,
} from '@/app/collab/CollabLocalProjectRepository';
import { CollabPathPolicy } from '@/app/collab/CollabPathPolicy';
import { CollabWorkspaceService } from '@/app/collab/CollabWorkspaceService';
import {
  CollabLanDiscoveryService,
} from '@/app/collab/discovery/CollabLanDiscoveryService';
import { rotateTrustedCollabOrigin } from '@/app/collab/git/CollabGitOriginPolicy';
import { GitCommandRunner } from '@/app/collab/git/GitCommandRunner';
import { GitRepositoryService } from '@/app/collab/git/GitRepositoryService';
import {
  type GitRuntime,
  type GitRuntimeResolution,
  type GitRuntimeResolveInput,
  GitRuntimeResolver,
} from '@/app/collab/git/GitRuntimeResolver';
import { HostInstallationBindingService } from '@/app/collab/host-installation/HostInstallationBindingService';
import type { CollabHostTransferService } from '@/app/collab/host-transfer/CollabHostTransferService';
import {
  HostTransferModule,
  type HostTransferModuleOptions,
} from '@/app/collab/host-transfer/HostTransferModule';
import {
  bindLegacyHostTransferRecoveryOwner,
} from '@/app/collab/host-transfer/HostTransferRecoveryRecord';
import { HostTrustTransitionService } from '@/app/collab/host-transfer/HostTrustTransitionService';
import { HostTransitionCandidateResolver } from '@/app/collab/HostTransitionCandidateResolver';
import { JoinProjectCoordinator } from '@/app/collab/join/JoinProjectCoordinator';
import {
  AuthorityMemberCredentialAuthenticator,
} from '@/app/collab/lan/AuthorityMemberCredentialAuthenticator';
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
import { LanTlsIdentity } from '@/app/collab/lan/LanTlsIdentity';
import {
  ProjectEventHub,
  SqlJsProjectEventSource,
} from '@/app/collab/lan/ProjectEventHub';
import type {
  CollabTerminalProjectService,
} from '@/app/collab/lan/routes/RouteTypes';
import {
  LanAuthorityProjectionTransitionCoordinator,
} from '@/app/collab/LanAuthorityProjectionTransitionCoordinator';
import type {
  CollabProjectLifecycleAdmission,
  CollabProjectLifecycleAuthorityAdmission,
} from '@/app/collab/lifecycle/CollabProjectLifecycleAdmission';
import {
  bindLegacyCollabProjectSetupOwner,
  decodeCollabProjectSetupRecord,
} from '@/app/collab/project/CollabProjectSetupRecord';
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
import type { InstallationKey } from '@/core/device/InstallationKey';

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
  readonly installationKey: InstallationKey;
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
  readonly projectLifecycleAdmission: CollabProjectLifecycleAuthorityAdmission;
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
  readonly authorityTransfers: AuthorityTransferPersistence;
  readonly cloudBootstrapTransitions: CloudBootstrapTransitionStore;
  readonly discovery: CollabLanDiscoveryService;
  readonly hostTransitionCandidates: HostTransitionCandidateResolver;
  readonly hostInstallations: HostInstallationBindingService;
  readonly installationKey: ClaudianCollabServiceOptions['installationKey'];
  readonly join: JoinProjectCoordinator;
  readonly lanHost: LanHostCoordinator;
  readonly local: CollabLocalFoundation;
  readonly reconnect: ReconnectProjectCoordinator;
  readonly #authorityProjectionTransitions = new LanAuthorityProjectionTransitionCoordinator();
  private readonly authorityFoundations = new Map<
    CollabProjectId,
    Promise<CollabAuthorityFoundation>
  >();
   #authorityTransferModule: AuthorityTransferModule | null = null;
  private closed = false;
   readonly #createAuthorityDatabase: (
    authorityDirectory: string,
  ) => SqlJsProjectDatabase;
   readonly #getEnvironment: () => NodeJS.ProcessEnv;
   readonly #gitRuntimeResolver: CollabGitRuntimeResolver;
   #hostTransferModule: HostTransferModule | null = null;
   #closePromise: Promise<void> | null = null;
   readonly #retirementResponders = new Map<
    CollabProjectId,
    CollabTerminalProjectService
  >();
   readonly #retirementResponderExpiry = new RetirementResponderExpiryScheduler(
    projectId => this.#cleanupRetirementResponder(projectId),
  );
   readonly #retirementResponderCleanupPending = new Set<CollabProjectId>();
  private readonly retiredAuthorityCleanupComplete = new Set<CollabProjectId>();
  private readonly retirementTombstones: RetirementTombstoneRepository;
   readonly #retirementTerminalClient: RetirementTerminalClient;
  private retirementHandler: {
    handle(
      result: CollabRetirementResult,
      source: 'response' | 'terminal-fallback',
    ): Promise<void>;
  } | null = null;

  constructor(private readonly options: ClaudianCollabServiceOptions) {
    this.installationKey = options.installationKey;
    const pathPolicy = new CollabPathPolicy({
      obsidianConfigDirectory: options.obsidianConfigDirectory,
    });
    const projects = new CollabLocalProjectRepository(options.vaultRoot, {
      installationKey: options.installationKey,
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
    this.#getEnvironment = options.getEnvironment ?? (() => process.env);
    this.#gitRuntimeResolver = options.gitRuntimeResolver ?? new GitRuntimeResolver({
      environment: this.#getEnvironment(),
    });
    this.#createAuthorityDatabase = options.createAuthorityDatabase
      ?? (authorityDirectory => new SqlJsProjectDatabase(authorityDirectory));
    this.discovery = new CollabLanDiscoveryService({
      ...(options.invitationCodec ? { invitationCodec: options.invitationCodec } : {}),
    });
    const tlsIdentity = options.lanHost?.tlsIdentity ?? new LanTlsIdentity(options.vaultRoot, {
      installationKey: options.installationKey,
    });
    this.hostInstallations = new HostInstallationBindingService({
      bindEligibleLegacyRecovery: (projectId, installationKey) => (
        this.#bindEligibleLegacyRecovery(projectId, installationKey)
      ),
      installationKey: options.installationKey,
      prepareLegacyRuntime: async projectId => {
        const membership = await projects.loadMembership(projectId);
        const expectedFingerprint = membership && isCollabLocalLanMembership(membership)
          ? membership.authority.hostCaFingerprint
          : null;
        await tlsIdentity.adoptLegacyGlobalIdentity(expectedFingerprint);
      },
      projects,
    });
    this.authorityTransfers = new AuthorityTransferPersistence(projects, {
      isRecoveryOwner: ownerInstallationKey => (
        this.hostInstallations.isRecoveryOwner(ownerInstallationKey)
      ),
    });
    this.retirementTombstones = new RetirementTombstoneRepository(projects, {
      isRecoveryOwner: ownerInstallationKey => (
        this.hostInstallations.isRecoveryOwner(ownerInstallationKey)
      ),
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
      authorityProjectionTransitions: this.#authorityProjectionTransitions,
      hostTransitionProofClient,
      hostInstallation: this.hostInstallations,
      hostTrustTransitionVerifier: hostTrustTransitions,
      ...(options.invitationCodec ? { invitationCodec: options.invitationCodec } : {}),
      vaultRoot: options.vaultRoot,
    });
    this.#retirementTerminalClient = new RetirementTerminalClient({
      hostTransitionCandidates: this.hostTransitionCandidates,
      request: (trust, input) => this.#sendRetirementAcknowledgement(trust, input),
    });
    this.cloudBootstrapTransitions = new CloudBootstrapTransitionStore(options.vaultRoot, {
      isRecoveryOwner: ownerInstallationKey => (
        this.hostInstallations.isRecoveryOwner(ownerInstallationKey)
      ),
    });
    this.lanHost = new LanHostCoordinator({
      ...options.lanHost,
      assertHostInstallationOwned: async projectId => {
        await this.hostInstallations.assertOwned(projectId, 'start');
      },
      commitHostedRoute: (expected, next) => this.#commitHostedRoute(expected, next),
      discovery: this.discovery,
      installationKey: options.installationKey,
      localProjects: projects,
      openProject: projectId => this.#openLanHostProject(projectId),
      runWithProjectStartGuard: async (projectId, operation) => {
        const tombstone = await projects.loadRetirementTombstone(projectId);
        if (tombstone && tombstone.ownerInstallationKey === undefined) {
          throw new CollabError({
            code: 'durable-progress-recovery-required',
            recoveryActions: ['resume', 'open-diagnostics'],
            safeContext: {
              projectId,
              reason: 'retirement-tombstone-legacy-owner-missing',
            },
          });
        }
        if (
          tombstone
          && this.hostInstallations.isRecoveryOwner(tombstone.ownerInstallationKey)
        ) {
          throw new CollabError({
            code: 'project-retired',
            safeContext: {
              projectId,
              reason: 'retirement-tombstone-durable',
              retiredAt: tombstone.retiredAt,
            },
          });
        }
        return this.cloudBootstrapTransitions.runWithLanHostStartGuard(
          projectId,
          () => this.authorityTransfers.runWithAuthorityStartGuard(projectId, operation),
        );
      },
      tlsIdentity,
      vaultRoot: options.vaultRoot,
    });
  }

  resolveGitRuntime(rescan = false): Promise<GitRuntimeResolution> {
    this.#assertOpen();
    const environment = this.#getEnvironment();
    const input = {
      configuredPath: this.options.getConfiguredGitPath(),
      pathEnvironment: environmentPath(environment),
    };
    return rescan
      ? this.#gitRuntimeResolver.rescan(input)
      : this.#gitRuntimeResolver.resolve(input);
  }

  bindAuthorityTransferModule(module: AuthorityTransferModule): void {
    this.#assertOpen();
    if (this.#authorityTransferModule && this.#authorityTransferModule !== module) {
      throw new Error('Authority transfer module is already bound');
    }
    this.#authorityTransferModule = module;
  }

  async activateAuthorityTransferSourceRoute(
    projectId: CollabProjectId,
    expectedEndpoint?: string,
  ): Promise<() => Promise<void>> {
    this.#assertOpen();
    const authority = await this.inspectAuthority(projectId);
    if (!authority) {
      throw collabServiceError(
        'not-initialized',
        'authority-transfer-source-authority-missing',
      );
    }
    const project = await authority.database.read(connection => authority.projects.get(connection));
    if (!project || project.projectId !== projectId) {
      throw collabServiceError(
        'not-initialized',
        'authority-transfer-source-project-missing',
      );
    }
    const authenticator = new AuthorityMemberCredentialAuthenticator(authority.database);
    const service = this.#authorityTransferModule?.sourceActiveService({
      authenticateMemberCredential: async credential => ({
        memberId: (await authenticator.authenticate(credential, ['active'])).member.id,
      }),
      hostMemberId: project.hostMemberId,
      projectId,
    });
    if (!service) {
      throw collabServiceError(
        'not-initialized',
        'authority-transfer-source-runtime-missing',
      );
    }
    await this.lanHost.startAuthorityTransferRoute({
      ...(expectedEndpoint ? { expectedEndpoint } : {}),
      hostMemberId: project.hostMemberId,
      projectId,
      service,
      state: 'source-active',
    });
    return () => this.lanHost.stopAuthorityTransferRoute(projectId, 'source-active');
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
      baseEnvironment: this.#getEnvironment(),
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
    this.#assertOpen();
    const { idempotencyKey } = createRetirementIntent(request);
    const membership = await this.#requireTrustedMembership(request.projectId);
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
    this.#assertOpen();
    return this.#retirementTerminalClient.acknowledge(input);
  }

   #sendRetirementAcknowledgement(
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
    this.#assertOpen();
    this.retirementHandler = handler;
  }

  async restoreRetirementResponders(
    projectRecoveryAdmission: CollabProjectLifecycleAdmission,
  ): Promise<void> {
    this.#assertOpen();
    const restored = await this.retirementTombstones.restore();
    let firstError: unknown;
    for (const projectId of restored.expiredProjectIds) {
      await projectRecoveryAdmission(
        projectId,
        () => this.#restoreExpiredRetirementResponder(projectId),
      ).catch(error => {
        firstError ??= error;
      });
    }
    for (const tombstone of restored.tombstones) {
      await projectRecoveryAdmission(
        tombstone.projectId,
        () => this.#restoreRetirementResponder(tombstone),
      ).catch(error => {
        firstError ??= error;
      });
    }
    if (firstError instanceof Error) throw firstError;
    if (firstError) {
      throw collabServiceError('not-initialized', 'retirement-responder-restore-failed');
    }
  }

   async #restoreExpiredRetirementResponder(projectId: CollabProjectId): Promise<void> {
    const tombstone = await this.local.projects.loadRetirementTombstone(projectId);
    if (!tombstone) {
      throw new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['resume', 'open-diagnostics'],
        safeContext: { projectId, reason: 'retirement-tombstone-missing' },
      });
    }
    this.hostInstallations.assertRecoveryOwner(
      tombstone.ownerInstallationKey,
      projectId,
      'retirement',
    );
    const [index, retirement] = await Promise.all([
      this.local.projects.loadIndex(),
      this.local.projects.loadRetirementRecord(projectId),
    ]);
    if (retirement !== null || index.projects.some(project => project.id === projectId)) {
      if (!this.retirementHandler) {
        throw collabServiceError('not-initialized', 'retirement-handler-missing');
      }
      await this.retirementHandler.handle(tombstone.result, 'terminal-fallback');
    }
    await this.lanHost.stopTerminalProject(projectId).catch(() => undefined);
    await this.closeAuthority(projectId).catch(() => undefined);
    await this.removeOwnedAuthorityDirectory(projectId);
    await this.retirementTombstones.remove(projectId);
  }

   async #restoreRetirementResponder(tombstone: {
    readonly ownerInstallationKey?: string;
    readonly projectId: CollabProjectId;
    readonly result: CollabRetirementResult;
  }): Promise<void> {
    this.hostInstallations.assertRecoveryOwner(
      tombstone.ownerInstallationKey,
      tombstone.projectId,
      'retirement',
    );
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
    await this.removeOwnedAuthorityDirectory(tombstone.projectId);
    this.retiredAuthorityCleanupComplete.add(tombstone.projectId);
    if (this.#retirementResponderCleanupPending.delete(tombstone.projectId)) {
      await this.#cleanupRetirementResponder(tombstone.projectId);
    }
  }

  async createAuthority(projectId: CollabProjectId): Promise<CollabAuthorityFoundation> {
    this.#assertOpen();
    const capability = await this.hostInstallations.createOwned(projectId);
    return this.#openOwnedAuthority(capability);
  }

  async openAuthority(projectId: CollabProjectId): Promise<CollabAuthorityFoundation> {
    this.#assertOpen();
    const capability = await this.hostInstallations.assertOwned(projectId, 'open');
    return this.#openOwnedAuthority(capability);
  }

  async #commitHostedRoute(
    expected: CollabLocalLanMembershipRecord,
    next: CollabLocalLanMembershipRecord,
  ): Promise<void> {
    await this.#authorityProjectionTransitions.run(expected.project.id, async () => {
      const current = await this.local.projects.loadMembership(expected.project.id);
      if (JSON.stringify(current) !== JSON.stringify(expected)) {
        throw new CollabError({
          code: 'stale-project-selection',
          recoveryActions: ['retry'],
          safeContext: { reason: 'lan-host-route-projection-changed' },
        });
      }
      const remoteUrl = next.authority.gitRemoteUrl;
      if (!remoteUrl) {
        throw new CollabError({
          code: 'repository-invalid',
          recoveryActions: ['open-diagnostics'],
          safeContext: { reason: 'lan-host-route-origin-missing' },
        });
      }
      const git = await this.requireGitFoundation();
      const repositoryPath = await this.local.workspace.resolveManagedProjectPath(
        expected.project.workspacePath,
      );
      await git.repositories.assertLocalRepositoryIdentity(repositoryPath, {
        memberId: expected.member.id,
        personalRef: expected.member.personalRef,
        projectId: expected.project.id,
      });
      const previousOrigins = await git.repositories.listRemoteUrls(repositoryPath, 'origin');
      await rotateTrustedCollabOrigin(git.repositories, {
        newRemoteUrl: remoteUrl,
        oldRemoteUrl: expected.authority.gitRemoteUrl ?? remoteUrl,
        projectId: expected.project.id,
        repositoryPath,
      });
      try {
        await this.local.projects.saveMembership(next);
      } catch (error) {
        if (previousOrigins.length === 0) {
          await git.repositories.removeRemote(repositoryPath, 'origin').catch(() => undefined);
        } else if (previousOrigins.length === 1) {
          await git.repositories.addRemote(repositoryPath, 'origin', previousOrigins[0])
            .catch(() => undefined);
        }
        throw error;
      }
    });
  }

   #openOwnedAuthority(
    capability: OwnedAuthorityDirectoryCapability,
  ): Promise<CollabAuthorityFoundation> {
    const projectId = capability.projectId;
    const existing = this.authorityFoundations.get(projectId);
    if (existing) return existing;
    const pending = this.#createAndOpenAuthority(capability);
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
    this.#assertOpen();
    const existing = this.authorityFoundations.get(projectId);
    if (existing) return existing;
    if (await this.hostInstallations.inspect(projectId) === 'absent') return null;
    return this.openAuthority(projectId);
  }

  async discardProvisionalAuthority(projectId: CollabProjectId): Promise<void> {
    await this.closeAuthority(projectId);
    if (await this.hostInstallations.inspect(projectId) === 'absent') return;
    const capability = await this.hostInstallations.assertOwned(projectId, 'cleanup');
    await this.local.projects.removeOwnedAuthorityDirectory(capability);
  }

  async openAuthorityTransferTarget(
    projectId: CollabProjectId,
    ownerInstallationKey: unknown,
  ): Promise<CollabAuthorityFoundation> {
    this.#assertOpen();
    const capability = await this.hostInstallations.prepareAuthorityTransferTarget(
      projectId,
      ownerInstallationKey,
    );
    return this.#createAndOpenAuthority(capability);
  }

  async activateAuthorityTransferTarget(
    projectId: CollabProjectId,
    ownerInstallationKey: unknown,
  ): Promise<CollabAuthorityFoundation> {
    this.#assertOpen();
    const capability = await this.hostInstallations.activateAuthorityTransferTarget(
      projectId,
      ownerInstallationKey,
    );
    return this.#openOwnedAuthority(capability);
  }

  discardAuthorityTransferTarget(
    projectId: CollabProjectId,
    ownerInstallationKey: unknown,
  ): Promise<void> {
    return this.hostInstallations.discardAuthorityTransferTarget(
      projectId,
      ownerInstallationKey,
    );
  }

  createHostTransferService(
    snapshots: HostTransferModuleOptions['snapshots'],
    projectRecoveryAdmission: CollabProjectLifecycleAdmission,
    syncProjection: (projectId: CollabProjectId) => void,
  ): CollabHostTransferService {
    this.#assertOpen();
    if (this.#hostTransferModule) {
      throw collabServiceError('not-initialized', 'host-transfer-module-already-created');
    }
    const module = new HostTransferModule({
      activateTransferredAuthority: async input => {
        const membership = await this.local.projects.loadMembership(input.projectId);
        if (
          !membership
          || !isCollabLocalLanMembership(membership)
          || membership.project.id !== input.projectId
          || membership.member.id !== input.targetHostMemberId
          || !membership.hostOwnership.ownsAuthority
        ) {
          throw collabServiceError('not-initialized', 'host-transfer-target-projection-missing');
        }
        const session = await this.lanHost.startProject(input.projectId);
        return { endpoint: session.endpoint };
      },
      assertRecoveryOwner: (ownerInstallationKey, projectId) => {
        this.hostInstallations.assertRecoveryOwner(
          ownerInstallationKey,
          projectId,
          'host-transfer',
        );
        return Promise.resolve();
      },
      bindTransferTarget: async projectId => (
        await this.hostInstallations.bindTransferTarget(projectId)
      ).authorityDirectory,
      finalizeOldAuthority: async projectId => {
        await this.closeAuthority(projectId);
        await this.removeOwnedAuthorityDirectory(projectId);
      },
      installationKey: this.options.installationKey,
      lanHost: this.lanHost,
      syncProjection,
      authorityProjectionTransitions: this.#authorityProjectionTransitions,
      projects: this.local.projects,
      projectRecoveryAdmission,
      requireGitFoundation: () => this.requireGitFoundation(),
      snapshots,
      workspace: this.local.workspace,
    });
    this.#hostTransferModule = module;
    return module.clientService;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.closed = true;
    this.retirementHandler = null;
    this.#closePromise = (async () => {
      let firstError: unknown;
      await this.#retirementResponderExpiry.close().catch(error => {
        firstError = error;
      });
      this.#retirementResponders.clear();
      this.#retirementResponderCleanupPending.clear();
      this.retiredAuthorityCleanupComplete.clear();
      await this.authorityTransfers.close().catch(error => {
        firstError ??= error;
      });
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
    return this.#closePromise;
  }

   async #createAndOpenAuthority(
    capability: OwnedAuthorityDirectoryCapability | ProvisionalAuthorityDirectoryCapability,
  ): Promise<CollabAuthorityFoundation> {
    const { authorityDirectory } = capability;
    const database = this.#createAuthorityDatabase(authorityDirectory);
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

  async #openLanHostProject(
    projectId: CollabProjectId,
  ): Promise<LanHostProjectRuntime> {
    const capability = await this.hostInstallations.assertOwnedAfterLegacyRecoveryBinding(
      projectId,
      'open',
    );
    const [authority, git] = await Promise.all([
      this.#openOwnedAuthority(capability),
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
    const outgoingHostTransfer = this.#hostTransferModule?.createOutgoingRuntime({
      accept,
      authority,
      git,
      hostTransfers,
      projectId,
      repositoryPath,
    });
    const authorityProject = await authority.database.read(connection => (
      authority.projects.get(connection)
    ));
    if (!authorityProject || authorityProject.projectId !== projectId) {
      throw new CollabError({
        code: 'authority-integrity-error',
        recoveryActions: ['open-diagnostics'],
        safeContext: { reason: 'authority-transfer-project-authority-missing' },
      });
    }
    const authorityTransferAuthenticator = new AuthorityMemberCredentialAuthenticator(
      authority.database,
    );
    const authorityTransfer = this.#authorityTransferModule?.sourceActiveService({
      authenticateMemberCredential: async credential => ({
        memberId: (await authorityTransferAuthenticator.authenticate(
          credential,
          ['active'],
        )).member.id,
      }),
      hostMemberId: authorityProject.hostMemberId,
      projectId,
    }) ?? undefined;
    const tombstones = this.retirementTombstones;
    const retirementAuthority = new ProjectRetirementAuthorityService(
      authority.database,
      tombstones,
      { installationKey: this.installationKey },
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
              await input.activateTerminal(this.#createRetirementTerminalService(projectId));
              await this.#scheduleRetirementResponderExpiry(projectId);
            },
          },
          {
            deliver: async result => {
              void input.deliver(result).catch(() => undefined);
              await this.retirementHandler?.handle(result, 'response');
            },
          },
          { teardown: retiredProjectId => input.teardown(retiredProjectId) },
          input.projectLifecycleAdmission,
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
      ...(authorityTransfer ? { authorityTransfer } : {}),
      authority,
      authorityDirectory: authority.authorityDirectory,
      events,
      git: {
        baseEnvironment: this.#getEnvironment(),
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
        await this.removeOwnedAuthorityDirectory(projectId);
        this.retiredAuthorityCleanupComplete.add(projectId);
        if (this.#retirementResponderCleanupPending.delete(projectId)) {
          await this.#cleanupRetirementResponder(projectId);
        }
      },
      requests,
      tickets,
      validate: () => git.repositories.assertHealthy(repositoryPath),
    };
  }

   #assertOpen(): void {
    if (this.closed) throw collabServiceError('not-initialized', 'collab-service-closed');
  }

  private async removeOwnedAuthorityDirectory(projectId: CollabProjectId): Promise<void> {
    await this.hostInstallations.removeOwned(projectId);
  }

   #createRetirementTerminalService(
    projectId: CollabProjectId,
  ): CollabTerminalProjectService {
    const existing = this.#retirementResponders.get(projectId);
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
    this.#retirementResponders.set(projectId, service);
    return service;
  }

  private async startRetirementResponder(
    projectId: CollabProjectId,
    scheduleExpiry = true,
  ): Promise<void> {
    const tombstone = await this.retirementTombstones.load(projectId);
    if (!tombstone) {
      throw new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['resume', 'open-diagnostics'],
        safeContext: { reason: 'retirement-tombstone-missing' },
      });
    }
    this.hostInstallations.assertRecoveryOwner(
      tombstone.ownerInstallationKey,
      projectId,
      'retirement',
    );
    await this.lanHost.startTerminalProject({
      projectId,
      service: this.#createRetirementTerminalService(projectId),
    });
    if (scheduleExpiry) await this.#scheduleRetirementResponderExpiry(projectId);
  }

   async #scheduleRetirementResponderExpiry(projectId: CollabProjectId): Promise<void> {
    const tombstone = await this.retirementTombstones.load(projectId);
    if (!tombstone) {
      throw new CollabError({
        code: 'durable-progress-recovery-required',
        recoveryActions: ['resume', 'open-diagnostics'],
        safeContext: { reason: 'retirement-tombstone-missing' },
      });
    }
    this.#retirementResponderExpiry.schedule(projectId, tombstone.expiresAt);
  }

   async #cleanupRetirementResponder(projectId: CollabProjectId): Promise<void> {
    if (!this.retiredAuthorityCleanupComplete.has(projectId)) {
      this.#retirementResponderCleanupPending.add(projectId);
      return;
    }
    await this.lanHost.stopTerminalProject(projectId);
    try {
      await this.retirementTombstones.remove(projectId);
    } catch (error) {
      await this.startRetirementResponder(projectId, false).catch(() => undefined);
      throw error;
    }
    this.#retirementResponders.delete(projectId);
    this.#retirementResponderExpiry.cancel(projectId);
    this.#retirementResponderCleanupPending.delete(projectId);
    this.retiredAuthorityCleanupComplete.delete(projectId);
  }

   async #bindEligibleLegacyRecovery(
    projectId: CollabProjectId,
    installationKey: InstallationKey,
  ): Promise<void> {
    const setup = await this.local.projects.loadProjectDocument(
      projectId,
      'pending-operation',
      decodeCollabProjectSetupRecord,
    );
    if (setup?.schemaVersion === 2) {
      await this.local.projects.saveProjectDocument(
        projectId,
        'pending-operation',
        bindLegacyCollabProjectSetupOwner(setup, installationKey),
      );
    }

    const outgoingHostTransfer = await this.local.projects.hostTransferRecovery.load(
      projectId,
      'outgoing',
    );
    if (outgoingHostTransfer?.schemaVersion === 1) {
      await this.local.projects.hostTransferRecovery.save(
        bindLegacyHostTransferRecoveryOwner(outgoingHostTransfer, installationKey),
      );
    }

    await this.authorityTransfers.bindLegacySourceOwner(projectId, installationKey);

    const cloudBootstrap = await this.cloudBootstrapTransitions.load(projectId);
    if (
      cloudBootstrap?.schemaVersion === 1
      && cloudBootstrap.memberId === cloudBootstrap.oldAuthority.sourceHostMemberId
      && cloudBootstrap.fence.state !== 'not-applicable'
    ) {
      await this.cloudBootstrapTransitions.save(
        bindLegacyCloudBootstrapSourceOwner(cloudBootstrap, installationKey),
      );
    }
  }

   async #requireTrustedMembership(projectId: CollabProjectId): Promise<{
    readonly credential: string;
    readonly trust: {
      readonly caCertificatePem: string;
      readonly caFingerprint: string;
      readonly endpoint: string;
      readonly projectId: string;
    };
  }> {
    const membership = await this.local.projects.loadMembership(projectId);
    if (!membership || !isCollabLocalLanMembership(membership)) {
      throw new CollabError({
        code: 'host-stopped',
        safeContext: { reason: 'retirement-host-trust-unavailable' },
      });
    }
    const endpoint = membership.authority.endpoint;
    const caCertificatePem = membership.authority.hostCaCertificatePem;
    const caFingerprint = membership.authority.hostCaFingerprint;
    if (!endpoint || !caCertificatePem || !caFingerprint) {
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
