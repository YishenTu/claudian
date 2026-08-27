import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createServer,
  type Server as HttpsServer,
} from 'node:https';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { Duplex } from 'node:stream';

import {
  type CollabAuthorityRelinquishmentProof,
  type CollabMember,
  type CollabProjectId,
  isCollabProjectId,
} from '@claudian-collab/protocol';
import { WebSocket, WebSocketServer } from 'ws';

import { MembershipAdminService } from '@/app/collab/authority/MembershipAdminService';
import {
  resolveCollabVaultPath,
} from '@/app/collab/CollabFilesystemBoundary';
import type {
  CollabLocalLanMembershipRecord,
  CollabLocalProjectRepository,
} from '@/app/collab/CollabLocalProjectRepository';
import { isCollabLocalLanMembership } from '@/app/collab/CollabLocalProjectRepository';
import type {
  CollabLanAdvertisement,
  CollabLanDiscoveryPort,
} from '@/app/collab/discovery/CollabLanDiscoveryService';
import {
  LanAuthorityTransferRouter,
  type LanAuthorityTransferRouteRegistration,
  type LanAuthorityTransferRouteTransition,
  type LanAuthorityTransferSourceActiveService,
  type LanAuthorityTransferTerminalSourceService,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferRouter';
import { LanAuthorityTransferRouteRegistry } from '@/app/collab/lan/authority-transfer/LanAuthorityTransferRouteRegistry';
import { CollabControlRouter } from '@/app/collab/lan/CollabControlRouter';
import {
  isGitHttpRoute,
  parseGitHttpRoute,
} from '@/app/collab/lan/git/GitHttpRoute';
import {
  GitHttpBackendProxy,
  type GitHttpBackendProxyOptions,
} from '@/app/collab/lan/GitHttpBackendProxy';
import {
  type HostedLifecycleControlPort,
  HostedProjectControlService,
  type HostedRequestControlPort,
  type HostedTicketControlPort,
} from '@/app/collab/lan/HostedProjectControlService';
import { HostTransferLifecycleOrchestrator } from '@/app/collab/lan/HostTransferLifecycleOrchestrator';
import {
  type HostTransferProvisionalRegistration,
  HostTransferProvisionalRouter,
} from '@/app/collab/lan/HostTransferProvisionalRouter';
import { InvitationCodec } from '@/app/collab/lan/InvitationCodec';
import { COLLAB_CONTROL_MAX_BODY_BYTES, COLLAB_HOST_PORT_RANGE } from '@/app/collab/lan/LanCollabConstants';
import {
  fingerprintCertificatePem,
  type LanTlsHostCaSigner,
  LanTlsIdentity,
} from '@/app/collab/lan/LanTlsIdentity';
import {
  HostedProjectAdmissionGate,
} from '@/app/collab/lan/lifecycle/HostedProjectAdmissionGate';
import {
  type HostResourceCloser,
  HostResourceRegistry,
} from '@/app/collab/lan/lifecycle/HostResourceRegistry';
import {
  type PendingMembershipAuthority,
  PendingMembershipService,
} from '@/app/collab/lan/PendingMembershipService';
import type { ProjectEventSocket } from '@/app/collab/lan/ProjectEventHub';
import type {
  CollabTerminalProjectService,
} from '@/app/collab/lan/routes/RouteTypes';
import type {
  CollabProjectLifecycleAuthorityAdmission,
} from '@/app/collab/lifecycle/CollabProjectLifecycleAdmission';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import type { CollabRetirementResult } from '@/core/collab';
import { type CollabHostSession, type CollabHostStatus, type CollabInvitationView } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const HOST_LOCK_PATH = '.claudian/collab/lan-host.lock';
const HOST_LOCK_MAX_BYTES = 1_024;
const LISTENER_CLOSE_TIMEOUT_MS = 500;
const HOST_ADDRESS_CHECK_INTERVAL_MS = 2_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const AUTHORITY_TRANSFER_EXPIRY_RETRY_MS = 60_000;
const HOST_LOCK_NONCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ACTIVE_HOST_LOCK_NONCES = (() => {
  const key = Symbol.for('claudian.collab.active-host-lock-nonces');
  const scope = window as unknown as Record<PropertyKey, unknown>;
  const existing = scope[key];
  if (existing instanceof Set) return existing as Set<string>;
  const created = new Set<string>();
  scope[key] = created;
  return created;
})();

export interface LanHostGitProxy {
  close(): Promise<void>;
  enable(): Promise<void>;
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>;
}

export type LanHostGitRuntime = Pick<
  GitHttpBackendProxyOptions,
  | 'baseEnvironment'
  | 'emptyConfigPath'
  | 'gitExecutablePath'
  | 'gitHttpBackendPath'
  | 'prepareMemberRef'
  | 'repository'
>;

export interface LanHostProjectRuntime {
  readonly authorityTransfer?: LanAuthorityTransferSourceActiveService;
  readonly authority: PendingMembershipAuthority;
  readonly authorityDirectory: string;
  readonly events?: {
    close(): void;
    connect(
      socket: ProjectEventSocket,
      memberId: string,
      lastSequence: number,
    ): Promise<void>;
    hasAuthenticatedPresence(projectId: string, memberId: string): boolean;
    publishRetirement?(
      result: CollabRetirementResult,
    ): Promise<void>;
  };
  readonly git: LanHostGitRuntime;
  readonly lifecycle: Omit<HostedLifecycleControlPort, 'retireProject'> & {
    createRetirementCoordinator(input: {
      readonly projectLifecycleAdmission: CollabProjectLifecycleAuthorityAdmission;
      readonly admission: {
        quiesceAndDrain(projectId: CollabProjectId): Promise<void>;
        resume(projectId: CollabProjectId): Promise<void>;
      };
      activateTerminal(
        service: CollabTerminalProjectService,
      ): Promise<void>;
      deliver(result: CollabRetirementResult): Promise<void>;
      teardown(projectId: CollabProjectId): Promise<void>;
    }): Pick<HostedLifecycleControlPort, 'retireProject'>;
  };
  readonly onPendingExpired?: (member: CollabMember) => void | Promise<void>;
  readonly outgoingHostTransfer?: {
    cancelBeforeRelinquishment(
      projectId: CollabProjectId,
      transferId: string,
    ): Promise<void>;
    close(): Promise<void>;
    resume?(): Promise<void>;
    inspectStartupRecovery?(): Promise<
      | 'none'
      | 'post-relinquishment'
      | 'pre-relinquishment'
      | 'pre-relinquishment-cleanup'
    >;
    prepareTerminalRecoveryBeforeStartup?(): Promise<void>;
    prepareAccepted(
      projectId: CollabProjectId,
      transferId: string,
    ): Promise<void>;
    prepareCancellation(
      projectId: CollabProjectId,
      transferId: string,
    ): Promise<void>;
    run(
      projectId: CollabProjectId,
      transferId: string,
    ): Promise<void>;
  };
  readonly readMainOid: () => Promise<string>;
  readonly retireAuthority?: () => Promise<void>;
  readonly requests: HostedRequestControlPort;
  readonly tickets: HostedTicketControlPort;
  readonly validate: () => Promise<void>;
}

export interface LanHostCoordinatorOptions {
  readonly clearAuthorityTransferExpiryTimeout?: (handle: number) => void;
  readonly createAddressMonitor?: (
    check: () => Promise<void>,
  ) => HostAddressMonitor;
  readonly createInvitationCodec?: (address: string) => InvitationCodec;
  readonly createGitProxy?: (
    options: GitHttpBackendProxyOptions,
  ) => LanHostGitProxy;
  readonly getPrivateIpv4Addresses?: () => readonly string[];
  readonly discovery?: Pick<CollabLanDiscoveryPort, 'advertiseProject'>;
  readonly localProjects: Pick<
    CollabLocalProjectRepository,
    'ensurePrivateStateContainer' | 'hostTransferRecovery' | 'loadMembership' | 'saveMembership'
  >;
  readonly now?: () => Date;
  readonly openProject: (projectId: CollabProjectId) => Promise<LanHostProjectRuntime>;
  readonly portCandidates?: readonly number[];
  readonly resourceCloseTimeoutMs?: number;
  readonly runWithProjectStartGuard?: <T>(
    projectId: CollabProjectId,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly setAuthorityTransferExpiryTimeout?: (
    callback: () => void,
    milliseconds: number,
  ) => number;
  readonly tlsIdentity?: LanTlsIdentity;
  readonly vaultRoot: string;
}

export interface LanHostConnectionProjectionPort {
  resetProjectConnection(projectId: CollabProjectId): void;
}

export interface LanHostProjectLifecycleAdmissions {
  readonly hostTransfer: CollabProjectLifecycleAuthorityAdmission;
  readonly retirement: CollabProjectLifecycleAuthorityAdmission;
}

interface HostLockRecord {
  readonly nonce: string;
  readonly pid: number;
}

interface HeldHostLock extends HostLockRecord {
  readonly path: string;
  readonly handle: Awaited<ReturnType<typeof open>>;
}

interface RunningListener {
  readonly address: string;
  readonly caCertificatePem: string;
  readonly caFingerprint: string;
  readonly endpoint: string;
  readonly server: HttpsServer;
  readonly webSocketServer: WebSocketServer;
}

export interface HostAddressMonitor {
  close(): void;
}

interface HostedProject {
  readonly admission: HostedProjectAdmissionGate;
  advertisement?: CollabLanAdvertisement;
  readonly events?: LanHostProjectRuntime['events'];
  readonly gitProxy: LanHostGitProxy;
  readonly membership: CollabLocalLanMembershipRecord;
  readonly runtime: LanHostProjectRuntime;
  readonly service: PendingMembershipService;
}

export interface LanHostTerminalProjectRuntime {
  readonly projectId: CollabProjectId;
  readonly service: CollabTerminalProjectService;
}

interface TerminalProject {
  advertisement?: CollabLanAdvertisement;
  readonly service: CollabTerminalProjectService;
}

export interface LanHostProjectState {
  readonly endpoint?: string;
  readonly projectId: CollabProjectId;
  readonly status: Exclude<CollabHostStatus, 'not-host'>;
}

export interface LanHostProvisionalTransferSession {
  readonly caCertificatePem: string;
  readonly caFingerprint: string;
  readonly endpoint: string;
  readonly transferId: string;
}

export interface LanHostAuthorityTransferSession {
  readonly caCertificatePem: string;
  readonly caFingerprint: string;
  readonly endpoint: string;
  readonly projectId: CollabProjectId;
}

export interface LanHostAuthorityTransferPreparation {
  readonly caCertificatePem: string;
  readonly caFingerprint: string;
  readonly endpoint: string;
  dispose(): Promise<void>;
}

interface StartedHostShutdown {
  readonly gitDrains: readonly Promise<unknown>[];
  readonly listenerDrain: Promise<unknown>;
  readonly resourceDrain: Promise<unknown>;
  readonly transferDrains: readonly Promise<unknown>[];
}

function hostError(
  code:
    | 'authorization-denied'
    | 'durable-progress-recovery-required'
    | 'endpoint-unreachable'
    | 'host-stopped'
    | 'not-initialized'
    | 'operation-failed'
    | 'project-not-found'
    | 'project-retired'
    | 'tls-ca-mismatch',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'endpoint-unreachable'
      ? ['retry', 'open-diagnostics']
      : code === 'tls-ca-mismatch'
        ? ['open-diagnostics']
        : [],
    safeContext: { reason },
  });
}

function isPrivateIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function interfacePreference(name: string): number {
  const normalized = name.toLocaleLowerCase('en-US');
  if (/^(?:en\d+|eno|enp|ens|eth|wl|wi-?fi|ethernet)/.test(normalized)) return 0;
  if (/(?:awdl|bridge|docker|llw|tailscale|utun|vbox|virbr|vmnet|zerotier)/.test(
    normalized,
  )) {
    return 2;
  }
  return 1;
}

export function listPrivateIpv4Addresses(): readonly string[] {
  const addresses: Array<{ address: string; name: string }> = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      const ipv4 = entry.family === 'IPv4' || String(entry.family) === '4';
      if (ipv4 && !entry.internal && isPrivateIpv4(entry.address)) {
        addresses.push({ address: entry.address, name });
      }
    }
  }
  addresses.sort((left, right) => (
    interfacePreference(left.name) - interfacePreference(right.name)
    || left.name.localeCompare(right.name)
    || left.address.localeCompare(right.address)
  ));
  return [...new Set(addresses.map(entry => entry.address))];
}

function defaultPortCandidates(): readonly number[] {
  return Array.from(
    { length: COLLAB_HOST_PORT_RANGE.last - COLLAB_HOST_PORT_RANGE.first + 1 },
    (_, index) => COLLAB_HOST_PORT_RANGE.first + index,
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function parseHostLock(contents: string): HostLockRecord {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw hostError('authorization-denied', 'vault-host-lock-invalid');
  }
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || typeof (value as Record<string, unknown>).nonce !== 'string'
    || !HOST_LOCK_NONCE_PATTERN.test((value as Record<string, string>).nonce)
    || typeof (value as Record<string, unknown>).pid !== 'number'
    || !Number.isSafeInteger((value as Record<string, number>).pid)
    || (value as Record<string, number>).pid < 1
  ) {
    throw hostError('authorization-denied', 'vault-host-lock-invalid');
  }
  return {
    nonce: (value as Record<string, string>).nonce,
    pid: (value as Record<string, number>).pid,
  };
}

export class LanHostCoordinator {
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private addressCheckTask: Promise<void> | null = null;
  private addressMonitor: HostAddressMonitor | null = null;
  private readonly hostedProjects = new Map<CollabProjectId, HostedProject>();
  private readonly authorityTransferRoutes = new LanAuthorityTransferRouteRegistry();
  private readonly authorityTransferPreparations = new Set<symbol>();
  private readonly authorityTransferExpiryTimers = new Map<
    CollabProjectId,
    number
  >();
  private readonly authorityTransferRouter = new LanAuthorityTransferRouter(
    this.authorityTransferRoutes,
  );
  private readonly clearAuthorityTransferExpiryTimeout: (handle: number) => void;
  private hostLock: HeldHostLock | null = null;
  private listener: RunningListener | null = null;
  private listenerFailure: CollabError | null = null;
  private connectionProjection: LanHostConnectionProjectionPort | null = null;
  private readonly now: () => Date;
  private readonly operationQueue = new SerialTaskQueue();
  private readonly projectTransitions = new Map<
    CollabProjectId,
    Extract<CollabHostStatus, 'starting' | 'stopping'>
  >();
  private readonly provisionalTransfers = new HostTransferProvisionalRouter();
  private projectLifecycleAdmissions: LanHostProjectLifecycleAdmissions | null = null;
  private readonly recoveringHostTransfers = new Map<
    CollabProjectId,
    NonNullable<LanHostProjectRuntime['outgoingHostTransfer']>
  >();
  private readonly resources: HostResourceRegistry;
  private readonly setAuthorityTransferExpiryTimeout: (
    callback: () => void,
    milliseconds: number,
  ) => number;
  private readonly router = new CollabControlRouter();
  private readonly terminalProjects = new Map<CollabProjectId, TerminalProject>();
  private readonly terminalizingProjects = new Set<CollabProjectId>();
  private readonly transferredProjects = new Map<CollabProjectId, HostedProject>();
  private readonly tlsIdentity: LanTlsIdentity;

  constructor(private readonly options: LanHostCoordinatorOptions) {
    this.clearAuthorityTransferExpiryTimeout = options.clearAuthorityTransferExpiryTimeout
      ?? (handle => window.clearTimeout(handle));
    this.now = options.now ?? (() => new Date());
    this.resources = new HostResourceRegistry({
      ...(options.resourceCloseTimeoutMs === undefined
        ? {}
        : { closeTimeoutMs: options.resourceCloseTimeoutMs }),
    });
    this.setAuthorityTransferExpiryTimeout = options.setAuthorityTransferExpiryTimeout
      ?? ((callback, milliseconds) => window.setTimeout(callback, milliseconds));
    this.tlsIdentity = options.tlsIdentity ?? new LanTlsIdentity(options.vaultRoot);
  }

  bindConnectionProjection(projection: LanHostConnectionProjectionPort): void {
    if (this.connectionProjection) {
      throw new Error('LAN Host connection projection is already bound');
    }
    this.connectionProjection = projection;
  }

  bindProjectLifecycleAdmissions(admissions: LanHostProjectLifecycleAdmissions): void {
    if (this.projectLifecycleAdmissions) {
      throw new Error('LAN Host Project lifecycle admissions are already bound');
    }
    this.projectLifecycleAdmissions = admissions;
  }

  startProject(projectId: CollabProjectId): Promise<CollabHostSession & { endpoint: string }> {
    this.projectTransitions.set(projectId, 'starting');
    const operation = () => this.operationQueue.run(() => this.startProjectUnlocked(projectId));
    const guarded = this.options.runWithProjectStartGuard
      ? this.options.runWithProjectStartGuard(projectId, operation)
      : operation();
    return this.withTransition(
      projectId,
      'starting',
      guarded,
    );
  }

  stopProject(projectId: CollabProjectId): Promise<CollabHostSession> {
    this.projectTransitions.set(projectId, 'stopping');
    const operation = (async () => {
      const outgoing = await this.operationQueue.run(async () => {
        const current = this.hostedProjects.get(projectId)?.runtime.outgoingHostTransfer
          ?? this.transferredProjects.get(projectId)?.runtime.outgoingHostTransfer
          ?? this.recoveringHostTransfers.get(projectId);
        if (current) this.router.unregisterProject(projectId);
        return current;
      });
      await outgoing?.close();
      return this.operationQueue.run(() => this.stopProjectUnlocked(projectId));
    })();
    return this.withTransition(
      projectId,
      'stopping',
      operation,
    );
  }

