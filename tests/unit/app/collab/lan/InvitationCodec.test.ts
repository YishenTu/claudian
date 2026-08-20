import {
  InvitationCodec,
  type InvitationCodecOptions,
} from '@/app/collab/lan/InvitationCodec';
import {
  COLLAB_CONTROL_PROTOCOL_VERSION,
  COLLAB_INVITATION_TTL_MS,
} from '@/app/collab/lan/LanCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';

const NOW = new Date('2026-08-08T00:00:00.000Z');
const FINGERPRINT = 'ab'.repeat(32);

function options(): InvitationCodecOptions {
  const values = [Buffer.alloc(32, 1), Buffer.alloc(32, 2)];
  return {
    isAddressAllowed: address => address === '127.0.0.1',
    now: () => NOW,
    randomBytes: () => values.shift() ?? Buffer.alloc(32, 3),
  };
}

describe('InvitationCodec', () => {
  it('creates, encodes, and decodes a canonical versioned invitation', () => {
    const codec = new InvitationCodec(options());
    const invitation = codec.createInvitation({
      caFingerprint: FINGERPRINT,
      endpoint: 'https://127.0.0.1:54545',
      invitationId: 'invite-alpha',
      projectId: 'project-alpha',
    });

    expect(invitation).toMatchObject({
      caFingerprint: FINGERPRINT,
      endpoint: 'https://127.0.0.1:54545',
      expiresAt: new Date(NOW.getTime() + COLLAB_INVITATION_TTL_MS).toISOString(),
      invitationId: 'invite-alpha',
      projectId: 'project-alpha',
      protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
    });
    expect(Buffer.from(invitation.invitationSecret, 'base64url')).toHaveLength(32);

    const encoded = codec.encode(invitation);
    expect(encoded).toMatch(/^claudian-collab:v9:[A-Za-z0-9_-]+$/);
    expect(codec.decode(encoded)).toEqual(invitation);
  });

  it('rejects invitation and Project IDs outside their owning grammars', () => {
    const codec = new InvitationCodec(options());
    for (const field of [
      { invitationId: 'invite.dotted', projectId: 'project-alpha' },
      { invitationId: 'invite-alpha', projectId: 'project.dotted' },
      { invitationId: 'invite-alpha', projectId: `p${'a'.repeat(64)}` },
    ]) {
      expect(() => codec.validateInvitation({
        caFingerprint: FINGERPRINT,
        endpoint: 'https://127.0.0.1:54545',
        expiresAt: '2026-08-08T00:15:00.000Z',
        invitationId: field.invitationId,
        invitationSecret: Buffer.alloc(32, 4).toString('base64url'),
        projectId: field.projectId,
        protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
      })).toThrow(expect.objectContaining({ code: 'invitation-invalid' }));
    }
  });

  it('rotates full-entropy secrets and compares only their SHA-256 digests', () => {
    const codec = new InvitationCodec(options());
    const first = codec.createInvitation({
      caFingerprint: FINGERPRINT,
      endpoint: 'https://127.0.0.1:54545',
      invitationId: 'invite-first',
      projectId: 'project-alpha',
    });
    const rotated = codec.createInvitation({
      caFingerprint: FINGERPRINT,
      endpoint: 'https://127.0.0.1:54545',
      invitationId: 'invite-rotated',
      projectId: 'project-alpha',
    });
    const rotatedDigest = codec.hashSecret(rotated.invitationSecret);

    expect(rotated.invitationSecret).not.toBe(first.invitationSecret);
    expect(codec.matchesSecret(rotated.invitationSecret, rotatedDigest)).toBe(true);
    expect(codec.matchesSecret(first.invitationSecret, rotatedDigest)).toBe(false);
    expect(rotatedDigest).not.toContain(rotated.invitationSecret);
  });

  it.each([
    ['public endpoint', {
      endpoint: 'https://203.0.113.4:54545',
    }, 'invitation-invalid', { reason: 'endpoint-address-not-private' }],
    ['expired payload', {
      expiresAt: '2026-08-07T23:59:59.999Z',
    }, 'invitation-expired', { reason: 'invitation-expired' }],
    ['short secret', {
      invitationSecret: Buffer.alloc(16, 1).toString('base64url'),
    }, 'invitation-invalid', { field: 'invitationSecret' }],
  ] as const)(
    'rejects an invalid %s without exposing its secret',
    (_name, change, expectedCode, expectedContext) => {
      const secret = Buffer.alloc(32, 9).toString('base64url');
      const codec = new InvitationCodec({ now: () => NOW });
      const invitation = {
        caFingerprint: FINGERPRINT,
        endpoint: 'https://192.168.1.10:54545',
        expiresAt: '2026-08-08T00:15:00.000Z',
        invitationId: 'invite-alpha',
        invitationSecret: secret,
        projectId: 'project-alpha',
        protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
        ...change,
      };

      let thrown: unknown;
      try {
        codec.encode(invitation);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(CollabError);
      expect(JSON.stringify(thrown)).not.toContain(secret);
      expect(thrown).toMatchObject({
        code: expectedCode,
        safeContext: expectedContext,
      });
    },
  );

  it('rejects unknown payload fields and unsupported prefix versions', () => {
    const codec = new InvitationCodec(options());
    const payload = {
      caFingerprint: FINGERPRINT,
      endpoint: 'https://127.0.0.1:54545',
      expiresAt: '2026-08-08T00:15:00.000Z',
      invitationId: 'invite-alpha',
      invitationSecret: Buffer.alloc(32, 4).toString('base64url'),
      projectId: 'project-alpha',
      protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
      futureField: true,
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');

    expect(() => codec.decode(`claudian-collab:v9:${encodedPayload}`)).toThrow(
      expect.objectContaining({ code: 'invitation-invalid' }),
    );
    expect(() => codec.decode(`claudian-collab:v3:${encodedPayload}`)).toThrow(
      expect.objectContaining({ code: 'protocol-version-unsupported' }),
    );
  });

  it('keeps interactive decoding strict v9 while privately normalizing a stored v7 Join', () => {
    const codec = new InvitationCodec(options());
    const legacyPayload = {
      caFingerprint: FINGERPRINT,
      endpoint: 'https://127.0.0.1:54545',
      expiresAt: '2026-08-08T00:15:00.000Z',
      invitationId: 'invite-alpha',
      invitationSecret: Buffer.alloc(32, 4).toString('base64url'),
      projectId: 'project-alpha',
      protocolVersion: 7,
    };
    const encodedPayload = Buffer.from(JSON.stringify(legacyPayload)).toString('base64url');
    const encodedInvitation = `claudian-collab:v7:${encodedPayload}`;

    expect(() => codec.decode(encodedInvitation)).toThrow(expect.objectContaining({
      code: 'protocol-version-unsupported',
    }));
    expect(codec.decodePendingJoinRecovery(encodedInvitation)).toEqual({
      ...legacyPayload,
      protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
    });
  });

  it('fails closed when a stored v7 Join prefix and payload version do not match', () => {
    const codec = new InvitationCodec(options());
    const payload = {
      caFingerprint: FINGERPRINT,
      endpoint: 'https://127.0.0.1:54545',
      expiresAt: '2026-08-08T00:15:00.000Z',
      invitationId: 'invite-alpha',
      invitationSecret: Buffer.alloc(32, 4).toString('base64url'),
      projectId: 'project-alpha',
      protocolVersion: COLLAB_CONTROL_PROTOCOL_VERSION,
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');

    expect(() => codec.decodePendingJoinRecovery(
      `claudian-collab:v7:${encodedPayload}`,
    )).toThrow(expect.objectContaining({ code: 'protocol-version-unsupported' }));
  });
});
