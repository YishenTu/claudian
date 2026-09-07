import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

import {
  type CollabMember,
  type CollabMemberStatus,
  isCollabGitOid,
  isCollabMemberId,
  isCollabOpaqueId,
  isCollabProjectId,
} from '@claudian-collab/protocol';

import type { AuthorityEventRepository } from '@/app/collab/authority/AuthorityEventRepository';
import type { AuthorityIdempotencyRepository } from '@/app/collab/authority/AuthorityIdempotencyRepository';
import {
  type AuthorityInvitationRecord,
  type AuthorityMemberCredentialRecord,
  PendingMembershipRepository,
} from '@/app/collab/authority/PendingMembershipRepository';
import type { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import type {
  AuthorityDatabaseConnection,
  SqlJsMutationResult,
} from '@/app/collab/authority/SqlJsProjectDatabase';
import { TicketRepository } from '@/app/collab/authority/TicketRepository';
import type {
  InvitationCodec,
  LanCollabInvitation,
} from '@/app/collab/lan/InvitationCodec';
import { COLLAB_PENDING_MEMBERSHIP_TTL_MS } from '@/app/collab/lan/LanCollabConstants';
import type {
  ActivateJoinAttemptRequest,
  ConfirmEndpointResponse,
  CreateInvitationRequest,
  CreateJoinAttemptRequest,
  LanCollabJoinAttempt as CollabJoinAttempt,
  RefreshEndpointResponse,
  RevokeInvitationRequest,
} from '@/app/collab/lan/LanCollabControlOperations';
import type { CollabLanProjectSnapshot } from '@/core/collab';
import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const JOIN_FAILURE_WINDOW_MS = 60_000;
const JOIN_FAILURE_LIMIT = 5;
const JOIN_RATE_INITIAL_DELAY_MS = 250;
const JOIN_RATE_MAX_DELAY_MS = 30_000;
const CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

interface PendingMembershipDatabase {
  read<T>(reader: (connection: AuthorityDatabaseConnection) => T): Promise<T>;
  mutate<T>(
    mutation: (connection: AuthorityDatabaseConnection) => T,
  ): Promise<SqlJsMutationResult<T>>;
}

export interface PendingMembershipAuthority {
  readonly database: PendingMembershipDatabase;
  readonly events: AuthorityEventRepository;
  readonly idempotency: AuthorityIdempotencyRepository;
  readonly projects: ProjectAuthorityRepository;
}

export interface PendingMembershipHostEndpoint {
  readonly caFingerprint: string;
  readonly endpoint: string;
}

export interface PendingMembershipServiceOptions {
  readonly createCredential?: () => string;
  readonly createId?: (kind: 'invitation' | 'member') => string;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly getHostEndpoint: () => PendingMembershipHostEndpoint;
  readonly getInvitationCodec?: () => InvitationCodec;
  readonly invitationCodec: InvitationCodec;
  readonly now?: () => Date;
  readonly onPendingExpired?: (member: CollabMember) => void | Promise<void>;
  readonly readMainOid: () => Promise<string>;
}

export interface CreateJoinAttemptOptions {
  readonly remoteAddress: string;
}

export interface AuthenticatedCollabMember {
  readonly member: CollabMember;
}

interface JoinFailureState {
  blockedUntil: number;
  failures: number;
  windowStartedAt: number;
}

interface InvitationReplay {
  readonly actorMemberId: string;
  readonly fingerprint: string;
  readonly invitation: LanCollabInvitation;
}

function serviceError(
  code:
    | 'authentication-failed'
    | 'authorization-denied'
    | 'idempotency-conflict'
    | 'invitation-expired'
    | 'invitation-invalid'
    | 'invitation-revoked'
    | 'membership-revoked'
    | 'operation-failed'
    | 'project-not-found',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'invitation-expired' || code === 'invitation-revoked'
      ? ['refresh-invitation']
      : code === 'authentication-failed' || code === 'authorization-denied'
        ? ['request-access']
        : ['retry', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function hashCredential(credential: string): Buffer {
  return createHash('sha256').update(credential, 'utf8').digest();
}

function requestFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function assertOpaqueId(value: string, field: string): void {
  if (!isCollabOpaqueId(value)) {
    throw serviceError('operation-failed', `${field}-invalid`);
  }
}

function assertProject(inputProjectId: string, projectId: string): void {
  if (inputProjectId !== projectId) {
    throw serviceError('project-not-found', 'project-id-mismatch');
  }
}

function assertDisplayName(displayName: string): string {
  const normalized = displayName.trim();
  if (
    normalized.length === 0
    || normalized.length > 200
    || normalized.includes('\u0000')
    || normalized.includes('\r')
    || normalized.includes('\n')
  ) {
    throw serviceError('operation-failed', 'member-display-name-invalid');
  }
  return normalized;
}

function credentialMatches(actualHash: Uint8Array, expectedHash: Uint8Array): boolean {
  return actualHash.byteLength === expectedHash.byteLength
    && timingSafeEqual(actualHash, expectedHash);
}

function defaultDelay(milliseconds: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

export class PendingMembershipService {
  private readonly createCredential: () => string;
  private readonly createId: (kind: 'invitation' | 'member') => string;
  private readonly delay: (milliseconds: number) => Promise<void>;
  private readonly invitationReplays = new Map<string, InvitationReplay>();
  private readonly joinFailures = new Map<string, JoinFailureState>();
  private readonly now: () => Date;
  private readonly onPendingExpired?: (member: CollabMember) => void | Promise<void>;
  private readonly repository = new PendingMembershipRepository();
  private readonly tickets = new TicketRepository();

  constructor(
    private readonly authority: PendingMembershipAuthority,
    private readonly options: PendingMembershipServiceOptions,
  ) {
    this.createCredential = options.createCredential
      ?? (() => randomBytes(32).toString('base64url'));
    this.createId = options.createId ?? (kind => (
      `${kind}-${randomUUID().replaceAll('-', '')}`
    ));
    this.delay = options.delay ?? defaultDelay;
    this.now = options.now ?? (() => new Date());
    this.onPendingExpired = options.onPendingExpired;
  }

  async createInvitation(
    memberCredential: string,
    request: CreateInvitationRequest,
  ): Promise<LanCollabInvitation> {
    const project = await this.requireProject(request.projectId);
    const actor = await this.authenticateMemberCredential(memberCredential, ['active']);
    if (actor.member.role !== 'manager') {
      throw serviceError('authorization-denied', 'manager-role-required');
    }
    const now = this.now();
    for (const [key, value] of this.invitationReplays) {
      if (Date.parse(value.invitation.expiresAt) <= now.getTime()) {
        this.invitationReplays.delete(key);
      }
    }
    const fingerprint = requestFingerprint(request);
    const replayKey = `${actor.member.id}:${request.idempotencyKey}`;
    const replay = this.invitationReplays.get(replayKey);
    if (replay) {
      if (replay.actorMemberId !== actor.member.id || replay.fingerprint !== fingerprint) {
        throw serviceError('idempotency-conflict', 'idempotency-key-reused');
      }
      return replay.invitation;
    }
    assertOpaqueId(request.idempotencyKey, 'idempotency-key');
    const host = this.options.getHostEndpoint();
    const invitation = this.invitationCodec().createInvitation({
      caFingerprint: host.caFingerprint,
      endpoint: host.endpoint,
      invitationId: this.createValidId('invitation'),
      projectId: project.projectId,
    });
    const tokenHash = Buffer.from(
      this.invitationCodec().hashSecret(invitation.invitationSecret),
      'base64url',
    );
    await this.authority.database.mutate(connection => {
      const transactionActor = this.authenticateInConnection(
        connection,
        memberCredential,
        ['active'],
      );
      if (
        transactionActor.member.id !== actor.member.id
        || transactionActor.member.role !== 'manager'
      ) {
        throw serviceError('authorization-denied', 'manager-role-required');
      }
      this.repository.rotateInvitation(connection, {
        createdAt: now.toISOString(),
        createdByMemberId: actor.member.id,
        expiresAt: invitation.expiresAt,
        invitationId: invitation.invitationId,
        tokenHash,
      });
      this.authority.events.append(connection, {
        actorMemberId: actor.member.id,
        createdAt: now.toISOString(),
        kind: 'invitation.updated',
        payload: {
          expiresAt: invitation.expiresAt,
          invitationId: invitation.invitationId,
          projectId: project.projectId,
        },
      });
    });
    this.invitationReplays.set(replayKey, {
      actorMemberId: actor.member.id,
      fingerprint,
      invitation,
    });
    return invitation;
  }

  async revokeInvitation(
    memberCredential: string,
    request: RevokeInvitationRequest,
  ): Promise<void> {
    await this.requireProject(request.projectId);
    const actor = await this.authenticateMemberCredential(memberCredential, ['active']);
    if (actor.member.role !== 'manager') {
      throw serviceError('authorization-denied', 'manager-role-required');
    }
    assertOpaqueId(request.idempotencyKey, 'idempotency-key');
    const createdAt = this.now().toISOString();
    const fingerprint = requestFingerprint(request);
    await this.authority.database.mutate(connection => {
      const transactionActor = this.authenticateInConnection(
        connection,
        memberCredential,
        ['active'],
      );
      if (
        transactionActor.member.id !== actor.member.id
        || transactionActor.member.role !== 'manager'
      ) {
        throw serviceError('authorization-denied', 'manager-role-required');
      }
      const stored = this.authority.idempotency.store(connection, {
        actorMemberId: actor.member.id,
        createdAt,
        key: request.idempotencyKey,
        operationKind: 'revoke-invitation',
        requestFingerprint: fingerprint,
        response: { revoked: true },
      });
      if (stored.status === 'existing') return;
      this.repository.revokeCurrentInvitation(connection, createdAt);
      this.authority.events.append(connection, {
        actorMemberId: actor.member.id,
        createdAt,
        kind: 'invitation.updated',
        payload: { projectId: request.projectId, revoked: true },
      });
    });
  }

  async stopHosting(): Promise<void> {
    const project = await this.requireProjectFromAuthority();
    const stoppedAt = this.now().toISOString();
    await this.authority.database.mutate(connection => {
      this.repository.revokeCurrentInvitation(connection, stoppedAt);
      this.authority.events.append(connection, {
        actorMemberId: project.hostMemberId,
        createdAt: stoppedAt,
        kind: 'host.stopped',
        payload: { projectId: project.projectId },
      });
    });
    this.invitationReplays.clear();
  }

  async createJoinAttempt(
    invitationSecret: string,
    request: CreateJoinAttemptRequest,
    options: CreateJoinAttemptOptions,
  ): Promise<CollabJoinAttempt> {
    await this.garbageCollectExpiredPending();
    const project = await this.requireProject(request.projectId);
    assertOpaqueId(request.joinAttemptId, 'join-attempt-id');
    const displayName = assertDisplayName(request.displayName);
    const rateKey = `${request.projectId}:${options.remoteAddress}`;
    await this.enforceJoinRateLimit(rateKey);
    const createdAt = this.now();
    const credential = this.createValidCredential();
    const credentialHash = hashCredential(credential);
    let result: AuthorityMemberCredentialRecord;
    try {
      result = (await this.authority.database.mutate(connection => {
        this.requireInvitation(connection, invitationSecret, createdAt);
        const existing = this.repository.findByJoinAttempt(connection, request.joinAttemptId);
        if (existing) {
          if (
            existing.member.displayName !== displayName
            || existing.member.status !== 'pending'
          ) {
            throw serviceError('idempotency-conflict', 'join-attempt-reused');
          }
          return this.repository.rotatePendingCredential(
            connection,
            existing.member.id,
            credentialHash,
          );
        }
        const pending = this.repository.createPending(connection, {
          createdAt: createdAt.toISOString(),
          credentialHash,
          displayName,
          joinAttemptId: request.joinAttemptId,
          memberId: this.createValidId('member'),
        });
        this.authority.events.append(connection, {
          actorMemberId: null,
          createdAt: createdAt.toISOString(),
          kind: 'membership.pending',
          payload: { memberId: pending.member.id, projectId: project.projectId },
        });
        return pending;
      })).value;
    } catch (error) {
      if (
        error instanceof CollabError
        && (
          error.code === 'authentication-failed'
          || error.code === 'invitation-expired'
          || error.code === 'invitation-revoked'
        )
      ) {
        this.recordJoinFailure(rateKey);
      }
      throw error;
    }
    this.joinFailures.delete(rateKey);
    return {
      expiresAt: new Date(
        Date.parse(result.member.createdAt) + COLLAB_PENDING_MEMBERSHIP_TTL_MS,
      ).toISOString(),
      id: request.joinAttemptId,
      member: result.member,
      memberCredential: credential,
      projectId: project.projectId,
    };
  }

  async activateJoinAttempt(
    memberCredential: string,
    request: ActivateJoinAttemptRequest,
  ): Promise<CollabLanProjectSnapshot> {
    const project = await this.requireProject(request.projectId);
    assertOpaqueId(request.joinAttemptId, 'join-attempt-id');
    assertOpaqueId(request.idempotencyKey, 'idempotency-key');
    await this.authenticateMemberCredential(memberCredential, ['pending', 'active']);
    const mainOid = await this.readMainOid();
    const now = this.now();
    return (await this.authority.database.mutate(connection => {
      const actor = this.authenticateInConnection(connection, memberCredential, [
        'pending',
        'active',
      ]);
      if (actor.joinAttemptId !== request.joinAttemptId) {
        throw serviceError('authorization-denied', 'join-attempt-owner-mismatch');
      }
      if (
        actor.member.status === 'pending'
        && Date.parse(actor.member.createdAt) + COLLAB_PENDING_MEMBERSHIP_TTL_MS
          <= now.getTime()
      ) {
        throw serviceError('membership-revoked', 'pending-membership-expired');
      }
      const transitioned = actor.member.status === 'pending';
      const active = transitioned
        ? this.repository.activate(connection, actor.member.id, now.toISOString())
        : actor;
      if (transitioned) {
        this.authority.events.append(connection, {
          actorMemberId: active.member.id,
          createdAt: now.toISOString(),
          kind: 'membership.activated',
          payload: { memberId: active.member.id, projectId: project.projectId },
        });
      }
      const snapshot = this.snapshotFromConnection(
        connection,
        active.member.id,
        mainOid,
      );
      return this.authority.idempotency.store(connection, {
        actorMemberId: active.member.id,
        createdAt: now.toISOString(),
        key: request.idempotencyKey,
        operationKind: 'join-project',
        requestFingerprint: requestFingerprint(request),
        response: snapshot,
      }).response;
    })).value;
  }

  async readSnapshot(memberCredential: string): Promise<CollabLanProjectSnapshot> {
    await this.authenticateMemberCredential(memberCredential, ['active']);
    const mainOid = await this.readMainOid();
    return this.authority.database.read(connection => {
      const actor = this.authenticateInConnection(connection, memberCredential, ['active']);
      return this.snapshotFromConnection(connection, actor.member.id, mainOid);
    });
  }

  async refreshEndpoint(
    memberCredential: string,
    invitation: LanCollabInvitation,
  ): Promise<RefreshEndpointResponse> {
    const actor = await this.authenticateMemberCredential(memberCredential, ['active']);
    if (actor.member.status !== 'active') {
      throw serviceError('authorization-denied', 'active-membership-required');
    }
    const validated = this.invitationCodec().validateInvitation(invitation);
    await this.requireProject(validated.projectId);
    const host = this.options.getHostEndpoint();
    if (
      validated.endpoint !== host.endpoint
      || validated.caFingerprint !== host.caFingerprint
    ) {
      throw serviceError('invitation-invalid', 'invitation-host-mismatch');
    }
    await this.authority.database.read(connection => {
      this.authenticateInConnection(connection, memberCredential, ['active']);
      const matched = this.requireInvitation(
        connection,
        validated.invitationSecret,
        this.now(),
      );
      if (matched.id !== validated.invitationId) {
        throw serviceError('invitation-invalid', 'invitation-id-mismatch');
      }
    });
    return { caFingerprint: host.caFingerprint, endpoint: host.endpoint };
  }

  async confirmEndpoint(
    memberCredential: string,
    projectId: string,
  ): Promise<ConfirmEndpointResponse> {
    await this.authenticateMemberCredential(memberCredential, ['active']);
    await this.requireProject(projectId);
    return this.options.getHostEndpoint();
  }

  encodeInvitation(invitation: LanCollabInvitation): string {
    return this.invitationCodec().encode(invitation);
  }

  authenticateMemberCredential(
    memberCredential: string,
    statuses: readonly CollabMemberStatus[],
  ): Promise<AuthenticatedCollabMember> {
    return this.authority.database.read(connection => {
      const record = this.authenticateInConnection(connection, memberCredential, statuses);
      return { member: record.member };
    });
  }

  async garbageCollectExpiredPending(): Promise<readonly CollabMember[]> {
    const cutoff = new Date(
      this.now().getTime() - COLLAB_PENDING_MEMBERSHIP_TTL_MS,
    ).toISOString();
    const candidates = await this.authority.database.read(connection => (
      this.repository.listPendingCreatedBefore(connection, cutoff)
    ));
    if (candidates.length === 0) return [];
    const removed = (await this.authority.database.mutate(connection => {
      const current = this.repository.listPendingCreatedBefore(connection, cutoff);
      this.repository.removePending(connection, current.map(member => member.id));
      for (const member of current) {
        this.authority.events.append(connection, {
          actorMemberId: null,
          createdAt: this.now().toISOString(),
          kind: 'membership.expired',
          payload: { memberId: member.id },
        });
      }
      return current;
    })).value;
    await Promise.all(removed.map(async member => this.onPendingExpired?.(member)));
    return removed;
  }

  private authenticateInConnection(
    connection: AuthorityDatabaseConnection,
    credential: string,
    statuses: readonly CollabMemberStatus[],
  ): AuthorityMemberCredentialRecord {
    if (!CREDENTIAL_PATTERN.test(credential)) {
      throw serviceError('authentication-failed', 'member-credential-invalid');
    }
    const actualHash = hashCredential(credential);
    let matched: AuthorityMemberCredentialRecord | null = null;
    for (const record of this.repository.listCredentialRecords(connection, statuses)) {
      if (
        record.accessState === 'bound'
        && record.credentialHash !== null
        && credentialMatches(actualHash, record.credentialHash)
      ) matched = record;
    }
    if (!matched) {
      const allMembers = this.repository.listCredentialRecords(connection, [
        'pending',
        'active',
        'revoked',
        'left',
      ]);
      const known = allMembers.find(record => (
        record.accessState === 'bound'
        && record.credentialHash !== null
        && credentialMatches(actualHash, record.credentialHash)
      ));
      if (known?.member.status === 'revoked' || known?.member.status === 'left') {
        throw serviceError('membership-revoked', 'membership-no-longer-active');
      }
      throw serviceError(
        known ? 'authorization-denied' : 'authentication-failed',
        known ? 'membership-capability-denied' : 'member-credential-unrecognized',
      );
    }
    return matched;
  }

  private createValidCredential(): string {
    const credential = this.createCredential();
    if (!CREDENTIAL_PATTERN.test(credential)) {
      throw serviceError('operation-failed', 'generated-credential-invalid');
    }
    return credential;
  }

  private createValidId(kind: 'invitation' | 'member'): string {
    const id = this.createId(kind);
    const valid = kind === 'member' ? isCollabMemberId(id) : isCollabOpaqueId(id);
    if (!valid) throw serviceError('operation-failed', `${kind}-id-invalid`);
    return id;
  }

  private async enforceJoinRateLimit(key: string): Promise<void> {
    const state = this.joinFailures.get(key);
    const now = this.now().getTime();
    if (!state || now - state.windowStartedAt >= JOIN_FAILURE_WINDOW_MS) {
      if (state) this.joinFailures.delete(key);
      return;
    }
    if (state.failures < JOIN_FAILURE_LIMIT || now >= state.blockedUntil) return;
    const retryAfter = Math.min(state.blockedUntil - now, JOIN_RATE_MAX_DELAY_MS);
    await this.delay(retryAfter);
    throw serviceError('authorization-denied', 'join-rate-limited');
  }

  private recordJoinFailure(key: string): void {
    const now = this.now().getTime();
    const existing = this.joinFailures.get(key);
    const state = !existing || now - existing.windowStartedAt >= JOIN_FAILURE_WINDOW_MS
      ? { blockedUntil: now, failures: 0, windowStartedAt: now }
      : existing;
    state.failures += 1;
    if (state.failures >= JOIN_FAILURE_LIMIT) {
      const exponent = state.failures - JOIN_FAILURE_LIMIT;
      state.blockedUntil = now + Math.min(
        JOIN_RATE_INITIAL_DELAY_MS * (2 ** exponent),
        JOIN_RATE_MAX_DELAY_MS,
      );
    }
    this.joinFailures.set(key, state);
  }

  private requireInvitation(
    connection: AuthorityDatabaseConnection,
    secret: string,
    now: Date,
  ): AuthorityInvitationRecord {
    let actualHash: Buffer;
    try {
      actualHash = Buffer.from(this.invitationCodec().hashSecret(secret), 'base64url');
    } catch {
      throw serviceError('authentication-failed', 'invitation-credential-invalid');
    }
    let matched: AuthorityInvitationRecord | null = null;
    for (const invitation of this.repository.listInvitations(connection)) {
      if (credentialMatches(actualHash, invitation.tokenHash) && !matched) {
        matched = invitation;
      }
    }
    if (!matched) throw serviceError('authentication-failed', 'invitation-unrecognized');
    if (matched.revokedAt !== null) {
      throw serviceError('invitation-revoked', 'invitation-revoked');
    }
    if (Date.parse(matched.expiresAt) <= now.getTime()) {
      throw serviceError('invitation-expired', 'invitation-expired');
    }
    return matched;
  }

  private async requireProject(projectId: string) {
    if (!isCollabProjectId(projectId)) {
      throw serviceError('operation-failed', 'project-id-invalid');
    }
    const project = await this.authority.database.read(connection => (
      this.authority.projects.get(connection)
    ));
    if (!project) throw serviceError('project-not-found', 'authority-project-missing');
    assertProject(projectId, project.projectId);
    return project;
  }

  private async requireProjectFromAuthority() {
    const project = await this.authority.database.read(connection => (
      this.authority.projects.get(connection)
    ));
    if (!project) throw serviceError('project-not-found', 'authority-project-missing');
    return project;
  }

  private async readMainOid(): Promise<string> {
    const oid = await this.options.readMainOid();
    if (!isCollabGitOid(oid)) {
      throw serviceError('operation-failed', 'main-oid-invalid');
    }
    return oid;
  }

  private snapshotFromConnection(
    connection: AuthorityDatabaseConnection,
    currentMemberId: string,
    mainOid: string,
  ): CollabLanProjectSnapshot {
    const project = this.authority.projects.get(connection);
    if (!project) throw serviceError('project-not-found', 'authority-project-missing');
    const members = this.repository.listMembers(connection);
    const currentMember = members.find(member => member.id === currentMemberId);
    if (!currentMember) {
      throw serviceError('authentication-failed', 'current-member-missing');
    }
    return {
      currentMember,
      eventSequence: this.repository.latestEventSequence(connection),
      members,
      openRequests: this.repository.listOpenRequests(connection),
      openTicketCount: this.tickets.countOpen(connection),
      project: {
        authorityKind: 'lan',
        createdAt: project.createdAt,
        hostMemberId: project.hostMemberId,
        id: project.projectId,
        mainOid,
        mainRef: project.mainRef,
        managerSetGeneration: project.managerSetGeneration,
        name: project.name,
      },
      ticketHighlights: this.tickets.listHighlights(
        connection,
        CLAUDIAN_COLLAB_LIMITS.maxTicketHighlights,
      ),
    };
  }

  private invitationCodec(): InvitationCodec {
    return this.options.getInvitationCodec?.() ?? this.options.invitationCodec;
  }
}
