import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';

import {
  type ClaimTransferredMembershipRequest,
  COLLAB_PROJECT_MEMBERSHIP_LIMITS,
  collabControlOperationCodec,
  type CollabTransferredMembershipRedemptionReceipt,
  decodeCollabTransferredMembershipRedemptionReceipt,
  encodeCollabTransferredMembershipRedemptionReceiptSigningInput,
  isCollabOpaqueId,
  isCollabProjectId,
  type ListProjectMembersResponse,
  type ReissueTransferredMembershipClaimRequest,
  type ReissueTransferredMembershipClaimResponse,
} from '@claudian-collab/protocol';

import { PendingMembershipRepository } from '@/app/collab/authority/PendingMembershipRepository';
import { ProjectAuthorityRepository } from '@/app/collab/authority/ProjectAuthorityRepository';
import type { AuthorityDatabaseConnection } from '@/app/collab/authority/SQLJSProjectDatabase';
import { CollabError } from '@/core/collab/ClaudianCollabError';

interface ImportedClaimAuthority {
  readonly authorityGeneration: number;
  readonly checkpointSha256: string;
  readonly projectId: string;
  readonly receiptKeyId: string;
  readonly receiptPrivateKey: string;
  readonly sourceClaimsExpireAt: string;
  readonly transferId: string;
}

type LANClaimRequest = Extract<ClaimTransferredMembershipRequest, { credentialHash: string }>;
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const denied = () => new CollabError({ code: 'authorization-denied' });
const invalid = () => new CollabError({ code: 'membership-claim-invalid' });

function decodeAuthority(value: unknown): ImportedClaimAuthority {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const context = value as Record<string, unknown>;
  const keys = ['authorityGeneration', 'checkpointSha256', 'projectId', 'receiptKeyId', 'receiptPrivateKey', 'sourceClaimsExpireAt', 'transferId'];
  if (Object.keys(context).length !== keys.length || keys.some(key => !(key in context))
    || !isCollabProjectId(context.projectId) || !isCollabOpaqueId(context.transferId)
    || !isCollabOpaqueId(context.receiptKeyId)
    || typeof context.authorityGeneration !== 'number' || !Number.isSafeInteger(context.authorityGeneration) || context.authorityGeneration < 2
    || typeof context.checkpointSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(context.checkpointSha256)
    || typeof context.sourceClaimsExpireAt !== 'string' || !Number.isFinite(Date.parse(context.sourceClaimsExpireAt))
    || new Date(context.sourceClaimsExpireAt).toISOString() !== context.sourceClaimsExpireAt
    || typeof context.receiptPrivateKey !== 'string' || context.receiptPrivateKey.length > 1024
    || !/^[A-Za-z0-9_-]+$/.test(context.receiptPrivateKey)) throw invalid();
  try {
    const bytes = Buffer.from(context.receiptPrivateKey, 'base64url');
    if (bytes.toString('base64url') !== context.receiptPrivateKey
      || createPrivateKey({ key: bytes, format: 'der', type: 'pkcs8' }).asymmetricKeyType !== 'ed25519') throw invalid();
  } catch { throw invalid(); }
  return context as unknown as ImportedClaimAuthority;
}

/** Current LAN authority owns recovery claims independently of the expiring transfer responder. */
export class ImportedMembershipClaimRepository {
  private readonly members = new PendingMembershipRepository();
  private readonly projects = new ProjectAuthorityRepository();

  initialize(connection: AuthorityDatabaseConnection, input: ImportedClaimAuthority): void {
    const context = decodeAuthority(input);
    const project = this.projects.get(connection);
    if (!project || project.projectId !== context.projectId || project.authorityGeneration !== context.authorityGeneration) throw denied();
    const encoded = JSON.stringify(context);
    const previous = connection.get('SELECT context_json FROM imported_claim_authority WHERE singleton = 1');
    if (previous) {
      if (previous.context_json !== encoded) throw invalid();
      return;
    }
    connection.run('INSERT INTO imported_claim_authority (singleton, context_json) VALUES (1, ?)', [encoded]);
  }