  createInvitation(projectId: CollabProjectId): Promise<CollabInvitationView> {
    return this.operationQueue.run(async () => {
      const hosted = this.requireHostedProject(projectId);
      const membership = await this.requireHostMembership(projectId);
      const invitation = await hosted.service.createInvitation(
        membership.member.credential,
        {
          idempotencyKey: `invite-${randomUUID().replaceAll('-', '')}`,
          projectId,
        },
      );
      return {
        encodedInvitation: hosted.service.encodeInvitation(invitation),
        expiresAt: invitation.expiresAt,
      };
    });
  }

  revokeInvitation(projectId: CollabProjectId): Promise<void> {
    return this.operationQueue.run(async () => {
      const hosted = this.requireHostedProject(projectId);
      const membership = await this.requireHostMembership(projectId);
      await hosted.service.revokeInvitation(membership.member.credential, {
        idempotencyKey: `revoke-${randomUUID().replaceAll('-', '')}`,
        projectId,
      });
    });
  }

  startProvisionalTransfer(
    registration: HostTransferProvisionalRegistration,
  ): Promise<LanHostProvisionalTransferSession> {
    return this.operationQueue.run(async () => {
      this.assertOpen();
      const firstListenerOwner = !this.listener
        && this.hostedProjects.size === 0
        && this.terminalProjects.size === 0
        && this.provisionalTransfers.size === 0
        && this.authorityTransferRoutes.size === 0;
      if (firstListenerOwner) await this.acquireHostLock();
      try {
        if (!this.listener) this.listener = await this.startListener();
        this.assertOpen();
        this.provisionalTransfers.register(registration);
        return {
          caCertificatePem: this.listener.caCertificatePem,
          caFingerprint: this.listener.caFingerprint,
          endpoint: this.listener.endpoint,
          transferId: registration.transferId,
        };
      } catch (error) {
        if (firstListenerOwner && this.hostedProjects.size === 0
          && this.terminalProjects.size === 0
          && this.provisionalTransfers.size === 0
          && this.authorityTransferRoutes.size === 0) {
          await this.closeListenerAndLock().catch(() => undefined);
        }
        throw error;
      }
    });
  }

  stopProvisionalTransfer(transferId: string): Promise<void> {
    return this.operationQueue.run(async () => {
      this.provisionalTransfers.unregister(transferId);
      await this.closeUnusedListener();
    });
  }

  startAuthorityTransferRoute(
    registration: LanAuthorityTransferRouteRegistration,
  ): Promise<LanHostAuthorityTransferSession> {
    return this.operationQueue.run(async () => {
      this.assertOpen();
      const firstListenerOwner = !this.listener
        && this.hostedProjects.size === 0
        && this.terminalProjects.size === 0
        && this.provisionalTransfers.size === 0
        && this.authorityTransferRoutes.size === 0;
      if (firstListenerOwner) await this.acquireHostLock();
      try {
        const expectedEndpoint = registration.expectedEndpoint
          ?? (registration.state === 'source-active' ? null : (this.listener?.endpoint ?? null));
        if (!this.listener) this.listener = await this.startListener(expectedEndpoint);
        this.assertOpen();
        if (expectedEndpoint !== null && this.listener.endpoint !== expectedEndpoint) {
          throw hostError(
            'endpoint-unreachable',
            'authority-transfer-expected-endpoint-unavailable',
          );
        }
        const current = this.authorityTransferRoutes.resolve(registration.projectId);
        if (
          (
            current?.state === 'terminal-source'
            && registration.state === 'terminal-source'
            && current.transferId === registration.transferId
          )
          || (
            current?.state === 'target-active'
            && registration.state === 'target-active'
            && current.transferId === registration.transferId
          )
        ) {
          return {
            caCertificatePem: this.listener.caCertificatePem,
            caFingerprint: this.listener.caFingerprint,
            endpoint: this.listener.endpoint,
            projectId: registration.projectId,
          };
        }
        await this.authorityTransferRoutes.install(registration);
        this.scheduleAuthorityTransferExpiry(registration);
        this.startAddressMonitor();
        return {
          caCertificatePem: this.listener.caCertificatePem,
          caFingerprint: this.listener.caFingerprint,
          endpoint: this.listener.endpoint,
          projectId: registration.projectId,
        };
      } catch (error) {
        if (firstListenerOwner) await this.closeUnusedListener().catch(() => undefined);
        throw error;
      }
    });
  }

  transitionAuthorityTransferRoute(
    transition: LanAuthorityTransferRouteTransition,
  ): Promise<LanHostAuthorityTransferSession> {
    return this.operationQueue.run(async () => {
      this.assertOpen();
      if (!this.listener) {
        throw hostError('operation-failed', 'authority-transfer-listener-missing');
      }
      const expectedEndpoint = transition.next.state === 'source-active'
        ? null
        : (transition.next.expectedEndpoint ?? this.listener.endpoint);
      if (expectedEndpoint !== null && this.listener.endpoint !== expectedEndpoint) {
        throw hostError(
          'endpoint-unreachable',
          'authority-transfer-expected-endpoint-unavailable',
        );
      }
      await this.authorityTransferRoutes.transition(transition);
      this.scheduleAuthorityTransferExpiry(transition.next);
      return {
        caCertificatePem: this.listener.caCertificatePem,
        caFingerprint: this.listener.caFingerprint,
        endpoint: this.listener.endpoint,
        projectId: transition.next.projectId,
      };
    });
  }

  stopAuthorityTransferRoute(
    projectId: CollabProjectId,
    expectedState?: LanAuthorityTransferRouteRegistration['state'],
  ): Promise<void> {
    return this.operationQueue.run(async () => {
      const removed = await this.authorityTransferRoutes.remove(projectId, expectedState);
      if (removed) this.clearAuthorityTransferExpiry(projectId);
      await this.closeUnusedListener();
    });
  }

  pinAuthorityTransferSourceEndpoint(projectId: CollabProjectId): Promise<string> {
    return this.operationQueue.run(async () => {
      this.assertOpen();
      if (!this.listener) {
        throw hostError('endpoint-unreachable', 'authority-transfer-listener-missing');
      }
      const endpoint = this.listener.endpoint;
      this.authorityTransferRoutes.pinSourceActiveEndpoint(projectId, endpoint);
      return endpoint;
    });
  }

  unpinAuthorityTransferSourceEndpoint(
    projectId: CollabProjectId,
    expectedEndpoint: string,
  ): Promise<void> {
    return this.operationQueue.run(async () => {
      this.authorityTransferRoutes.unpinSourceActiveEndpoint(projectId, expectedEndpoint);
    });
  }

  prepareAuthorityTransferTarget(
    expectedEndpoint: string | null = null,
  ): Promise<LanHostAuthorityTransferPreparation> {
    return this.operationQueue.run(async () => {
      this.assertOpen();
      const token = Symbol('authority-transfer-target');
      const firstListenerOwner = !this.listener
        && this.hostedProjects.size === 0
        && this.terminalProjects.size === 0
        && this.provisionalTransfers.size === 0
        && this.authorityTransferRoutes.size === 0
        && this.authorityTransferPreparations.size === 0;
      if (firstListenerOwner) await this.acquireHostLock();
      try {
        if (!this.listener) this.listener = await this.startListener(expectedEndpoint);
        this.assertOpen();
        if (expectedEndpoint !== null && this.listener.endpoint !== expectedEndpoint) {
          throw hostError(
            'endpoint-unreachable',
            'authority-transfer-expected-endpoint-unavailable',
          );
        }
        this.authorityTransferPreparations.add(token);
        this.startAddressMonitor();
        const listener = this.listener;
        return Object.freeze({
          caCertificatePem: listener.caCertificatePem,
          caFingerprint: listener.caFingerprint,
          dispose: () => this.releaseAuthorityTransferPreparation(token),
          endpoint: listener.endpoint,
        });
      } catch (error) {
        if (firstListenerOwner) await this.closeUnusedListener().catch(() => undefined);
        throw error;
      }
    });
  }

  hostCaSigner(): Promise<LanTlsHostCaSigner> {
    return this.tlsIdentity.hostCaSigner();
  }

  quiesceProjectForHostTransfer(
    projectId: CollabProjectId,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.operationQueue.run(async () => {
      if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
      const hosted = this.requireHostedProject(projectId);
      await hosted.admission.quiesceAndDrain('transferred');
      if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
    });
  }

  quiesceProjectForAuthorityTransfer(
    projectId: CollabProjectId,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.operationQueue.run(async () => {
      if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
      const hosted = this.requireHostedProject(projectId);
      await hosted.admission.quiesceAndDrain('transferred');
      if (signal?.aborted) throw new CollabError({ code: 'cancelled' });
    });
  }

  reopenProjectBeforeHostTransfer(projectId: CollabProjectId): Promise<void> {
    return this.operationQueue.run(async () => {
      const hosted = this.requireHostedProject(projectId);
      hosted.admission.reopen();
    });
  }

  reopenProjectAfterAuthorityTransferCancellation(projectId: CollabProjectId): Promise<void> {
    return this.operationQueue.run(async () => {
      const hosted = this.requireHostedProject(projectId);
      hosted.admission.reopen();
    });
  }

  closeProjectForHostTransfer(projectId: CollabProjectId): Promise<void> {
    return this.closeHostedProjectForTransfer(projectId, true);
  }

