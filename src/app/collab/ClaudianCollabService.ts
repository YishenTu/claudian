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
import type { AuthorityTransferRecord } from '@/app/collab/authority-transfer/AuthorityTransferRecord';
import {
  AuthorityTransferPersistence,
} from '@/app/collab/authority-transfer/persistence/AuthorityTransferPersistence';
import {
  AuthorityProjectionTransitionCoordinator,
} from '@/app/collab/AuthorityProjectionTransitionCoordinator';
import {
  type CollabFilesystemDiagnosticSink,
} from '@/app/collab/CollabFilesystemBoundary';
import {
  type AuthorityResourceOperation,
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
  bindHostTransferSourceResource,
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
import type {
  CollabProjectLifecycleAdmission,
  CollabProjectLifecycleAuthorityAdmission,
} from '@/app/collab/lifecycle/CollabProjectLifecycleAdmission';
import {
  bindLegacyCollabProjectSetupOwner,
  decodeCollabProjectSetupRecord,
} from '@/app/collab/project/CollabProjectSetupRecord';
import { ProjectControlClient } from '@/app/collab/publish/ProjectControlClient';
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
import type {
  CollabOperationOptions,
  CollabRetirementResult,
  CollabRetireProjectRequest,
} from '@/core/collab';
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
  readonly resource: OwnedAuthorityDirectoryCapability | ProvisionalAuthorityDirectoryCapability;
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
    resourceAdmission?: <T>(operation: () => Promise<T>) => Promise<T>,
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

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
}

function environmentPath(environment: NodeJS.ProcessEnv): string | undefined {
  const entry = Object.entries(environment).find(
    ([key]) => key.toLocaleLowerCase('en-US') === 'path',
  );
  return entry?.[1];
}

