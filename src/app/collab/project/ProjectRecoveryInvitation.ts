import { X509Certificate } from 'node:crypto';

import { collabControlOperationCodec, type CreateProjectRecoveryLinkResponse } from '@claudian-collab/protocol';

import { validateCloudServerUrl } from '@/app/collab/remote-authority/CloudAuthorityUrls';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export type ProjectRecoveryTarget = { readonly kind: 'cloud'; readonly serverUrl: string } | {
  readonly kind: 'lan'; readonly endpoint: string; readonly caCertificatePem: string; readonly caFingerprint: string;
};
export interface ProjectRecoveryInvitation {
  readonly link: CreateProjectRecoveryLinkResponse;
  readonly target: ProjectRecoveryTarget;
}

const PREFIX = 'claudian-recovery:v1:';

export function encodeProjectRecoveryInvitation(value: ProjectRecoveryInvitation): string {
  const encoded = `${PREFIX}${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
  decodeProjectRecoveryInvitation(encoded);
  return encoded;
}

export function decodeProjectRecoveryInvitation(encoded: string): ProjectRecoveryInvitation {
  try {
    if (encoded.length > 32 * 1024 || !encoded.startsWith(PREFIX)) throw new TypeError();
    const payload = encoded.slice(PREFIX.length);
    const bytes = Buffer.from(payload, 'base64url');
    if (!/^[A-Za-z0-9_-]+$/.test(payload) || bytes.toString('base64url') !== payload) throw new TypeError();
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
      || !('link' in value) || !('target' in value) || !value.target || typeof value.target !== 'object' || Array.isArray(value.target)) throw new TypeError();
    const link = collabControlOperationCodec('createProjectRecoveryLink').decodeResponse(value.link);
    const target = value.target as Record<string, unknown>;
    if (target.kind === 'cloud' && Object.keys(target).length === 2 && typeof target.serverUrl === 'string') {
      return { link, target: { kind: 'cloud', serverUrl: validateCloudServerUrl(target.serverUrl, 'serverUrl') } };
    }
    if (target.kind !== 'lan' || Object.keys(target).length !== 4 || typeof target.endpoint !== 'string'
      || typeof target.caFingerprint !== 'string' || typeof target.caCertificatePem !== 'string'
      || target.caCertificatePem.length > 16 * 1024 || target.caCertificatePem.includes('PRIVATE KEY')) throw new TypeError();
    const endpoint = validateCloudServerUrl(target.endpoint, 'endpoint');
    const certificate = new X509Certificate(target.caCertificatePem);
    if (!endpoint.startsWith('https://') || !certificate.ca
      || certificate.fingerprint256.replaceAll(':', '').toLowerCase() !== target.caFingerprint) throw new TypeError();
    return { link, target: { kind: 'lan', endpoint, caCertificatePem: target.caCertificatePem, caFingerprint: target.caFingerprint } };
  } catch {
    throw new CollabError({ code: 'invitation-invalid', recoveryActions: ['refresh-invitation'] });
  }
}
