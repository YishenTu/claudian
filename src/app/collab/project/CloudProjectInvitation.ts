import { collabControlOperationCodec,type CollabControlOperationMap } from '@claudian-collab/protocol';

import { validateCloudServerUrl } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CloudProjectInvitation {
  readonly kind: 'cloud-invitation';
  readonly serverUrl: string;
  readonly invitation: CollabControlOperationMap['createProjectInvitation']['response'];
}

export interface CloudMembershipClaimInvitation {
  readonly kind: 'cloud-membership-claim';
  readonly serverUrl: string;
  readonly claim: CollabControlOperationMap['reissueTransferredMembershipClaim']['response'];
}

export function encodeCloudProjectInvitation(value: Omit<CloudProjectInvitation, 'kind'>): string {
  const encoded = `claudian-cloud:v1:${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
  decodeCloudProjectInvitation(encoded);
  return encoded;
}

export function decodeCloudProjectInvitation(encoded: string): CloudProjectInvitation {
  const value = decodeEnvelope(encoded, 'claudian-cloud:v1:', 'invitation', collabControlOperationCodec('createProjectInvitation').decodeResponse);
  return { kind: 'cloud-invitation', invitation: value.payload, serverUrl: value.serverUrl };
}

export function encodeCloudMembershipClaimInvitation(value: Omit<CloudMembershipClaimInvitation, 'kind'>): string {
  const encoded = `claudian-cloud-claim:v1:${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
  decodeCloudMembershipClaimInvitation(encoded);
  return encoded;
}

export function decodeCloudMembershipClaimInvitation(encoded: string): CloudMembershipClaimInvitation {
  const value = decodeEnvelope(encoded, 'claudian-cloud-claim:v1:', 'claim', collabControlOperationCodec('reissueTransferredMembershipClaim').decodeResponse);
  return { kind: 'cloud-membership-claim', claim: value.payload, serverUrl: value.serverUrl };
}

function decodeEnvelope<T>(encoded: string, prefix: string, field: 'invitation' | 'claim', decode: (value: unknown) => T): { serverUrl: string; payload: T } {
  try {
    if (encoded.length > 8 * 1024) throw new TypeError('Invitation too large');
    if (!encoded.startsWith(prefix)) throw new TypeError('Invalid invitation');
    const payload = encoded.slice(prefix.length);
    if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw new TypeError('Invalid invitation');
    const bytes = Buffer.from(payload, 'base64url');
    if (bytes.toString('base64url') !== payload) throw new TypeError('Invalid encoding');
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 2 || !('serverUrl' in value) || !(field in value)
      || typeof value.serverUrl !== 'string') throw new TypeError('Invalid invitation');
    return {
      payload: decode((value as Record<string, unknown>)[field]),
      serverUrl: validateCloudServerUrl(value.serverUrl, 'serverUrl'),
    };
  } catch {
    throw new CollabError({ code: 'invitation-invalid', recoveryActions: ['refresh-invitation'] });
  }
}