  relinquishProjectForAuthorityTransfer(projectId: CollabProjectId): Promise<void> {
    return this.closeHostedProjectForTransfer(projectId, false);
  }

  activateAuthorityTransferTerminalSource(input: {
    readonly expectedEndpoint: string;
    readonly projectId: CollabProjectId;
    readonly relinquishmentProof: CollabAuthorityRelinquishmentProof;
    readonly service: LanAuthorityTransferTerminalSourceService;
    readonly transferId: string;
  }): Promise<LanHostAuthorityTransferSession> {
    return this.operationQueue.run(async () => {
      this.assertOpen();
      if (!this.listener) {
        throw hostError('operation-failed', 'authority-transfer-listener-missing');
      }
      if (this.listener.endpoint !== input.expectedEndpoint) {
        throw hostError(
          'endpoint-unreachable',
          'authority-transfer-expected-endpoint-unavailable',
        );
      }
      const current = this.authorityTransferRoutes.resolve(input.projectId);
      if (
        current?.state === 'terminal-source'
        && current.transferId === input.transferId
      ) {
        return {
          caCertificatePem: this.listener.caCertificatePem,
          caFingerprint: this.listener.caFingerprint,
          endpoint: this.listener.endpoint,
          projectId: input.projectId,
        };
      }
      if (current?.state !== 'source-active') {
        throw hostError('operation-failed', 'authority-transfer-source-route-missing');
      }
      const next: LanAuthorityTransferRouteRegistration = {
        expectedEndpoint: input.expectedEndpoint,
        projectId: input.projectId,
        service: input.service,
        state: 'terminal-source',
        transferId: input.transferId,
      };
      await this.authorityTransferRoutes.transition({
        expected: current,
        next,
        relinquishmentProof: input.relinquishmentProof,
      });
      this.scheduleAuthorityTransferExpiry(next);
      return {
        caCertificatePem: this.listener.caCertificatePem,
        caFingerprint: this.listener.caFingerprint,
        endpoint: this.listener.endpoint,
        projectId: input.projectId,
      };
    });
  }

  completeProjectHostTransfer(projectId: CollabProjectId): Promise<void> {
    return this.operationQueue.run(async () => {
      this.transferredProjects.delete(projectId);
      await this.closeUnusedListener();
    });
  }

  private closeHostedProjectForTransfer(
    projectId: CollabProjectId,
    removeAuthorityTransferRoute: boolean,
  ): Promise<void> {
    return this.operationQueue.run(async () => {
      if (this.transferredProjects.has(projectId)) return;
      const hosted = this.hostedProjects.get(projectId);
      if (!hosted) return;
      hosted.admission.commitTerminal('transferred');
      this.router.unregisterProject(projectId);
      if (removeAuthorityTransferRoute) {
        await this.authorityTransferRoutes.remove(projectId, 'source-active');
      }
      this.hostedProjects.delete(projectId);
      this.transferredProjects.set(projectId, hosted);
      let firstError: unknown;
      await hosted.advertisement?.stop().catch(error => {
        firstError = error;
      });
      hosted.events?.close();
      await hosted.gitProxy.close().catch(error => {
        firstError ??= error;
      });
      await this.closeProjectResources(projectId).catch(error => {
        firstError ??= error;
      });
      await this.closeUnusedListener().catch(error => {
        firstError ??= error;
      });
      if (firstError instanceof Error) throw firstError;
      if (firstError) throw hostError('operation-failed', 'authority-transfer-route-close-failed');
    });
  }

  isProjectRunning(projectId: CollabProjectId): boolean {
    return this.hostedProjects.has(projectId);
  }

  getProjectState(projectId: CollabProjectId): LanHostProjectState {
    const transition = this.projectTransitions.get(projectId);
    if (transition) return { projectId, status: transition };
    if (this.listenerFailure) return { projectId, status: 'needs-attention' };
    if (this.hostedProjects.has(projectId) && this.listener) {
      return {
        endpoint: this.listener.endpoint,
        projectId,
        status: 'running',
      };
    }
    return { projectId, status: 'stopped' };
  }

  registerOwnedResource(
    projectId: CollabProjectId,
    memberId: string,
    close: HostResourceCloser,
  ): () => void {
    if (!this.hostedProjects.has(projectId)) {
      throw hostError('project-not-found', 'host-project-not-running');
    }
    return this.resources.register(projectId, memberId, close);
  }

  registerTerminalProject(runtime: LanHostTerminalProjectRuntime): void {
    this.router.registerTerminalProject(runtime.projectId, runtime.service);
    const existing = this.terminalProjects.get(runtime.projectId);
    if (existing && existing.service !== runtime.service) {
      throw hostError('operation-failed', 'host-terminal-project-already-registered');
    }
    this.terminalProjects.set(runtime.projectId, existing ?? { service: runtime.service });
  }

  unregisterTerminalProject(projectId: CollabProjectId): boolean {
    this.terminalProjects.delete(projectId);
    return this.router.unregisterTerminalProject(projectId);
  }

  startTerminalProject(runtime: LanHostTerminalProjectRuntime): Promise<void> {
    return this.operationQueue.run(async () => {
      this.assertOpen();
      const existing = this.terminalProjects.get(runtime.projectId);
      if (existing) {
        if (existing.service !== runtime.service) {
          throw hostError('operation-failed', 'host-terminal-project-already-registered');
        }
        return;
      }
      const firstListenerOwner = !this.listener
        && this.hostedProjects.size === 0
        && this.terminalProjects.size === 0
        && this.provisionalTransfers.size === 0
        && this.authorityTransferRoutes.size === 0;
      if (firstListenerOwner) await this.acquireHostLock();
      try {
        if (!this.listener) this.listener = await this.startListener();
        this.assertOpen();
        const listener = this.listener;
        this.registerTerminalProject(runtime);
        const terminal = this.terminalProjects.get(runtime.projectId)!;
        terminal.advertisement = await this.options.discovery?.advertiseProject({
          caFingerprint: listener.caFingerprint,
          endpoint: listener.endpoint,
          projectId: runtime.projectId,
        }).catch(() => undefined);
        this.startAddressMonitor();
      } catch (error) {
        this.unregisterTerminalProject(runtime.projectId);
        if (firstListenerOwner) await this.closeUnusedListener().catch(() => undefined);
        throw error;
      }
    });
  }

  stopTerminalProject(projectId: CollabProjectId): Promise<void> {
    return this.operationQueue.run(async () => {
      const terminal = this.terminalProjects.get(projectId);
      if (!terminal) return;
      this.unregisterTerminalProject(projectId);
      await terminal.advertisement?.stop().catch(() => undefined);
      await this.closeUnusedListener();
    });
  }

  closeMemberResources(projectId: CollabProjectId, memberId: string): Promise<void> {
    return this.resources.closeMember(projectId, memberId, 'access-removed');
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.provisionalTransfers.clear();
    this.stopAddressMonitor();
    for (const projectId of this.hostedProjects.keys()) {
      this.projectTransitions.set(projectId, 'stopping');
    }
    const started = this.beginShutdown();
    this.closePromise = (async () => {
      const transferErrors = await Promise.all(started.transferDrains);
      return this.operationQueue.run(async () => {
        const hosted = [...this.hostedProjects.entries()];
        const terminal = [...this.terminalProjects.entries()];
        let firstError: unknown = transferErrors.find(error => error !== null) ?? null;
        for (const [projectId, project] of hosted) {
          try {
            await project.service.stopHosting();
          } catch (error) {
            firstError ??= error;
          }
          this.hostedProjects.delete(projectId);
        }
        for (const [projectId, project] of terminal) {
          this.unregisterTerminalProject(projectId);
          await project.advertisement?.stop().catch(error => {
            firstError ??= error;
          });
        }
        // The queue is the final resource authority: queued work that began
        // before close() may have published replacement listeners, endpoint
        // persistence, advertisements, or provisional transfers after
        // beginShutdown captured its drains. Tear down the current state.
        for (const [, project] of hosted) {
          await project.advertisement?.stop().catch(error => {
            firstError ??= error;
          });
        }
        this.provisionalTransfers.clear();
        await this.closeListenerAndLock().catch(error => {
          firstError ??= error;
        });
        for (const drain of [
          ...started.gitDrains,
          started.resourceDrain,
          started.listenerDrain,
        ]) {
          const error = await drain;
          if (error) firstError ??= error;
        }
        this.projectTransitions.clear();
        this.recoveringHostTransfers.clear();
        this.transferredProjects.clear();
        if (firstError instanceof Error) throw firstError;
        if (firstError) throw hostError('operation-failed', 'lan-host-close-failed');
      });
    })();
    return this.closePromise;
  }

