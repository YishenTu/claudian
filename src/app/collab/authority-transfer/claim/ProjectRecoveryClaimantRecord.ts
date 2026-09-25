import { createHash } from 'node:crypto';

import { collabControlOperationCodec, collabMemberRef, isCollabMemberId, isCollabOpaqueId, isCollabProjectId,
  type RedeemProjectRecoveryLinkRequest, type RedeemProjectRecoveryLinkResponse } from '@claudian-collab/protocol';

import { type AuthorityTransferImportedTargetIdentity, decodeAuthorityTransferImportedTargetIdentity } from '@/app/collab/authority-transfer/AuthorityTransferImportedTargetIdentity';
import type { AuthorityTransferClaimantRecord } from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import { decodeProjectRecoveryInvitation, encodeProjectRecoveryInvitation, type ProjectRecoveryInvitation, type ProjectRecoveryTarget } from '@/app/collab/project/ProjectRecoveryInvitation';
import { validateCloudServerURL } from '@/app/collab/remote-authority/CloudAuthorityURLs';

export const PROJECT_RECOVERY_CLAIMANT_PHASES = ['redemption-prepared', 'target-claimed', 'target-confirmed', 'membership-converged', 'completed'] as const;

export interface ProjectRecoveryConvergenceIntent {
  readonly target: ProjectRecoveryTarget;
  readonly identity: AuthorityTransferImportedTargetIdentity;
  readonly previousBindings: readonly { readonly remoteUrl: string; readonly serverUrl: string | null }[];
}

export interface ProjectRecoveryClaimantRecord {
  readonly schemaVersion: 5;
  readonly kind: 'authority-transfer-claimant';
  readonly variant: 'project-recovery';
  readonly projectId: string;
  readonly memberId: string;
  readonly memberPersonalRef: string;
  readonly operationIntentId: string;
  readonly cloudPrincipalId: string | null;
  readonly targetCredential: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly phase: typeof PROJECT_RECOVERY_CLAIMANT_PHASES[number];
  readonly invitation: ProjectRecoveryInvitation;
  readonly redemptionRequest: RedeemProjectRecoveryLinkRequest;
  readonly redemptionReceipt: RedeemProjectRecoveryLinkResponse | null;
  readonly convergence: ProjectRecoveryConvergenceIntent | null;
  readonly retainedAttempts: readonly AuthorityTransferClaimantRecord[];
}

const KEYS = ['schemaVersion', 'kind', 'variant', 'projectId', 'memberId', 'memberPersonalRef', 'operationIntentId', 'cloudPrincipalId',
  'targetCredential', 'createdAt', 'updatedAt', 'phase', 'invitation', 'redemptionRequest', 'redemptionReceipt', 'convergence', 'retainedAttempts'];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid recovery record');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !(key in value))) throw new TypeError('Invalid recovery fields');
}
function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new TypeError('Invalid recovery time');
  return value;
}

