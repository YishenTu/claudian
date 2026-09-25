import { X509Certificate } from 'node:crypto';

import { collabControlOperationCodec, type ReissueTransferredMembershipClaimResponse } from '@claudian-collab/protocol';

import type { AuthorityTransferClaimantLANTarget } from '@/app/collab/authority-transfer/claim/AuthorityTransferClaimantRecord';
import { validateCloudServerURL } from '@/app/collab/remote-authority/CloudAuthorityURLs';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface LANMembershipClaimInvitation {
  readonly kind: 'lan-membership-claim';
  readonly claim: ReissueTransferredMembershipClaimResponse;
  readonly targetHost: AuthorityTransferClaimantLANTarget;
}

const PREFIX = 'claudian-lan-claim:v1:';

export function encodeLANMembershipClaimInvitation(value: Omit<LANMembershipClaimInvitation, 'kind'>): string {
  const encoded = `${PREFIX}${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
  decodeLANMembershipClaimInvitation(encoded);
  return encoded;
}

export function decodeLANMembershipClaimInvitation(encoded: string): LANMembershipClaimInvitation {
  try {
    if (encoded.length > 32 * 1024 || !encoded.startsWith(PREFIX)) throw new TypeError('Invalid invitation');
    const payload = encoded.slice(PREFIX.length);
    const bytes = Buffer.from(payload, 'base64url');
    if (!/^[A-Za-z0-9_-]+$/.test(payload) || bytes.toString('base64url') !== payload) throw new TypeError('Invalid invitation');
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 2 || !('targetHost' in value) || !('claim' in value)
      || !value.targetHost || typeof value.targetHost !== 'object' || Array.isArray(value.targetHost)
      || Object.keys(value.targetHost).length !== 3) throw new TypeError('Invalid invitation');
    const claim = collabControlOperationCodec('reissueTransferredMembershipClaim').decodeResponse(value.claim);
    const host = value.targetHost as Record<string, unknown>;
    const { caCertificatePem, caFingerprint } = host;
    if (typeof host.endpoint !== 'string') throw new TypeError('Invalid invitation');
    const endpoint = validateCloudServerURL(host.endpoint, 'endpoint');
    if (!endpoint.startsWith('https://') || typeof caCertificatePem !== 'string' || caCertificatePem.length > 16 * 1024
      || caCertificatePem.includes('PRIVATE KEY') || typeof caFingerprint !== 'string') throw new TypeError('Invalid invitation');
    const certificate = new X509Certificate(caCertificatePem);
    if (!certificate.ca || certificate.fingerprint256.replaceAll(':', '').toLowerCase() !== caFingerprint) throw new TypeError('Invalid invitation');
    return { kind: 'lan-membership-claim', claim, targetHost: { caCertificatePem, caFingerprint, endpoint } };
  } catch {
    throw new CollabError({ code: 'invitation-invalid', recoveryActions: ['refresh-invitation'] });
  }
}