  private async startProjectUnlocked(
    projectId: CollabProjectId,
  ): Promise<CollabHostSession & { endpoint: string }> {
    this.assertOpen();
    if (!isCollabProjectId(projectId)) {
      throw hostError('project-not-found', 'host-project-id-invalid');
    }
    if (this.terminalizingProjects.has(projectId) || this.terminalProjects.has(projectId)) {
      throw hostError('project-retired', 'host-project-terminal');
    }
    if (this.listenerFailure) throw this.listenerFailure;
    const existing = this.hostedProjects.get(projectId);
    if (existing && this.listener) {
      return { endpoint: this.listener.endpoint, projectId, status: 'running' };
    }
    if (this.recoveringHostTransfers.has(projectId)) {
      throw hostError(
        'durable-progress-recovery-required',
        'host-transfer-post-relinquishment-recovery-in-progress',
      );
    }
    const incomingRecovery = await this.options.localProjects.hostTransferRecovery.load(
      projectId,
      'incoming',
    );
    this.assertOpen();
    if (incomingRecovery) {
      const membership = await this.options.localProjects.loadMembership(projectId);
      this.assertOpen();
      if (
        !membership
        || !isCollabLocalLanMembership(membership)
        || !membership.hostOwnership.ownsAuthority
      ) {
        throw hostError(
          'durable-progress-recovery-required',
          'host-transfer-incoming-recovery-required',
        );
      }
    }

    const membership = await this.requireLanMembership(projectId);
    this.assertOpen();
    const firstListenerOwner = !this.listener
      && this.hostedProjects.size === 0
      && this.terminalProjects.size === 0
      && this.provisionalTransfers.size === 0
      && this.authorityTransferRoutes.size === 0;
    if (firstListenerOwner) {
      await this.acquireHostLock();
      this.assertOpen();
    }
    let routeRegistered = false;
    let authorityTransferRouteRegistered = false;
    let advertisement: CollabLanAdvertisement | undefined;
    let gitProxy: LanHostGitProxy | null = null;
    let runtime: LanHostProjectRuntime | null = null;
    try {
      const openedRuntime = await this.options.openProject(projectId);
      runtime = openedRuntime;
      this.assertOpen();
      await openedRuntime.validate();
      this.assertOpen();
      const transferRecovery = await openedRuntime.outgoingHostTransfer
        ?.inspectStartupRecovery?.();
      this.assertOpen();
      if (transferRecovery === 'pre-relinquishment-cleanup') {
        const outgoingHostTransfer = openedRuntime.outgoingHostTransfer;
        if (!outgoingHostTransfer?.prepareTerminalRecoveryBeforeStartup) {
          throw hostError(
            'durable-progress-recovery-required',
            'host-transfer-terminal-recovery-unavailable',
          );
        }
        await outgoingHostTransfer.prepareTerminalRecoveryBeforeStartup();
      }
      if (transferRecovery === 'post-relinquishment') {
        const outgoingHostTransfer = openedRuntime.outgoingHostTransfer!;
        this.recoveringHostTransfers.set(projectId, outgoingHostTransfer);
        queueMicrotask(() => {
          void outgoingHostTransfer.resume?.()
            .catch(() => undefined)
            .finally(() => {
              if (this.recoveringHostTransfers.get(projectId) === outgoingHostTransfer) {
                this.recoveringHostTransfers.delete(projectId);
              }
            });
        });
        throw hostError(
          'durable-progress-recovery-required',
          'host-transfer-post-relinquishment-recovery',
        );
      }
      if (!membership.hostOwnership.ownsAuthority) {
        throw hostError('authorization-denied', 'host-membership-required');
      }
      const authorityProject = await openedRuntime.authority.database.read(connection => (
        openedRuntime.authority.projects.get(connection)
      ));
      if (
        !authorityProject
        || authorityProject.projectId !== projectId
        || authorityProject.hostMemberId !== membership.member.id
      ) {
        throw hostError('authorization-denied', 'host-authority-ownership-mismatch');
      }
      if (!this.listener) this.listener = await this.startListener();
      this.assertOpen();
      const listener = this.listener;
      if (
        membership.authority.hostCaFingerprint !== null
        && (
          membership.authority.hostCaFingerprint !== listener.caFingerprint
          || !membership.authority.hostCaCertificatePem
          || fingerprintCertificatePem(membership.authority.hostCaCertificatePem)
            !== listener.caFingerprint
        )
      ) {
        throw hostError('tls-ca-mismatch', 'stored-host-ca-mismatch');
      }
      const codec = this.options.createInvitationCodec?.(listener.address)
        ?? new InvitationCodec();
      const service = new PendingMembershipService(openedRuntime.authority, {
        getHostEndpoint: () => this.currentHostEndpoint(),
        getInvitationCodec: () => {
          const address = this.listener?.address ?? listener.address;
          return this.options.createInvitationCodec?.(address) ?? new InvitationCodec();
        },
        invitationCodec: codec,
        now: this.now,
        onPendingExpired: async member => {
          await this.resources.closeMember(projectId, member.id, 'pending-expired');
          await openedRuntime.onPendingExpired?.(member);
        },
        readMainOid: openedRuntime.readMainOid,
      });
      await service.garbageCollectExpiredPending();
      gitProxy = this.createGitProxy(projectId, openedRuntime, service);
      await gitProxy.enable();
      this.assertOpen();
      const hostedMembership: CollabLocalLanMembershipRecord = {
        ...membership,
        authority: {
          endpoint: listener.endpoint,
          gitRemoteUrl: `${listener.endpoint}/v1/git/${projectId}/repository.git`,
          hostCaCertificatePem: listener.caCertificatePem,
          hostCaFingerprint: listener.caFingerprint,
          kind: 'lan',
        },
        hostOwnership: { autoStart: true, ownsAuthority: true },
        updatedAt: this.now().toISOString(),
      };
      await this.options.localProjects.saveMembership(hostedMembership);
      this.assertOpen();
      const administration = new MembershipAdminService(openedRuntime.authority, {
        now: this.now,
        onMembershipTerminated: result => (
          this.closeMemberResources(projectId, result.memberId)
        ),
        presence: openedRuntime.events ?? undefined,
      });
      const admission = new HostedProjectAdmissionGate();
      if (
        transferRecovery === 'pre-relinquishment'
        || transferRecovery === 'pre-relinquishment-cleanup'
      ) {
        await admission.quiesceAndDrain('transferred');
      }
      const hostTransferLifecycle = openedRuntime.outgoingHostTransfer
        ? new HostTransferLifecycleOrchestrator(
            openedRuntime.lifecycle,
            openedRuntime.outgoingHostTransfer,
            {
              projectLifecycleAdmission: (admissionProjectId, operation) => (
                this.requireProjectLifecycleAdmissions().hostTransfer(
                  admissionProjectId,
                  operation,
                )
              ),
            },
          )
        : null;
      const lifecycle = {
        ...openedRuntime.lifecycle,
        ...(hostTransferLifecycle ? {
          acceptHostTransfer: hostTransferLifecycle.acceptHostTransfer.bind(
            hostTransferLifecycle,
          ),
          cancelHostTransfer: hostTransferLifecycle.cancelHostTransfer.bind(
            hostTransferLifecycle,
          ),
        } : {}),
        ...openedRuntime.lifecycle.createRetirementCoordinator({
          projectLifecycleAdmission: (admissionProjectId, operation) => (
            this.requireProjectLifecycleAdmissions().retirement(
              admissionProjectId,
              operation,
            )
          ),
          admission: {
            quiesceAndDrain: async () => {
              await this.beginRetirement(projectId);
              try {
                await admission.quiesceAndDrain('retired');
              } catch (error) {
                await this.resumeRetirement(projectId).catch(() => undefined);
                throw error;
              }
            },
            resume: async () => {
              admission.reopen();
              await this.resumeRetirement(projectId);
            },
          },
          activateTerminal: async terminal => {
            await this.startTerminalProject({ projectId, service: terminal });
          },
          deliver: async result => {
            // Delivery is best-effort; durable terminal fallback remains authoritative.
            await openedRuntime.events?.publishRetirement?.(result);
          },
          teardown: async () => {
            await this.retireActiveProject(projectId, admission);
          },
        }),
      };
      const controlService = new HostedProjectControlService(
        service,
        openedRuntime.requests,
        administration,
        openedRuntime.tickets,
        lifecycle,
        admission,
      );
      this.router.registerProject(
        projectId,
        controlService,
        controlService.routing,
      );
      routeRegistered = true;
      if (openedRuntime.authorityTransfer) {
        const existingAuthorityTransferRoute = this.authorityTransferRoutes.resolve(projectId);
        if (
          existingAuthorityTransferRoute?.state === 'source-active'
          && existingAuthorityTransferRoute.hostMemberId !== hostedMembership.member.id
        ) {
          throw hostError(
            'operation-failed',
            'authority-transfer-route-host-mismatch',
          );
        }
        if (existingAuthorityTransferRoute?.state !== 'source-active') {
          if (existingAuthorityTransferRoute) {
            throw hostError(
              'operation-failed',
              'authority-transfer-route-conflict',
            );
          }
          await this.authorityTransferRoutes.install({
            hostMemberId: hostedMembership.member.id,
            projectId,
            service: openedRuntime.authorityTransfer,
            state: 'source-active',
          });
          authorityTransferRouteRegistered = true;
        }
      }
      advertisement = await this.options.discovery?.advertiseProject({
        caFingerprint: listener.caFingerprint,
        endpoint: listener.endpoint,
        projectId,
      }).catch(() => undefined);
      this.assertOpen();
      this.hostedProjects.set(projectId, {
        admission,
        ...(advertisement ? { advertisement } : {}),
        ...(openedRuntime.events ? { events: openedRuntime.events } : {}),
        gitProxy,
        membership: hostedMembership,
        runtime: openedRuntime,
        service,
      });
      if (openedRuntime.outgoingHostTransfer?.resume) {
        queueMicrotask(() => {
          void openedRuntime.outgoingHostTransfer!.resume!().catch(() => undefined);
        });
      }
      this.startAddressMonitor();
      return { endpoint: listener.endpoint, projectId, status: 'running' };
    } catch (error) {
      if (authorityTransferRouteRegistered) {
        await this.authorityTransferRoutes.remove(projectId, 'source-active')
          .catch(() => undefined);
      }
      if (routeRegistered) this.router.unregisterProject(projectId);
      await advertisement?.stop().catch(() => undefined);
      runtime?.events?.close();
      await gitProxy?.close().catch(() => undefined);
      if (firstListenerOwner && this.hostedProjects.size === 0) {
        await this.closeUnusedListener().catch(() => undefined);
      }
      throw error;
    }
  }