export function decodeProjectRecoveryClaimantRecord(
  input: unknown, decodePredecessor: (value: unknown) => AuthorityTransferClaimantRecord,
): ProjectRecoveryClaimantRecord {
  const value = object(input);
  exact(value, KEYS);
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  if (value.schemaVersion !== 5 || value.kind !== 'authority-transfer-claimant' || value.variant !== 'project-recovery'
    || !isCollabProjectId(value.projectId) || !isCollabMemberId(value.memberId) || !isCollabOpaqueId(value.operationIntentId)
    || value.memberPersonalRef !== collabMemberRef(value.memberId) || updatedAt < createdAt
    || typeof value.phase !== 'string' || !PROJECT_RECOVERY_CLAIMANT_PHASES.includes(value.phase as never)) throw new TypeError('Invalid recovery identity');
  const invitation = decodeProjectRecoveryInvitation(encodeProjectRecoveryInvitation(value.invitation as ProjectRecoveryInvitation));
  const decoded = collabControlOperationCodec('redeemProjectRecoveryLink').decodeRequest(value.redemptionRequest);
  if (decoded.status !== 'ok') throw new TypeError('Invalid recovery request');
  const request = decoded.value;
  if (invitation.link.projectId !== value.projectId || request.projectId !== value.projectId || request.idempotencyKey !== value.operationIntentId
    || request.recoveryLinkId !== invitation.link.recoveryLinkId || request.token !== invitation.link.token
    || request.expectedAuthorityGeneration !== invitation.link.authorityGeneration) throw new TypeError('Invalid recovery request identity');
  const { cloudPrincipalId, targetCredential } = value;
  if (invitation.target.kind === 'cloud') {
    if (typeof cloudPrincipalId !== 'string' || !/^vault-[a-f0-9]{64}$/.test(cloudPrincipalId)
      || targetCredential !== null || request.targetCredentialHash !== undefined) throw new TypeError('Invalid Cloud recovery credential');
  } else if (cloudPrincipalId !== null || typeof targetCredential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(targetCredential)
    || Buffer.from(targetCredential, 'base64url').toString('base64url') !== targetCredential
    || request.targetCredentialHash !== createHash('sha256').update(targetCredential, 'utf8').digest('hex')) throw new TypeError('Invalid LAN recovery credential');
  const receipt = value.redemptionReceipt === null ? null : collabControlOperationCodec('redeemProjectRecoveryLink').decodeResponse(value.redemptionReceipt);
  if (receipt && (receipt.projectId !== value.projectId || receipt.memberId !== value.memberId || receipt.personalRef !== value.memberPersonalRef
    || receipt.authorityGeneration !== invitation.link.authorityGeneration || receipt.recoveryLinkId !== invitation.link.recoveryLinkId
    || Date.parse(receipt.recoveredAt) >= Date.parse(invitation.link.expiresAt))) throw new TypeError('Invalid recovery receipt identity');
  let convergence: ProjectRecoveryConvergenceIntent | null = null;
  if (value.convergence !== null) {
    const plan = object(value.convergence);
    exact(plan, ['target', 'identity', 'previousBindings']);
    const target = decodeProjectRecoveryInvitation(encodeProjectRecoveryInvitation({ link: invitation.link, target: plan.target as ProjectRecoveryTarget })).target;
    const identity = decodeAuthorityTransferImportedTargetIdentity(plan.identity);
    if (target.kind !== invitation.target.kind || target.kind === 'cloud' && (invitation.target.kind !== 'cloud' || target.serverUrl !== invitation.target.serverUrl)
      || target.kind === 'lan' && (invitation.target.kind !== 'lan' || target.caFingerprint !== invitation.target.caFingerprint || target.caCertificatePem !== invitation.target.caCertificatePem)
      || identity.project.id !== value.projectId || identity.currentMember.id !== value.memberId
      || identity.currentMember.personalRef !== value.memberPersonalRef || identity.authorityGeneration !== invitation.link.authorityGeneration
      || !Array.isArray(plan.previousBindings) || plan.previousBindings.length === 0 || plan.previousBindings.length > 32) throw new TypeError('Invalid recovery convergence');
    const previousBindings = plan.previousBindings.map((entry: unknown) => {
      const binding = object(entry);
      exact(binding, ['remoteUrl', 'serverUrl']);
      if (typeof binding.remoteUrl !== 'string' || binding.serverUrl !== null && typeof binding.serverUrl !== 'string') throw new TypeError('Invalid recovery origin');
      return { remoteUrl: validateCloudServerURL(binding.remoteUrl, 'remoteUrl'), serverUrl: binding.serverUrl === null ? null : validateCloudServerURL(binding.serverUrl, 'serverUrl') };
    });
    convergence = { target, identity, previousBindings };
  }
  const phase = value.phase as ProjectRecoveryClaimantRecord['phase'];
  const index = PROJECT_RECOVERY_CLAIMANT_PHASES.indexOf(phase);
  if ((index >= 1) !== (receipt !== null) || (index >= 2) !== (convergence !== null)
    || !Array.isArray(value.retainedAttempts) || value.retainedAttempts.length > 16) throw new TypeError('Invalid recovery progress');
  const retainedAttempts = value.retainedAttempts.map((entry: unknown) => {
    const candidate = object(entry);
    if ('retainedAttempts' in candidate && (!Array.isArray(candidate.retainedAttempts) || candidate.retainedAttempts.length !== 0)) throw new TypeError('Invalid nested recovery predecessor');
    const attempt = decodePredecessor(entry);
    if (attempt.projectId !== value.projectId || attempt.memberId !== value.memberId
      || attempt.variant === 'source-issued' && attempt.managerPredecessor !== null) throw new TypeError('Invalid recovery predecessor');
    return attempt;
  });
  return { schemaVersion: 5, kind: 'authority-transfer-claimant', variant: 'project-recovery', projectId: value.projectId,
    memberId: value.memberId, memberPersonalRef: value.memberPersonalRef, operationIntentId: value.operationIntentId,
    cloudPrincipalId: cloudPrincipalId, targetCredential: targetCredential, createdAt, updatedAt, phase,
    invitation, redemptionRequest: request, redemptionReceipt: receipt, convergence, retainedAttempts };
}
