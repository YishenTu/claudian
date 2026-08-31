import { collabControlOperationCodec,type CollabControlOperationMap } from '@claudian-collab/protocol';

import { validateCloudServerUrl } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CloudProjectInvitation {
  readonly kind: 'cloud-invitation';
  readonly serverUrl: string;
  readonly invitation: CollabControlOperationMap['createProjectInvitation']['response'];
}

export function decodeCloudProjectInvitation(encoded: string): CloudProjectInvitation {
  try {
    if (encoded.length > 8 * 1024) throw new TypeError('Invitation too large');
    const match = /^claudian-cloud:v1:([A-Za-z0-9_-]+)$/.exec(encoded);
    if (!match) throw new TypeError('Invalid invitation');
    const bytes = Buffer.from(match[1], 'base64url');
    if (bytes.toString('base64url') !== match[1]) throw new TypeError('Invalid encoding');
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 2 || !('serverUrl' in value) || !('invitation' in value)
      || typeof value.serverUrl !== 'string') throw new TypeError('Invalid invitation');
    return {
      kind: 'cloud-invitation',
      invitation: collabControlOperationCodec('createProjectInvitation').decodeResponse(value.invitation),
      serverUrl: validateCloudServerUrl(value.serverUrl, 'serverUrl'),
    };
  } catch {
    throw new CollabError({ code: 'invitation-invalid', recoveryActions: ['refresh-invitation'] });
  }
}