  private requireProjectLifecycleAdmissions(): LanHostProjectLifecycleAdmissions {
    if (!this.projectLifecycleAdmissions) {
      throw hostError('host-stopped', 'project-lifecycle-admission-not-bound');
    }
    return this.projectLifecycleAdmissions;
  }

  private async stopProjectUnlocked(projectId: CollabProjectId): Promise<CollabHostSession> {
    if (this.terminalizingProjects.has(projectId) || this.terminalProjects.has(projectId)) {
      throw hostError('project-retired', 'host-project-terminal');
    }
    const membership = await this.requireHostMembership(projectId);
    await this.options.localProjects.saveMembership({
      ...membership,
      hostOwnership: { autoStart: false, ownsAuthority: true },
      updatedAt: this.now().toISOString(),
    });
    const hosted = this.hostedProjects.get(projectId);
    if (!hosted) return { projectId, status: 'stopped' };
    let firstError: unknown;
    await hosted.advertisement?.stop().catch(error => {
      firstError = error;
    });
    this.router.unregisterProject(projectId);
    await this.authorityTransferRoutes.remove(projectId, 'source-active');
    await hosted.service.stopHosting().catch(error => {
      firstError ??= error;
    });
    this.hostedProjects.delete(projectId);
    hosted.events?.close();
    await hosted.gitProxy.close().catch(error => {
      firstError ??= error;
    });
    await this.closeProjectResources(projectId).catch(error => {
      firstError ??= error;
    });
    if (
      this.hostedProjects.size === 0
      && this.terminalProjects.size === 0
      && this.authorityTransferRoutes.size === 0
    ) {
      this.stopAddressMonitor();
    }
    if (
      this.hostedProjects.size === 0
      && this.terminalProjects.size === 0
      && this.provisionalTransfers.size === 0
      && this.authorityTransferRoutes.size === 0
    ) {
      this.stopAddressMonitor();
      await this.closeListenerAndLock().catch(error => {
        firstError ??= error;
      });
    }
    if (firstError instanceof Error) throw firstError;
    if (firstError) throw hostError('operation-failed', 'host-project-stop-failed');
    return { projectId, status: 'stopped' };
  }

  private async startListener(expectedEndpoint: string | null = null): Promise<RunningListener> {
    const addresses = this.options.getPrivateIpv4Addresses?.()
      ?? listPrivateIpv4Addresses();
    let expected: URL | null = null;
    if (expectedEndpoint !== null) {
      try {
        expected = new URL(expectedEndpoint);
      } catch {
        throw hostError('endpoint-unreachable', 'authority-transfer-expected-endpoint-invalid');
      }
      if (
        expected.protocol !== 'https:'
        || expected.origin !== expectedEndpoint
        || expected.port === ''
        || isIP(expected.hostname) !== 4
      ) {
        throw hostError('endpoint-unreachable', 'authority-transfer-expected-endpoint-invalid');
      }
    }
    const address = expected?.hostname ?? addresses[0];
    if (
      !address
      || isIP(address) !== 4
      || (!isPrivateIpv4(address) && address !== '127.0.0.1')
      || (expected !== null && !addresses.includes(address))
    ) {
      throw hostError('endpoint-unreachable', 'private-ipv4-unavailable');
    }
    const identity = await this.tlsIdentity.issueServerIdentity(address);
    const candidates = expected
      ? [Number(expected.port)]
      : (this.options.portCandidates ?? defaultPortCandidates());
    if (
      candidates.length === 0
      || candidates.some(port => !Number.isInteger(port) || port < 0 || port > 65_535)
    ) {
      throw hostError('operation-failed', 'host-port-candidates-invalid');
    }

    for (const port of candidates) {
      const webSocketServer = new WebSocketServer({
        maxPayload: COLLAB_CONTROL_MAX_BODY_BYTES,
        noServer: true,
        perMessageDeflate: false,
      });
      const server = createServer({
        cert: identity.certificateChainPem,
        key: identity.privateKeyPem,
        maxHeaderSize: 16 * 1024,
        minVersion: 'TLSv1.2',
      }, (request, response) => {
        void this.handleHttpRequest(request, response);
      });
      server.headersTimeout = 10_000;
      server.keepAliveTimeout = 5_000;
      server.requestTimeout = 15_000;
      server.maxConnections = 100;
      server.on('upgrade', (request, socket, head) => {
        void this.handleUpgrade(webSocketServer, request, socket, head);
      });
      const started = await this.listen(server, address, port);
      if (!started) {
        webSocketServer.close();
        continue;
      }
      const bound = server.address();
      if (!bound || typeof bound === 'string') {
        await this.closeHttpsServer(server);
        webSocketServer.close();
        throw hostError('endpoint-unreachable', 'host-listener-address-missing');
      }
      server.on('error', () => {
        if (this.listener?.server === server) {
          this.listenerFailure = hostError(
            'endpoint-unreachable',
            'host-listener-runtime-failed',
          );
        }
      });
      return {
        address,
        caCertificatePem: identity.caCertificatePem,
        caFingerprint: identity.caFingerprint,
        endpoint: `https://${address}:${bound.port}`,
        server,
        webSocketServer,
      };
    }
    throw hostError(
      'endpoint-unreachable',
      expected
        ? 'authority-transfer-expected-endpoint-unavailable'
        : 'host-port-range-unavailable',
    );
  }

  private createGitProxy(
    projectId: CollabProjectId,
    runtime: LanHostProjectRuntime,
    service: PendingMembershipService,
  ): LanHostGitProxy {
    const git = runtime.git;
    const proxyOptions: GitHttpBackendProxyOptions = {
      authorityDirectory: runtime.authorityDirectory,
      authenticateMemberCredential: service.authenticateMemberCredential.bind(service),
      ...(git.baseEnvironment ? { baseEnvironment: git.baseEnvironment } : {}),
      emptyConfigPath: git.emptyConfigPath,
      gitExecutablePath: git.gitExecutablePath,
      gitHttpBackendPath: git.gitHttpBackendPath,
      onChildStarted: (memberId, close) => (
        this.registerOwnedResource(projectId, memberId, close)
      ),
      prepareMemberRef: git.prepareMemberRef,
      projectId,
      repository: git.repository,
    };
    return this.options.createGitProxy?.(proxyOptions)
      ?? new GitHttpBackendProxy(proxyOptions);
  }