  list(connection: AuthorityDatabaseConnection, actorMemberId: string, now: Date): ListProjectMembersResponse {
    const project = this.#requireProject(connection);
    const actor = this.members.listCredentialRecords(connection, ['active']).find(record => record.member.id === actorMemberId);
    if (!actor || actor.accessState !== 'bound') throw denied();
    const canManage = actor.member.role === 'manager';
    const context = this.#context(connection);
    return collabControlOperationCodec('listProjectMembers').decodeResponse({
      projectId: project.projectId,
      managerSetGeneration: project.managerSetGeneration,
      members: this.members.listCredentialRecords(connection, ['active']).map(record => {
        const current = connection.get('SELECT * FROM imported_member_claims WHERE member_id = ?', [record.member.id]);
        const revision = connection.get('SELECT membership_revision FROM members WHERE member_id = ?', [record.member.id]);
        const imported = context !== null && (record.accessState === 'unbound' || current !== null);
        return {
          memberId: record.member.id, displayName: record.member.displayName, role: record.member.role,
          membershipRevision: revision!.membership_revision, bindingState: canManage ? record.accessState : 'hidden',
          importedClaimGeneration: canManage && imported ? current?.claim_generation ?? 0 : null,
          importedClaimState: !canManage ? 'hidden' : !imported ? 'not-applicable' : record.accessState === 'bound' ? 'redeemed'
            : now.getTime() >= Date.parse(String(current?.expires_at ?? context.sourceClaimsExpireAt)) ? 'expired' : current ? 'override-active' : 'original-active',
        };
      }),
    });
  }

  reissue(
    connection: AuthorityDatabaseConnection,
    actorMemberId: string,
    input: ReissueTransferredMembershipClaimRequest,
    now: Date,
  ): ReissueTransferredMembershipClaimResponse {
    const decoded = collabControlOperationCodec('reissueTransferredMembershipClaim').decodeRequest(input);
    if (decoded.status !== 'ok') throw decoded.error;
    const request = decoded.value;
    const project = this.#requireProject(connection, request.projectId);
    this.#requireManager(connection, actorMemberId);
    const context = this.#context(connection);
    if (!context) throw denied();
    const member = this.members.listCredentialRecords(connection, ['active']).find(candidate => candidate.member.id === request.memberId);
    if (!member || member.accessState !== 'unbound') throw denied();
    const previous = connection.get('SELECT * FROM imported_member_claims WHERE member_id = ?', [request.memberId]);
    const fingerprint = hash(JSON.stringify(request));
    if (previous?.issued_key === request.idempotencyKey && previous.actor_member_id === actorMemberId) {
      if (previous.request_sha256 !== fingerprint) throw new CollabError({ code: 'idempotency-conflict' });
      const descriptor = collabControlOperationCodec('reissueTransferredMembershipClaim').decodeResponse(JSON.parse(String(previous.descriptor_json)));
      if (now.getTime() >= Date.parse(descriptor.secretReplayExpiresAt)) throw new CollabError({ code: 'membership-claim-expired' });
      return descriptor;
    }
    const revision = connection.get('SELECT membership_revision FROM members WHERE member_id = ?', [request.memberId]);
    if (request.expectedManagerSetGeneration !== project.managerSetGeneration
      || request.expectedMembershipRevision !== revision?.membership_revision
      || request.expectedClaimGeneration !== (previous?.claim_generation ?? 0)) throw new CollabError({ code: 'authority-transfer-stale' });
    const expiresAt = new Date(now.getTime() + COLLAB_PROJECT_MEMBERSHIP_LIMITS.transferredClaimTtlMs).toISOString();
    const descriptor = collabControlOperationCodec('reissueTransferredMembershipClaim').decodeResponse({
      claim: randomBytes(32).toString('base64url'), claimGeneration: request.expectedClaimGeneration + 1,
      createdAt: now.toISOString(), expiresAt, secretReplayExpiresAt: new Date(now.getTime() + COLLAB_PROJECT_MEMBERSHIP_LIMITS.secretReplayTtlMs).toISOString(), memberId: request.memberId,
      projectId: request.projectId, targetAuthorityGeneration: context.authorityGeneration, transferId: context.transferId,
    });
    connection.run(`INSERT INTO imported_member_claims (member_id, claim_generation, claim_sha256, expires_at,
      actor_member_id, issued_key, request_sha256, descriptor_json, credential_hash, redemption_key, receipt_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
      ON CONFLICT(member_id) DO UPDATE SET claim_generation=excluded.claim_generation, claim_sha256=excluded.claim_sha256,
      expires_at=excluded.expires_at, actor_member_id=excluded.actor_member_id, issued_key=excluded.issued_key,
      request_sha256=excluded.request_sha256, descriptor_json=excluded.descriptor_json,
      credential_hash=NULL, redemption_key=NULL, receipt_json=NULL`, [
      descriptor.memberId, descriptor.claimGeneration, hash(descriptor.claim), expiresAt,
      actorMemberId, request.idempotencyKey, fingerprint, JSON.stringify(descriptor),
    ]);
    return descriptor;
  }