export class ClaudianCollabService {
  readonly authorityTransfers: AuthorityTransferPersistence;
  readonly discovery: CollabLanDiscoveryService;
  readonly hostTransitionCandidates: HostTransitionCandidateResolver;
  readonly hostInstallations: HostInstallationBindingService;
  readonly installationKey: ClaudianCollabServiceOptions['installationKey'];
  readonly join: JoinProjectCoordinator;
  readonly lanHost: LanHostCoordinator;
  readonly local: CollabLocalFoundation;
  readonly reconnect: ReconnectProjectCoordinator;
  readonly #authorityProjectionTransitions = new AuthorityProjectionTransitionCoordinator();
  private readonly authorityFoundations = new Map<
    CollabProjectId,
    Promise<CollabAuthorityFoundation>
  >();
   #authorityTransferModule: AuthorityTransferModule | null = null;
  private closed = false;
   readonly #createAuthorityDatabase: (
    authorityDirectory: string,
    resourceAdmission?: <T>(operation: () => Promise<T>) => Promise<T>,
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
      ?? ((authorityDirectory, resourceAdmission) => new SqlJsProjectDatabase(authorityDirectory, { resourceAdmission }));
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
      runWithProjectStartGuard: (projectId, operation) => (
        this.#runWithLanHostStartGuards(
          projectId,
          operation,
          guarded => this.authorityTransfers.runWithAuthorityStartGuard(
            projectId,
            guarded,
            record => this.#authorityTransferModule?.assertLanHostStartReady(record),
          ),
        )
      ),
      runWithAuthorityTransferCancellationRestartGuard: (input, operation) => (
        this.#runWithLanHostStartGuards(
          input.projectId,
          operation,
          guarded => this.authorityTransfers.runWithLanToCloudCancellationRestartGuard(
            input,
            guarded,
          ),
        )
      ),
      runWithCloudToLanTargetRecoveryStartGuard: (input, operation) => (
        this.#runWithLanHostStartGuards(
          input.projectId,
          operation,
          guarded => this.authorityTransfers.runWithCloudToLanTargetRecoveryStartGuard(
            input,
            guarded,
          ),
        )
      ),
      tlsIdentity,
      vaultRoot: options.vaultRoot,
    });
  }

  async #runWithLanHostStartGuards<T>(
    projectId: CollabProjectId,
    operation: () => Promise<T>,
    authorityGuard: (operation: () => Promise<T>) => Promise<T>,
  ): Promise<T> {
    const tombstone = await this.local.projects.loadRetirementTombstone(projectId);
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
    return authorityGuard(operation);
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

  async assertLanToCloudSourceOwner(
    projectId: CollabProjectId,
    expectedAuthorityGeneration: number,
  ): Promise<void> {
    await this.hostInstallations.assertOwned(projectId, 'recover');
    const authority = await this.inspectAuthority(projectId);
    const project = await authority?.database.read(connection => authority.projects.get(connection));
    if (!project || project.authorityGeneration !== expectedAuthorityGeneration) {
      throw new CollabError({
        code: 'authority-transfer-stale',
        recoveryActions: ['retry'],
        safeContext: { reason: 'lan-to-cloud-source-generation-stale' },
      });
    }
  }

  async activateAuthorityTransferSourceRoute(
    projectId: CollabProjectId,
    options: CollabOperationOptions = {},
  ): Promise<() => Promise<void>> {
    this.#assertOpen();
    throwIfCancelled(options.signal);
    if (this.lanHost.isProjectRunning(projectId)) {
      return async () => undefined;
    }
    const authority = await this.inspectAuthority(projectId);
    throwIfCancelled(options.signal);
    if (!authority) {
      throw collabServiceError(
        'not-initialized',
        'authority-transfer-source-authority-missing',
      );
    }
    const project = await authority.database.read(connection => authority.projects.get(connection));
    throwIfCancelled(options.signal);
    if (!project || project.projectId !== projectId) {
      throw collabServiceError(
        'not-initialized',
        'authority-transfer-source-project-missing',
      );
    }
    const authenticator = new AuthorityMemberCredentialAuthenticator(authority.database);
    const service = this.#authorityTransferModule?.sourceActiveService({
      authorityGeneration: project.authorityGeneration,
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
      authorityGeneration: project.authorityGeneration,
      hostMemberId: project.hostMemberId,
      projectId,
      service,
      state: 'source-active',
    }, options);
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
    const membership = await this.#requireTrustedMembership(request.projectId);
    const transport = new PinnedCollabHttpClient(membership.trust, 10_000);
    try {
      const snapshot = await new ProjectControlClient(transport).readSnapshot(
        request.projectId,
        membership.credential,
        signal ? { signal } : {},
      );
      if (
        snapshot.project.id !== request.projectId
        || snapshot.currentMember.id !== membership.memberId
        || snapshot.currentMember.role !== 'manager'
      ) throw new CollabError({
        code: 'operation-failed',
        safeContext: { reason: 'retirement-manager-membership-mismatch' },
      });
      const intent = {
        expectedHostMemberId: snapshot.project.hostMemberId,
        managerActorMemberId: snapshot.currentMember.id,
        projectId: request.projectId,
      };
      const { idempotencyKey } = createRetirementIntent(intent);
      const operation = 'retireProject' as const;
      return await transport.requestWithMember({
        body: { ...intent, idempotencyKey },
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
    await this.#removeRetiredAuthority(projectId);
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
    await this.#removeRetiredAuthority(tombstone.projectId);
    this.retiredAuthorityCleanupComplete.add(tombstone.projectId);
    if (this.#retirementResponderCleanupPending.delete(tombstone.projectId)) {
      await this.#cleanupRetirementResponder(tombstone.projectId);
    }
  }

  async createAuthority(projectId: CollabProjectId, operationId?: string, resourceId?: string): Promise<CollabAuthorityFoundation> {
    this.#assertOpen();
    if (resourceId !== undefined) return this.openAuthority(projectId, operationId, resourceId);
    const capability = await this.hostInstallations.createOwned(projectId,
      operationId ? this.#setupResourceOperation(operationId) : null,
      operationId ? resource => this.#validateLegacySetupResource(resource, operationId) : undefined);
    return this.#openOwnedAuthority(capability);
  }

  runAuthorityProjectionTransition<T>(
    projectId: CollabProjectId,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.#authorityProjectionTransitions.run(projectId, operation);
  }

  async openAuthority(projectId: CollabProjectId, operationId?: string, resourceId?: string): Promise<CollabAuthorityFoundation> {
    this.#assertOpen();
    let capability = resourceId === undefined
      ? await this.hostInstallations.assertOwned(projectId, 'open')
      : await this.local.projects.assertOwnedAuthorityDirectory(projectId, undefined, resourceId);
    if (operationId !== undefined) {
      if (capability.operation === null) await this.#validateLegacySetupResource(capability, operationId);
      capability = await this.local.projects.bindOwnedAuthorityOperation(capability, this.#setupResourceOperation(operationId));
    }
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

   async #openOwnedAuthority(
    capability: OwnedAuthorityDirectoryCapability,
  ): Promise<CollabAuthorityFoundation> {
    const projectId = capability.projectId;
    const existing = this.authorityFoundations.get(projectId);
    if (existing) {
      const foundation = await existing;
      await this.local.projects.validateAuthorityDirectory(foundation.resource);
      if (foundation.resource.resourceId !== capability.resourceId) {
        throw new CollabError({ code: 'operation-failed', safeContext: { reason: 'authority-resource-mismatch' } });
      }
      return foundation;
    }
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
    operationId?: string,
    resourceId?: string,
  ): Promise<CollabAuthorityFoundation | null> {
    this.#assertOpen();
    const existing = this.authorityFoundations.get(projectId);
    if (existing && operationId === undefined && resourceId === undefined) {
      const foundation = await existing;
      await this.local.projects.validateAuthorityDirectory(foundation.resource);
      return foundation;
    }
    if (await this.hostInstallations.inspect(projectId) === 'absent') return null;
    return this.openAuthority(projectId, operationId, resourceId);
  }

  async discardProvisionalAuthority(projectId: CollabProjectId, operationId: string, resourceId?: string): Promise<void> {
    const operation = this.#setupResourceOperation(operationId);
    await this.local.projects.resumeAuthorityDirectoryRemovals(projectId, operation);
    if (await this.hostInstallations.inspect(projectId) === 'absent') return;
    if (resourceId !== undefined) await this.local.projects.assertOwnedAuthorityDirectory(projectId, undefined, resourceId);
    const capability = await this.hostInstallations.createOwned(projectId, operation,
      resource => this.#validateLegacySetupResource(resource, operationId));
    const existing = await this.authorityFoundations.get(projectId);
    if (existing && existing.resource.resourceId !== capability.resourceId) {
      throw new CollabError({ code: 'operation-failed', safeContext: { reason: 'authority-resource-mismatch' } });
    }
    await this.closeAuthority(projectId);
    await this.hostInstallations.removeOwned(capability, operation);
  }

  async #validateLegacySetupResource(resource: OwnedAuthorityDirectoryCapability, operationId: string): Promise<void> {
    const pending = await this.local.projects.loadProjectDocument(resource.projectId, 'pending-operation', decodeCollabProjectSetupRecord);
    if (!pending || pending.operationId !== operationId || pending.ownerInstallationKey !== this.installationKey
      || (pending.authorityResourceId !== undefined && pending.authorityResourceId !== resource.resourceId)) {
      throw new CollabError({ code: 'operation-failed', safeContext: { reason: 'authority-resource-operation-mismatch' } });
    }
    let matches = pending.phase === 'planned' || pending.phase === 'staged';
    await this.#createAuthorityDatabase(resource.authorityDirectory).inspectPersisted(connection => {
      const project = connection.get('SELECT project_id, name, host_member_id, manager_set_generation FROM project WHERE singleton = 1');
      if (project === null) {
        if (!matches) throw new CollabError({ code: 'operation-failed', safeContext: { reason: 'authority-resource-operation-mismatch' } });
        return;
      }
      const host = connection.get('SELECT credential_hash FROM members WHERE member_id = ?', [pending.memberId]);
      if (project.project_id !== pending.projectId || project.name !== pending.name
        || project.host_member_id !== pending.memberId || project.manager_set_generation !== 0
        || !(host?.credential_hash instanceof Uint8Array)
        || !Buffer.from(host.credential_hash).equals(createHash('sha256').update(pending.memberCredential, 'utf8').digest())) {
        throw new CollabError({ code: 'operation-failed', safeContext: { reason: 'authority-resource-operation-mismatch' } });
      }
      matches = true;
    });
    if (!matches) throw new CollabError({ code: 'operation-failed', safeContext: { reason: 'authority-resource-operation-mismatch' } });
    await this.closeAuthority(resource.projectId);
  }

  #setupResourceOperation(operationId: string): AuthorityResourceOperation {
    return { kind: 'setup', operationId, transferId: null, sourceGeneration: null, targetGeneration: 1 };
  }

  captureStoppedAuthority(projectId: CollabProjectId, expectedGeneration: number): Promise<OwnedAuthorityDirectoryCapability | null> {
    return this.hostInstallations.captureStoppedAuthority(projectId, expectedGeneration, {
      isServing: () => this.lanHost.isProjectRunning(projectId),
      readProject: async resource => {
        const foundation = await this.#openOwnedAuthority(resource);
        return foundation.database.read(connection => foundation.projects.get(connection));
      },
    });
  }

  async openAuthorityTransferTarget(
    record: AuthorityTransferRecord,
    validateLegacy?: (database: Pick<SqlJsProjectDatabase, 'inspectPersisted'>) => Promise<void>,
  ): Promise<CollabAuthorityFoundation> {
    this.#assertOpen();
    const operation = this.#targetResourceOperation(record);
    const recovered = await this.hostInstallations.recoverAuthorityTransferTarget(
      record.projectId, record.ownerInstallationKey, operation,
      validateLegacy ? directory => validateLegacy(this.#createAuthorityDatabase(directory)) : undefined,
    );
    const capability = recovered ?? await this.hostInstallations.prepareAuthorityTransferTarget(
      record.projectId, record.ownerInstallationKey, operation,
    );
    return this.#createAndOpenAuthority(capability);
  }

  async activateAuthorityTransferTarget(
    capability: ProvisionalAuthorityDirectoryCapability,
  ): Promise<CollabAuthorityFoundation> {
    this.#assertOpen();
    return this.#openOwnedAuthority(await this.hostInstallations.activateAuthorityTransferTarget(capability));
  }

  async inspectAuthorityTransferTarget(record: AuthorityTransferRecord): Promise<CollabAuthorityFoundation | null> {
    if (await this.hostInstallations.inspect(record.projectId) === 'absent') return null;
    this.hostInstallations.assertRecoveryOwner(record.ownerInstallationKey, record.projectId, 'authority-transfer-target');
    const capability = await this.local.projects.assertOwnedAuthorityDirectory(record.projectId, this.#targetResourceOperation(record));
    return this.#openOwnedAuthority(capability);
  }

  discardAuthorityTransferTarget(record: AuthorityTransferRecord, validateLegacy?: (database: Pick<SqlJsProjectDatabase, 'inspectPersisted'>) => Promise<void>): Promise<void> {
    return this.hostInstallations.discardAuthorityTransferTarget(
      record.projectId, record.ownerInstallationKey, this.#targetResourceOperation(record),
      validateLegacy ? directory => validateLegacy(this.#createAuthorityDatabase(directory)) : undefined,
    );
  }

  #targetResourceOperation(record: AuthorityTransferRecord): AuthorityResourceOperation {
    if (record.localRole !== 'target' || record.status.sourceAuthority.kind !== 'cloud'
      || record.status.targetAuthority.kind !== 'lan') {
      throw new CollabError({ code: 'operation-failed', safeContext: { reason: 'authority-resource-operation-mismatch' } });
    }
    return {
      kind: 'authority-transfer', operationId: record.operationIntentId, transferId: record.transferId,
      sourceGeneration: record.status.sourceAuthority.generation, targetGeneration: record.status.targetAuthority.generation,
    };
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
      installTransferTarget: async input => {
        this.hostInstallations.assertRecoveryOwner(input.record.ownerInstallationKey, input.record.projectId, 'host-transfer');
        const resource = await this.hostInstallations.bindTransferTarget(input.record.projectId, {
          kind: 'host-transfer', operationId: input.record.transferId, transferId: input.record.transferId,
          sourceGeneration: input.authorityGeneration, targetGeneration: input.authorityGeneration,
        }, input.validateLegacy);
        await this.local.projects.withAuthorityDirectory(resource, () => input.install(resource.authorityDirectory));
      },
      finalizeOldAuthority: (projectId, transferId, resource) => this.#finalizeTransferredSourceAuthority(projectId, transferId, resource),
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
    const database = this.#createAuthorityDatabase(authorityDirectory, operation => this.local.projects.withAuthorityDirectory(capability, operation));
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
      resource: capability,
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
    const resourceAdmission = <T>(operation: () => Promise<T>) => this.local.projects.withAuthorityDirectory(authority.resource, operation);
    const requestEnsure = new RequestEnsureService(
      authority.database,
      createRequestEnsureGitPolicy(repositoryPath, git.repositories, resourceAdmission),
    );
    const requestQuery = new RequestQueryService(
      authority.database,
      new RequestQueryGitPolicy(repositoryPath, git.repositories, resourceAdmission),
    );
    const requestComments = new RequestCommentService(authority.database);
    const ticketService = new TicketService(authority.database);
    const accept = new AcceptCoordinator(
      authority.database,
      new AcceptGitRepository(repositoryPath, git.repositories, undefined, resourceAdmission),
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
      resolveNumber: ticketService.resolveNumber.bind(ticketService),
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
      authorityGeneration: authorityProject.authorityGeneration,
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
      { installationKey: this.installationKey, resourceId: authority.resource.resourceId },
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
        resourceAdmission,
        baseEnvironment: this.#getEnvironment(),
        emptyConfigPath: await this.local.projects.ensureGitEmptyConfig(),
        gitExecutablePath: git.runtime.executablePath,
        gitHttpBackendPath,
        prepareMemberRef: memberId => this.local.projects.withAuthorityDirectory(capability, async () => {
          const ref = collabMemberRef(memberId);
          if (await git.repositories.resolveRef(repositoryPath, ref)) return;
          const mainOid = await readMainOid();
          try {
            await git.repositories.createRef(repositoryPath, ref, mainOid);
          } catch (error) {
            if (await git.repositories.resolveRef(repositoryPath, ref)) return;
            throw error;
          }
        }),
        repository: git.repositories,
      },
      lifecycle,
      ...(outgoingHostTransfer ? { outgoingHostTransfer } : {}),
      onPendingExpired: member => this.local.projects.withAuthorityDirectory(capability, async () => {
        const ref = collabMemberRef(member.id);
        const mainOid = await readMainOid();
        const memberOid = await git.repositories.resolveRef(repositoryPath, ref);
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
      }),
      readMainOid: () => this.local.projects.withAuthorityDirectory(capability, readMainOid),
      retireAuthority: async () => {
        await this.#removeRetiredAuthority(projectId, capability);
        this.retiredAuthorityCleanupComplete.add(projectId);
        if (this.#retirementResponderCleanupPending.delete(projectId)) {
          await this.#cleanupRetirementResponder(projectId);
        }
      },
      requests,
      tickets,
      validate: () => this.local.projects.withAuthorityDirectory(capability, () => git.repositories.assertHealthy(repositoryPath)),
    };
  }

   #assertOpen(): void {
    if (this.closed) throw collabServiceError('not-initialized', 'collab-service-closed');
  }

  async #finalizeTransferredSourceAuthority(
    projectId: CollabProjectId,
    transferId: string,
    captured?: OwnedAuthorityDirectoryCapability,
  ): Promise<void> {
    let record = await this.local.projects.hostTransferRecovery.load(projectId, 'outgoing');
    if (!record || record.transferId !== transferId || record.phase !== 'completed' || !record.targetTerminalResponseReceived) {
      throw new CollabError({ code: 'durable-progress-recovery-required', safeContext: { reason: 'host-transfer-source-cleanup-mismatch' } });
    }
    this.hostInstallations.assertRecoveryOwner(record.ownerInstallationKey, projectId, 'host-transfer');
    const operation: AuthorityResourceOperation = {
      kind: 'host-transfer', operationId: transferId, transferId, sourceGeneration: null, targetGeneration: null,
    };
    await this.local.projects.resumeAuthorityDirectoryRemovals(projectId, operation);
    if (await this.hostInstallations.inspect(projectId) === 'absent') return;
    const resource = captured ?? await this.hostInstallations.assertOwned(projectId, 'cleanup');
    await this.local.projects.validateOwnedAuthorityDirectory(resource);
    if (record.sourceResourceId !== undefined && record.sourceResourceId !== resource.resourceId) {
      throw new CollabError({ code: 'operation-failed', safeContext: { reason: 'authority-resource-mismatch' } });
    }
    const authority = await this.#openOwnedAuthority(resource);
    await new HostTransferAuthorityService(authority).assertSourceCleanupResource(record);
    if (record.sourceResourceId === undefined) {
      record = bindHostTransferSourceResource(record, resource.resourceId);
      await this.local.projects.hostTransferRecovery.save(record);
    }
    await this.closeAuthority(projectId);
    await this.hostInstallations.removeOwned(resource, operation);
  }

  async #removeRetiredAuthority(
    projectId: CollabProjectId,
    captured?: OwnedAuthorityDirectoryCapability,
  ): Promise<void> {
    const tombstone = await this.local.projects.loadRetirementTombstone(projectId);
    if (!tombstone) throw new CollabError({ code: 'operation-failed', safeContext: { reason: 'retirement-tombstone-missing' } });
    this.hostInstallations.assertRecoveryOwner(tombstone.ownerInstallationKey, projectId, 'retirement');
    const operation: AuthorityResourceOperation = {
      kind: 'retirement', operationId: tombstone.replay.idempotencyKey, transferId: null,
      sourceGeneration: null, targetGeneration: null,
    };
    await this.local.projects.resumeAuthorityDirectoryRemovals(projectId, operation);
    if (await this.hostInstallations.inspect(projectId) === 'absent') return;
    const resource = captured ?? await this.local.projects.assertOwnedAuthorityDirectory(projectId, undefined, tombstone.sourceResourceId);
    if (tombstone.sourceResourceId !== undefined && tombstone.sourceResourceId !== resource.resourceId) {
      throw new CollabError({ code: 'operation-failed', safeContext: { reason: 'authority-resource-mismatch' } });
    }
    const authority = await this.#openOwnedAuthority(resource);
    await new ProjectRetirementAuthorityService(authority.database, this.retirementTombstones, {
      installationKey: this.installationKey, resourceId: resource.resourceId,
    }).assertCleanupResource(tombstone);
    await this.retirementTombstones.bindSourceResource(tombstone, resource.resourceId);
    await this.closeAuthority(projectId);
    await this.hostInstallations.removeOwned(resource, operation);
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
  }

   async #requireTrustedMembership(projectId: CollabProjectId): Promise<{
    readonly credential: string;
    readonly memberId: string;
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
      memberId: membership.member.id,
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
