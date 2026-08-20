import {
  createHash,
  randomBytes as secureRandomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { isIP } from 'node:net';

import { isCollabOpaqueId, isCollabProjectId } from '@claudian/collab-protocol';

import {
  COLLAB_CONTROL_PROTOCOL_VERSION,
  COLLAB_INVITATION_TTL_MS,
  COLLAB_TOKEN_BYTES,
} from '@/app/collab/lan/LanCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const INVITATION_PREFIX = 'claudian-collab';
const LEGACY_PENDING_JOIN_PROTOCOL_VERSION = 7;
const MAX_ENCODED_INVITATION_LENGTH = 8 * 1024;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface LanCollabInvitation {
  readonly caFingerprint: string;
  readonly endpoint: string;
  readonly expiresAt: string;
  readonly invitationId: string;
  readonly invitationSecret: string;
  readonly projectId: string;
  readonly protocolVersion: typeof COLLAB_CONTROL_PROTOCOL_VERSION;
}

export type LanCollabInvitationDecodeResult =
  | { readonly status: 'ok'; readonly value: LanCollabInvitation }
  | { readonly status: 'invalid'; readonly error: CollabError };

export function decodeLanCollabInvitation(
  input: unknown,
): LanCollabInvitationDecodeResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { status: 'invalid', error: invitationError('invitation-payload-invalid') };
  }
  const value = input as Readonly<Record<string, unknown>>;
  const expectedKeys = [
    'caFingerprint', 'endpoint', 'expiresAt', 'invitationId',
    'invitationSecret', 'projectId', 'protocolVersion',
  ];
  if (
    Object.keys(value).length !== expectedKeys.length
    || !expectedKeys.every(key => Object.hasOwn(value, key))
    || value.protocolVersion !== COLLAB_CONTROL_PROTOCOL_VERSION
    || typeof value.caFingerprint !== 'string'
    || typeof value.endpoint !== 'string'
    || typeof value.expiresAt !== 'string'
    || typeof value.invitationId !== 'string'
    || typeof value.invitationSecret !== 'string'
    || typeof value.projectId !== 'string'
  ) {
    return { status: 'invalid', error: invitationError('invitation-payload-invalid') };
  }
  return { status: 'ok', value: value as unknown as LanCollabInvitation };
}

export interface InvitationCodecOptions {
  readonly isAddressAllowed?: (address: string) => boolean;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Buffer;
}

export interface CreateCollabInvitationInput {
  readonly caFingerprint: string;
  readonly endpoint: string;
  readonly expiresAt?: string;
  readonly invitationId: string;
  readonly invitationSecret?: string;
  readonly projectId: string;
}

function invitationError(
  reason: string,
  options: {
    readonly code?: 'invitation-expired' | 'invitation-invalid';
    readonly field?: string;
    readonly receivedVersion?: number;
  } = {},
): CollabError {
  return new CollabError({
    code: options.code ?? 'invitation-invalid',
    recoveryActions: ['refresh-invitation'],
    safeContext: {
      reason,
      ...(options.field ? { field: options.field } : {}),
      ...(options.receivedVersion === undefined
        ? {}
        : { receivedVersion: options.receivedVersion }),
    },
  });
}

function isPrivateIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function decodeCanonicalSecret(secret: string): Buffer | null {
  if (!BASE64URL_PATTERN.test(secret)) return null;
  try {
    const decoded = Buffer.from(secret, 'base64url');
    if (
      decoded.length !== COLLAB_TOKEN_BYTES
      || decoded.toString('base64url') !== secret
    ) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export class InvitationCodec {
  private readonly isAddressAllowed: (address: string) => boolean;
  private readonly now: () => Date;
  private readonly randomBytes: (size: number) => Buffer;

  constructor(options: InvitationCodecOptions = {}) {
    this.isAddressAllowed = options.isAddressAllowed ?? isPrivateIpv4;
    this.now = options.now ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? secureRandomBytes;
  }

  createInvitation(input: CreateCollabInvitationInput): LanCollabInvitation {
    const invitation: LanCollabInvitation = {
      caFingerprint: input.caFingerprint,
      endpoint: input.endpoint,
      expiresAt: input.expiresAt
        ?? new Date(this.now().getTime() + COLLAB_INVITATION_TTL_MS).toISOString(),
      invitationId: input.invitationId,
      invitationSecret: input.invitationSecret
        ?? this.randomBytes(COLLAB_TOKEN_BYTES).toString('base64url'),
      projectId: input.projectId,
      protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
    };
    return this.validateInvitation(invitation);
  }

  encode(invitation: LanCollabInvitation): string {
    const validated = this.validateInvitation(invitation);
    const payload = Buffer.from(JSON.stringify(validated), 'utf8').toString('base64url');
    return `${INVITATION_PREFIX}:v${COLLAB_CONTROL_PROTOCOL_VERSION}:${payload}`;
  }

  decode(encodedInvitation: string): LanCollabInvitation {
    const { payload, prefixVersion } = this.decodeEncodedPayload(encodedInvitation);
    if (prefixVersion !== COLLAB_CONTROL_PROTOCOL_VERSION) {
      throw this.unsupportedVersion(prefixVersion);
    }
    return this.decodeCurrentPayload(payload);
  }

  decodePendingJoinRecovery(encodedInvitation: string): LanCollabInvitation {
    const { payload, prefixVersion } = this.decodeEncodedPayload(encodedInvitation);
    if (prefixVersion === COLLAB_CONTROL_PROTOCOL_VERSION) {
      return this.decodeCurrentPayload(payload);
    }
    if (
      prefixVersion !== LEGACY_PENDING_JOIN_PROTOCOL_VERSION
      || !payload
      || typeof payload !== 'object'
      || Array.isArray(payload)
      || (payload as Readonly<Record<string, unknown>>).protocolVersion
        !== LEGACY_PENDING_JOIN_PROTOCOL_VERSION
    ) {
      throw this.unsupportedVersion(prefixVersion);
    }
    return this.decodeCurrentPayload({
      ...(payload as Readonly<Record<string, unknown>>),
      protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
    });
  }

  private decodeEncodedPayload(encodedInvitation: string): {
    readonly payload: unknown;
    readonly prefixVersion: number;
  } {
    if (
      encodedInvitation.length === 0
      || encodedInvitation.length > MAX_ENCODED_INVITATION_LENGTH
    ) {
      throw invitationError('invitation-length-invalid');
    }
    const match = /^claudian-collab:v(\d+):([A-Za-z0-9_-]+)$/.exec(encodedInvitation);
    if (!match) throw invitationError('invitation-format-invalid');
    const prefixVersion = Number(match[1]);
    let payload: unknown;
    try {
      const bytes = Buffer.from(match[2], 'base64url');
      if (bytes.toString('base64url') !== match[2]) {
        throw new Error('Non-canonical invitation payload');
      }
      payload = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw invitationError('invitation-payload-invalid');
    }
    return { payload, prefixVersion };
  }

  private decodeCurrentPayload(payload: unknown): LanCollabInvitation {
    const decoded = decodeLanCollabInvitation(payload);
    if (decoded.status !== 'ok') throw decoded.error;
    return this.validateInvitation(decoded.value);
  }

  private unsupportedVersion(receivedVersion: number): CollabError {
    return new CollabError({
      code: 'protocol-version-unsupported',
      recoveryActions: ['refresh-invitation'],
      safeContext: {
        receivedVersion,
        supportedVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
      },
    });
  }

  validateInvitation(invitation: LanCollabInvitation): LanCollabInvitation {
    const decoded = decodeLanCollabInvitation(invitation);
    if (decoded.status !== 'ok') throw decoded.error;
    const value = decoded.value;
    if (!isCollabOpaqueId(value.invitationId)) {
      throw invitationError('invitation-id-invalid', { field: 'invitationId' });
    }
    if (!isCollabProjectId(value.projectId)) {
      throw invitationError('project-id-invalid', { field: 'projectId' });
    }
    const endpoint = this.normalizeEndpoint(value.endpoint);
    if (!FINGERPRINT_PATTERN.test(value.caFingerprint)) {
      throw invitationError('ca-fingerprint-invalid', { field: 'caFingerprint' });
    }
    const expiresAtMs = Date.parse(value.expiresAt);
    if (
      !Number.isFinite(expiresAtMs)
      || new Date(expiresAtMs).toISOString() !== value.expiresAt
    ) {
      throw invitationError('invitation-expiry-invalid', { field: 'expiresAt' });
    }
    if (expiresAtMs <= this.now().getTime()) {
      throw invitationError('invitation-expired', { code: 'invitation-expired' });
    }
    if (!decodeCanonicalSecret(value.invitationSecret)) {
      throw invitationError('invitation-secret-invalid', { field: 'invitationSecret' });
    }
    return Object.freeze({ ...value, endpoint });
  }

  hashSecret(secret: string): string {
    const decoded = decodeCanonicalSecret(secret);
    if (!decoded) throw invitationError('invitation-secret-invalid');
    return createHash('sha256').update(decoded).digest('base64url');
  }

  matchesSecret(secret: string, expectedDigest: string): boolean {
    const decoded = decodeCanonicalSecret(secret);
    if (!decoded || !BASE64URL_PATTERN.test(expectedDigest)) return false;
    let expected: Buffer;
    try {
      expected = Buffer.from(expectedDigest, 'base64url');
    } catch {
      return false;
    }
    const actual = createHash('sha256').update(decoded).digest();
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  }

  normalizeEndpoint(endpoint: string): string {
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw invitationError('endpoint-invalid', { field: 'endpoint' });
    }
    if (
      parsed.protocol !== 'https:'
      || parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.search.length > 0
      || parsed.hash.length > 0
      || parsed.pathname !== '/'
      || parsed.port.length === 0
      || isIP(parsed.hostname) !== 4
    ) {
      throw invitationError('endpoint-invalid', { field: 'endpoint' });
    }
    const port = Number(parsed.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw invitationError('endpoint-port-invalid', { field: 'endpoint' });
    }
    if (!this.isAddressAllowed(parsed.hostname)) {
      throw invitationError('endpoint-address-not-private', { field: 'endpoint' });
    }
    return `https://${parsed.hostname}:${port}`;
  }
}