  assertSourceClaimAllowed(connection: AuthorityDatabaseConnection, memberId: string): void {
    if (connection.get('SELECT member_id FROM imported_member_claims WHERE member_id = ?', [memberId])) throw invalid();
  }

  redeem(connection: AuthorityDatabaseConnection, input: LANClaimRequest, now: Date): CollabTransferredMembershipRedemptionReceipt {
    const decoded = collabControlOperationCodec('claimTransferredMembership').decodeRequest(input);
    if (decoded.status !== 'ok') throw decoded.error;
    const request = decoded.value;
    if (typeof request.credentialHash !== 'string') throw invalid();
    this.#requireProject(connection, request.projectId);
    const context = this.#context(connection);
    if (!context || context.transferId !== request.transferId) throw invalid();
    const current = connection.get('SELECT * FROM imported_member_claims WHERE claim_sha256 = ?', [hash(request.claim)]);
    if (!current) throw invalid();
    const memberId = String(current.member_id);
    const member = this.members.listCredentialRecords(connection, ['active']).find(candidate => candidate.member.id === memberId);
    if (!member) throw denied();
    if (current.receipt_json !== null) {
      if (current.credential_hash !== request.credentialHash || current.redemption_key !== request.idempotencyKey
        || member.accessState !== 'bound' || !member.credentialHash
        || Buffer.from(member.credentialHash).toString('hex') !== request.credentialHash) throw invalid();
      return decodeCollabTransferredMembershipRedemptionReceipt(JSON.parse(String(current.receipt_json)));
    }
    if (connection.get('SELECT recovery_link_id FROM project_recovery_links WHERE recovered_member_id = ? LIMIT 1', [memberId])) throw invalid();
    if (now.getTime() >= Date.parse(String(current.expires_at))) throw new CollabError({ code: 'membership-claim-expired' });
    if (member.accessState !== 'unbound') throw denied();
    const payload = {
      checkpointSha256: context.checkpointSha256, claimSha256: hash(request.claim), memberId,
      operationIntentId: request.idempotencyKey, projectId: request.projectId,
      receiptId: `receipt-${hash(`${request.claim}:${request.idempotencyKey}`).slice(0, 40)}`,
      receiptKeyId: context.receiptKeyId, redeemedAt: now.toISOString(), signatureAlgorithm: 'ed25519' as const,
      targetAuthorityGeneration: context.authorityGeneration, transferId: context.transferId,
    };
    const receipt = decodeCollabTransferredMembershipRedemptionReceipt({
      ...payload,
      signature: sign(null, Buffer.from(encodeCollabTransferredMembershipRedemptionReceiptSigningInput(payload)),
        createPrivateKey({ key: Buffer.from(context.receiptPrivateKey, 'base64url'), format: 'der', type: 'pkcs8' })).toString('base64url'),
    });
    this.members.bindImportedActive(connection, memberId, Buffer.from(request.credentialHash, 'hex'));
    connection.run('UPDATE imported_member_claims SET credential_hash = ?, redemption_key = ?, receipt_json = ? WHERE member_id = ?',
      [request.credentialHash, request.idempotencyKey, JSON.stringify(receipt), memberId]);
    return receipt;
  }

  #requireProject(connection: AuthorityDatabaseConnection, projectId?: string) {
    const project = this.projects.get(connection);
    if (!project || project.state !== 'active' || projectId !== undefined && project.projectId !== projectId) throw denied();
    return project;
  }

  #requireManager(connection: AuthorityDatabaseConnection, memberId: string): void {
    const member = this.members.listCredentialRecords(connection, ['active']).find(candidate => candidate.member.id === memberId);
    if (!member || member.member.role !== 'manager' || member.accessState !== 'bound') throw denied();
  }

  #context(connection: AuthorityDatabaseConnection): ImportedClaimAuthority | null {
    const row = connection.get('SELECT context_json FROM imported_claim_authority WHERE singleton = 1');
    if (!row) return null;
    const context = decodeAuthority(JSON.parse(String(row.context_json)));
    const project = this.#requireProject(connection, context.projectId);
    if (project.authorityGeneration !== context.authorityGeneration) throw denied();
    return context;
  }
}