  private async handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (await this.authorityTransferRouter.handle(request, response)) return;
    const provisionalCount = this.provisionalTransfers.size;
    if (await this.provisionalTransfers.handle(request, response)) {
      if (this.provisionalTransfers.size < provisionalCount) {
        response.once('finish', () => {
          void this.operationQueue.run(() => this.closeUnusedListener()).catch(() => undefined);
        });
      }
      return;
    }
    if (!isGitHttpRoute(request.url)) {
      await this.router.handle(request, response);
      return;
    }
    let projectId: string;
    try {
      projectId = parseGitHttpRoute(request.method ?? '', request.url!).projectId;
    } catch {
      this.writeGitRouteUnavailable(response);
      return;
    }
    const hosted = this.hostedProjects.get(projectId);
    if (!hosted) {
      this.writeGitRouteUnavailable(
        response,
        this.router.hasTerminalProject(projectId) ? 410 : 404,
      );
      return;
    }
    try {
      await hosted.admission.run(() => hosted.gitProxy.handle(request, response));
    } catch {
      if (!response.headersSent && !response.writableEnded) {
        response.statusCode = 502;
        response.end('Git operation failed.\n');
      } else {
        response.destroy();
      }
    }
  }

  private async closeUnusedListener(): Promise<void> {
    if (
      this.hostedProjects.size === 0
      && this.terminalProjects.size === 0
      && this.authorityTransferRoutes.size === 0
      && this.authorityTransferPreparations.size === 0
    ) {
      this.stopAddressMonitor();
    }
    if (
      this.hostedProjects.size > 0
      || this.terminalProjects.size > 0
      || this.provisionalTransfers.size > 0
      || this.authorityTransferRoutes.size > 0
      || this.authorityTransferPreparations.size > 0
    ) return;
    this.stopAddressMonitor();
    await this.closeListenerAndLock();
  }

  private writeGitRouteUnavailable(response: ServerResponse, statusCode = 404): void {
    response.statusCode = statusCode;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end(statusCode === 410 ? 'Git project retired.\n' : 'Git project not found.\n');
  }

  private listen(server: HttpsServer, address: string, port: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        if (error.code === 'EADDRINUSE') {
          server.close(() => resolve(false));
          return;
        }
        reject(hostError('endpoint-unreachable', 'host-listener-start-failed'));
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ exclusive: true, host: address, port });
    });
  }

  private async handleUpgrade(
    webSocketServer: WebSocketServer,
    request: Parameters<CollabControlRouter['handle']>[0],
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    let authenticated: Awaited<ReturnType<CollabControlRouter['authenticateEvent']>>;
    try {
      authenticated = await this.router.authenticateEvent({
        ...(typeof request.headers.authorization === 'string'
          ? { authorization: request.headers.authorization }
          : {}),
        ...(typeof request.headers['x-collab-event-sequence'] === 'string'
          ? { lastSequence: request.headers['x-collab-event-sequence'] }
          : {}),
        ...(request.url ? { url: request.url } : {}),
      });
    } catch {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, webSocket => {
      const hosted = this.hostedProjects.get(authenticated.projectId);
      if (!hosted || hosted.admission.mode !== 'active') {
        webSocket.close(1008, 'Project unavailable');
        return;
      }
      let unregister: () => void;
      const close: HostResourceCloser = reason => new Promise<void>(resolve => {
        if (webSocket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        const timer = window.setTimeout(() => {
          webSocket.terminate();
          resolve();
        }, 250);
        webSocket.once('close', () => {
          window.clearTimeout(timer);
          resolve();
        });
        const accessRemoved = reason === 'access-removed' || reason === 'pending-expired';
        webSocket.close(
          accessRemoved ? 1008 : 1001,
          accessRemoved ? 'Access removed' : 'Host stopped',
        );
      });
      try {
        unregister = this.registerOwnedResource(
          authenticated.projectId,
          authenticated.memberId,
          close,
        );
      } catch {
        webSocket.close(1008, 'Project unavailable');
        return;
      }
      webSocket.once('close', unregister);
      if (hosted?.events) {
        void hosted.events.connect(
          webSocket,
          authenticated.memberId,
          authenticated.lastSequence,
        );
      }
      webSocketServer.emit('connection', webSocket, request);
    });
  }

  private async acquireHostLock(): Promise<void> {
    if (this.hostLock) return;
    await this.options.localProjects.ensurePrivateStateContainer();
    const lockPath = await resolveCollabVaultPath(this.options.vaultRoot, HOST_LOCK_PATH);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const nonce = randomUUID().replaceAll('-', '');
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        handle = await open(lockPath, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify({ nonce, pid: process.pid })}\n`);
        await handle.sync();
        this.hostLock = { handle, nonce, path: lockPath, pid: process.pid };
        ACTIVE_HOST_LOCK_NONCES.add(nonce);
        return;
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw hostError('operation-failed', 'vault-host-lock-create-failed');
        }
        const stat = await lstat(lockPath).catch(() => null);
        if (
          !stat
          || !stat.isFile()
          || stat.isSymbolicLink()
          || stat.size > HOST_LOCK_MAX_BYTES
        ) {
          throw hostError('authorization-denied', 'vault-host-lock-invalid');
        }
        const existing = parseHostLock(await readFile(lockPath, 'utf8'));
        if (
          processIsAlive(existing.pid)
          && (
            existing.pid !== process.pid
            || ACTIVE_HOST_LOCK_NONCES.has(existing.nonce)
          )
        ) {
          throw hostError('authorization-denied', 'vault-host-already-running');
        }
        await unlink(lockPath).catch(() => {
          throw hostError('authorization-denied', 'vault-host-stale-lock-retained');
        });
      }
    }
    throw hostError('authorization-denied', 'vault-host-lock-unavailable');
  }

  private async releaseHostLock(): Promise<void> {
    const lock = this.hostLock;
    if (!lock) return;
    this.hostLock = null;
    try {
      await lock.handle.close().catch(() => undefined);
      const contents = await readFile(lock.path, 'utf8').catch(() => null);
      if (contents === null) return;
      const current = parseHostLock(contents);
      if (current.nonce !== lock.nonce || current.pid !== lock.pid) {
        throw hostError('authorization-denied', 'vault-host-lock-replaced');
      }
      await unlink(lock.path).catch(() => {
        throw hostError('operation-failed', 'vault-host-lock-release-failed');
      });
    } finally {
      ACTIVE_HOST_LOCK_NONCES.delete(lock.nonce);
    }
  }

  private async closeListenerAndLock(): Promise<void> {
    const listener = this.listener;
    this.listener = null;
    this.listenerFailure = null;
    if (listener) await this.closeListener(listener);
    await this.releaseHostLock();
  }

  private closeListener(listener: RunningListener): Promise<void> {
    return Promise.all([
      this.closeHttpsServer(listener.server),
      this.closeWebSocketServer(listener.webSocketServer),
    ]).then(() => undefined);
  }

  private closeHttpsServer(server: HttpsServer): Promise<void> {
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve();
      };
      const timer = window.setTimeout(finish, LISTENER_CLOSE_TIMEOUT_MS);
      server.close(finish);
      server.closeAllConnections();
    });
  }

  private closeWebSocketServer(server: WebSocketServer): Promise<void> {
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        for (const client of server.clients) client.terminate();
        resolve();
      };
      const timer = window.setTimeout(finish, LISTENER_CLOSE_TIMEOUT_MS);
      server.close(finish);
    });
  }

  private beginShutdown(): StartedHostShutdown {
    this.stopAddressMonitor();
    this.authorityTransferPreparations.clear();
    for (const projectId of this.authorityTransferExpiryTimers.keys()) {
      this.clearAuthorityTransferExpiry(projectId);
    }
    const gitDrains: Promise<unknown>[] = [];
    const transferDrains: Promise<unknown>[] = [];
    transferDrains.push(this.captureShutdown(() => this.authorityTransferRoutes.close()));
    for (const [projectId, project] of this.hostedProjects) {
      this.router.unregisterProject(projectId);
      if (project.runtime.outgoingHostTransfer) {
        transferDrains.push(this.captureShutdown(
          () => project.runtime.outgoingHostTransfer!.close(),
        ));
      }
      gitDrains.push(this.captureShutdown(() => project.advertisement?.stop()));
      gitDrains.push(this.captureShutdown(() => project.events?.close()));
      gitDrains.push(this.captureShutdown(() => project.gitProxy.close()));
    }
    for (const project of this.transferredProjects.values()) {
      if (project.runtime.outgoingHostTransfer) {
        transferDrains.push(this.captureShutdown(
          () => project.runtime.outgoingHostTransfer!.close(),
        ));
      }
    }
    for (const outgoing of this.recoveringHostTransfers.values()) {
      transferDrains.push(this.captureShutdown(() => outgoing.close()));
    }
    return {
      gitDrains,
      listenerDrain: this.captureShutdown(() => this.closeListenerAndLock()),
      resourceDrain: this.captureShutdown(() => this.resources.closeAll('host-stopped')),
      transferDrains,
    };
  }

  private clearAuthorityTransferExpiry(projectId: CollabProjectId): void {
    const timer = this.authorityTransferExpiryTimers.get(projectId);
    if (timer === undefined) return;
    this.clearAuthorityTransferExpiryTimeout(timer);
    this.authorityTransferExpiryTimers.delete(projectId);
  }

  private scheduleAuthorityTransferExpiry(
    registration: LanAuthorityTransferRouteRegistration,
    retryDelayMs?: number,
  ): void {
    this.clearAuthorityTransferExpiry(registration.projectId);
    if (registration.state !== 'terminal-source' && registration.state !== 'target-active') return;
    const expiresAtMs = Date.parse(registration.service.expiresAt);
    const remainingMs = expiresAtMs - this.now().getTime();
    const delayMs = retryDelayMs ?? Math.max(0, Math.min(MAX_TIMEOUT_MS, remainingMs));
    const timer = this.setAuthorityTransferExpiryTimeout(() => {
      this.authorityTransferExpiryTimers.delete(registration.projectId);
      void this.operationQueue.run(async () => {
        if (this.authorityTransferRoutes.resolve(registration.projectId) !== registration) return;
        if (this.now().getTime() < expiresAtMs) {
          this.scheduleAuthorityTransferExpiry(registration);
          return;
        }
        try {
          await registration.service.expire();
          await this.authorityTransferRoutes.remove(registration.projectId, registration.state);
          await this.closeUnusedListener();
        } catch {
          if (this.authorityTransferRoutes.resolve(registration.projectId) === registration) {
            this.scheduleAuthorityTransferExpiry(
              registration,
              AUTHORITY_TRANSFER_EXPIRY_RETRY_MS,
            );
          }
        }
      }).catch(() => undefined);
    }, delayMs);
    this.authorityTransferExpiryTimers.set(registration.projectId, timer);
  }

  private captureShutdown(operation: () => void | Promise<void>): Promise<unknown> {
    try {
      return Promise.resolve(operation()).then(
        () => null,
        (error: unknown) => error,
      );
    } catch (error) {
      return Promise.resolve(error);
    }
  }

  private checkHostAddress = (): Promise<void> => {
    if (
      this.closed
      || !this.listener
      || (
        this.hostedProjects.size === 0
        && this.terminalProjects.size === 0
        && this.authorityTransferRoutes.size === 0
        && this.authorityTransferPreparations.size === 0
      )
    ) {
      return Promise.resolve();
    }
    if (this.addressCheckTask) return this.addressCheckTask;
    const pending = this.operationQueue.run(() => this.rebindListenerIfNeeded());
    this.addressCheckTask = pending;
    const clear = () => {
      if (this.addressCheckTask === pending) this.addressCheckTask = null;
    };
    void pending.then(clear, error => {
      this.listenerFailure = error instanceof CollabError
        ? error
        : hostError('endpoint-unreachable', 'host-address-rebind-failed');
      clear();
    });
    return pending;
  };

  private currentHostEndpoint(): {
    readonly caFingerprint: string;
    readonly endpoint: string;
  } {
    const listener = this.listener;
    if (!listener) throw hostError('endpoint-unreachable', 'host-listener-unavailable');
    return {
      caFingerprint: listener.caFingerprint,
      endpoint: listener.endpoint,
    };
  }

  private async rebindListenerIfNeeded(): Promise<void> {
    this.assertOpen();
    const previous = this.listener;
    if (!previous || (
      this.hostedProjects.size === 0
      && this.terminalProjects.size === 0
      && this.authorityTransferRoutes.size === 0
      && this.authorityTransferPreparations.size === 0
    )) {
      return;
    }
    const addresses = this.options.getPrivateIpv4Addresses?.()
      ?? listPrivateIpv4Addresses();
    const preferred = addresses[0];
    if (!preferred) {
      throw hostError('endpoint-unreachable', 'private-ipv4-unavailable');
    }
    if (preferred === previous.address) {
      this.listenerFailure = null;
      return;
    }
    if (
      this.provisionalTransfers.size > 0
      || this.authorityTransferPreparations.size > 0
      || this.authorityTransferRoutes.pinsEndpoint
    ) {
      throw hostError('endpoint-unreachable', 'authority-transfer-endpoint-pinned');
    }
    const next = await this.startListener();
    const originals: CollabLocalLanMembershipRecord[] = [];
    let promoted = false;
    try {
      this.assertOpen();
      for (const projectId of this.hostedProjects.keys()) {
        const membership = await this.requireHostMembership(projectId);
        originals.push(membership);
        await this.options.localProjects.saveMembership({
          ...membership,
          authority: {
            endpoint: next.endpoint,
            gitRemoteUrl: `${next.endpoint}/v1/git/${projectId}/repository.git`,
            hostCaCertificatePem: next.caCertificatePem,
            hostCaFingerprint: next.caFingerprint,
            kind: 'lan',
          },
          updatedAt: this.now().toISOString(),
        });
        this.assertOpen();
      }
      this.listener = next;
      this.listenerFailure = null;
      promoted = true;
      for (const [projectId, hosted] of this.hostedProjects) {
        await hosted.advertisement?.stop().catch(() => undefined);
        hosted.advertisement = await this.options.discovery?.advertiseProject({
          caFingerprint: next.caFingerprint,
          endpoint: next.endpoint,
          projectId,
        }).catch(() => undefined);
        this.assertOpen();
      }
      for (const [projectId, terminal] of this.terminalProjects) {
        await terminal.advertisement?.stop().catch(() => undefined);
        terminal.advertisement = await this.options.discovery?.advertiseProject({
          caFingerprint: next.caFingerprint,
          endpoint: next.endpoint,
          projectId,
        }).catch(() => undefined);
        this.assertOpen();
      }
      for (const projectId of this.hostedProjects.keys()) {
        this.connectionProjection?.resetProjectConnection(projectId);
      }
    } catch (error) {
      for (const membership of originals) {
        await this.options.localProjects.saveMembership(membership).catch(() => undefined);
      }
      if (this.listener === next) this.listener = null;
      // Once promoted, the superseded listener is referenced nowhere else: a
      // close() racing this rebind tears down only the current listener, so
      // the previous one must be closed here.
      if (promoted) await this.closeListener(previous);
      await this.closeListener(next);
      throw error;
    }
    await this.closeListener(previous);
  }

  private startAddressMonitor(): void {
    if (
      this.addressMonitor
      || this.closed
      || (
        this.hostedProjects.size === 0
        && this.terminalProjects.size === 0
        && this.authorityTransferRoutes.size === 0
        && this.authorityTransferPreparations.size === 0
      )
    ) return;
    if (this.options.createAddressMonitor) {
      this.addressMonitor = this.options.createAddressMonitor(this.checkHostAddress);
      return;
    }
    const interval = window.setInterval(() => {
      void this.checkHostAddress().catch(() => undefined);
    }, HOST_ADDRESS_CHECK_INTERVAL_MS);
    this.addressMonitor = {
      close: () => window.clearInterval(interval),
    };
  }

  private stopAddressMonitor(): void {
    this.addressMonitor?.close();
    this.addressMonitor = null;
  }

  private releaseAuthorityTransferPreparation(token: symbol): Promise<void> {
    return this.operationQueue.run(async () => {
      if (!this.authorityTransferPreparations.delete(token)) return;
      await this.closeUnusedListener();
    });
  }

  private closeProjectResources(projectId: CollabProjectId): Promise<void> {
    return this.resources.closeProject(projectId, 'project-stopped');
  }

  private async retireActiveProject(
    projectId: CollabProjectId,
    admission: HostedProjectAdmissionGate,
  ): Promise<void> {
    const hosted = this.hostedProjects.get(projectId);
    if (!hosted || hosted.admission !== admission) {
      throw hostError('operation-failed', 'retired-host-project-missing');
    }
    admission.commitTerminal('retired');
    this.router.unregisterProject(projectId);
    await this.authorityTransferRoutes.remove(projectId, 'source-active');
    this.hostedProjects.delete(projectId);
    await hosted.advertisement?.stop().catch(() => undefined);
    hosted.events?.close();
    let firstError: unknown;
    await hosted.gitProxy.close().catch(error => {
      firstError = error;
    });
    await this.closeProjectResources(projectId).catch(error => {
      firstError ??= error;
    });
    await (hosted.runtime.retireAuthority?.()
      ?? Promise.reject(hostError('operation-failed', 'retired-authority-cleanup-missing')))
      .catch(error => {
      firstError ??= error;
      });
    await this.closeUnusedListener().catch(error => {
      firstError ??= error;
    });
    if (!firstError) this.terminalizingProjects.delete(projectId);
    if (firstError instanceof Error) throw firstError;
    if (firstError) throw hostError('operation-failed', 'retired-host-teardown-failed');
  }

  private beginRetirement(projectId: CollabProjectId): Promise<void> {
    return this.operationQueue.run(async () => {
      if (!this.hostedProjects.has(projectId)) {
        throw hostError('host-stopped', 'retirement-host-project-not-running');
      }
      this.terminalizingProjects.add(projectId);
    });
  }

  private resumeRetirement(projectId: CollabProjectId): Promise<void> {
    return this.operationQueue.run(async () => {
      if (this.terminalProjects.has(projectId)) {
        throw hostError('durable-progress-recovery-required', 'retirement-already-terminal');
      }
      this.terminalizingProjects.delete(projectId);
    });
  }

  private requireHostedProject(projectId: CollabProjectId): HostedProject {
    const hosted = this.hostedProjects.get(projectId);
    if (!hosted) throw hostError('project-not-found', 'host-project-not-running');
    return hosted;
  }

  private async requireHostMembership(
    projectId: CollabProjectId,
  ): Promise<CollabLocalLanMembershipRecord> {
    const membership = await this.requireLanMembership(projectId);
    if (!membership.hostOwnership.ownsAuthority) {
      throw hostError('authorization-denied', 'host-membership-required');
    }
    return membership;
  }

  private async requireLanMembership(
    projectId: CollabProjectId,
  ): Promise<CollabLocalLanMembershipRecord> {
    const membership = await this.options.localProjects.loadMembership(projectId);
    if (
      !membership
      || !isCollabLocalLanMembership(membership)
      || membership.project.id !== projectId
    ) {
      throw hostError('authorization-denied', 'host-membership-required');
    }
    return membership;
  }

  private assertOpen(): void {
    if (this.closed) throw hostError('not-initialized', 'lan-host-coordinator-closed');
  }

  private async withTransition<T>(
    projectId: CollabProjectId,
    transition: Extract<CollabHostStatus, 'starting' | 'stopping'>,
    operation: Promise<T>,
  ): Promise<T> {
    try {
      return await operation;
    } finally {
      if (this.projectTransitions.get(projectId) === transition) {
        this.projectTransitions.delete(projectId);
      }
    }
  }
}
