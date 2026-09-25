import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  COLLAB_PROJECT_RECOVERY_LIMITS, collabControlOperationCodec,
  type CreateProjectRecoveryLinkRequest, type CreateProjectRecoveryLinkResponse,
  type RedeemProjectRecoveryLinkRequest, type RedeemProjectRecoveryLinkResponse,
} from '@claudian-collab/protocol';

import { MemberRecoveryCredentialRepository } from '@/app/collab/authority/MemberRecoveryCredentialRepository';
import { PendingMembershipRepository } from '@/app/collab/authority/PendingMembershipRepository';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SQLJSProjectDatabase';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const denied = () => new CollabError({ code: 'authorization-denied' });

/** Project-scoped issuance and identity proof settle in one durable authority mutation. */
export class ProjectRecoveryLinkRepository {
  private readonly members = new PendingMembershipRepository();
  private readonly projects = new ProjectAuthorityRepository();

  create(connection: AuthorityDatabaseConnection, actorMemberId: string,
    input: CreateProjectRecoveryLinkRequest, now: Date): CreateProjectRecoveryLinkResponse {
    const decoded = collabControlOperationCodec('createProjectRecoveryLink').decodeRequest(input);
    if (decoded.status !== 'ok') throw denied();
    const request = decoded.value;
    this.#requireProject(connection, request);
    const actor = this.members.listCredentialRecords(connection, ['active']).find(item => item.member.id === actorMemberId);
    if (!actor || actor.accessState !== 'bound' || actor.member.role !== 'manager') throw denied();
    const fingerprint = hash(JSON.stringify(request));
    const previous = connection.get('SELECT * FROM project_recovery_links WHERE actor_member_id = ? AND issued_key = ?', [actorMemberId, request.idempotencyKey]);
    if (previous) {
      if (previous.request_sha256 !== fingerprint || typeof previous.descriptor_json !== 'string') throw denied();
      const result = collabControlOperationCodec('createProjectRecoveryLink').decodeResponse(JSON.parse(previous.descriptor_json));
      if (now.getTime() >= Date.parse(result.secretReplayExpiresAt)) throw denied();
      return result;
    }
    const available = connection.get('SELECT COUNT(*) AS count FROM project_recovery_links WHERE receipt_json IS NULL AND expires_at > ? AND authority_generation = ?', [now.toISOString(), request.expectedAuthorityGeneration]);
    if (Number(available?.count ?? 0) >= COLLAB_PROJECT_RECOVERY_LIMITS.maxActiveLinks) throw denied();
    const result = collabControlOperationCodec('createProjectRecoveryLink').decodeResponse({ projectId: request.projectId,
      authorityGeneration: request.expectedAuthorityGeneration, recoveryLinkId: `recovery-${randomUUID()}`,
      token: randomBytes(32).toString('hex'), expiresAt: new Date(now.getTime() + COLLAB_PROJECT_RECOVERY_LIMITS.linkTtlMs).toISOString(),
      secretReplayExpiresAt: new Date(now.getTime() + COLLAB_PROJECT_RECOVERY_LIMITS.secretReplayTtlMs).toISOString() });
    connection.run(`INSERT INTO project_recovery_links (recovery_link_id, authority_generation, actor_member_id, issued_key,
      request_sha256, token_sha256, expires_at, secret_replay_expires_at, descriptor_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [result.recoveryLinkId, result.authorityGeneration, actorMemberId,
      request.idempotencyKey, fingerprint, hash(result.token), result.expiresAt, result.secretReplayExpiresAt, JSON.stringify(result)]);
    connection.run('UPDATE project_recovery_links SET descriptor_json = NULL WHERE secret_replay_expires_at <= ?', [now.toISOString()]);
    return result;
  }

  redeem(connection: AuthorityDatabaseConnection, input: RedeemProjectRecoveryLinkRequest, now: Date): RedeemProjectRecoveryLinkResponse {
    const decoded = collabControlOperationCodec('redeemProjectRecoveryLink').decodeRequest(input);
    if (decoded.status !== 'ok' || !decoded.value.targetCredentialHash) throw denied();
    const request = decoded.value;
    this.#requireProject(connection, request);
    const link = connection.get('SELECT * FROM project_recovery_links WHERE recovery_link_id = ?', [request.recoveryLinkId]);
    if (!link || link.authority_generation !== request.expectedAuthorityGeneration
      || !timingSafeEqual(Buffer.from(String(link.token_sha256), 'hex'), Buffer.from(hash(request.token), 'hex'))) throw denied();
    const fingerprint = hash(JSON.stringify(request));
    if (link.receipt_json !== null) {
      if (link.redemption_sha256 !== fingerprint) throw denied();
      return collabControlOperationCodec('redeemProjectRecoveryLink').decodeResponse(JSON.parse(String(link.receipt_json)));
    }
    if (Date.parse(String(link.expires_at)) <= now.getTime()) throw denied();
    const proofHash = hash(request.proofCredential);
    const candidates = connection.all(`SELECT member_id FROM member_recovery_credentials WHERE credential_sha256 = ?
      UNION SELECT member_id FROM members WHERE credential_hash = ?`, [proofHash, Buffer.from(proofHash, 'hex')]);
    if (candidates.length !== 1) throw denied();
    const memberId = String(candidates[0].member_id);
    const member = this.members.listCredentialRecords(connection, ['active']).find(item => item.member.id === memberId);
    if (!member || member.accessState === 'bound' && Buffer.from(member.credentialHash!).toString('hex') !== request.targetCredentialHash) throw denied();
    new MemberRecoveryCredentialRepository().retainHashes(connection, memberId, [proofHash, request.targetCredentialHash!]);
    this.members.bindImportedActive(connection, memberId, Buffer.from(request.targetCredentialHash!, 'hex'));
    const result = collabControlOperationCodec('redeemProjectRecoveryLink').decodeResponse({ projectId: request.projectId,
      recoveryLinkId: request.recoveryLinkId, authorityGeneration: request.expectedAuthorityGeneration, memberId,
      personalRef: member.member.personalRef, receiptId: `receipt-${randomUUID()}`, recoveredAt: now.toISOString() });
    connection.run('UPDATE project_recovery_links SET redemption_sha256 = ?, receipt_json = ?, recovered_member_id = ? WHERE recovery_link_id = ?',
      [fingerprint, JSON.stringify(result), memberId, request.recoveryLinkId]);
    return result;
  }

  #requireProject(connection: AuthorityDatabaseConnection, request: CreateProjectRecoveryLinkRequest): void {
    const project = this.projects.get(connection);
    if (!project || project.projectId !== request.projectId || project.state !== 'active'
      || project.authorityGeneration !== request.expectedAuthorityGeneration) throw denied();
  }
}
