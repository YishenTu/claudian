import { decodeProjectRecoveryInvitation, encodeProjectRecoveryInvitation } from '@/app/collab/project/ProjectRecoveryInvitation';

describe('Project recovery invitation', () => {
  it('carries the complete Project and Cloud destination without an external lookup', () => {
    const invitation = { target: { kind: 'cloud' as const, serverUrl: 'http://100.89.0.41:8787' },
      link: { projectId: 'project-demo', recoveryLinkId: 'recovery-first', authorityGeneration: 4,
        token: 'a'.repeat(64), expiresAt: '2026-09-14T12:15:00.000Z', secretReplayExpiresAt: '2026-09-14T12:10:00.000Z' } };
    const encoded = encodeProjectRecoveryInvitation(invitation);
    expect(decodeProjectRecoveryInvitation(encoded)).toEqual(invitation);
    expect(() => decodeProjectRecoveryInvitation(encoded + '=')).toThrow();
    expect(() => encodeProjectRecoveryInvitation({ ...invitation, target: { kind: 'cloud', serverUrl: 'https://user:password@example.com' } })).toThrow();
    expect(() => encodeProjectRecoveryInvitation({ ...invitation, target: { kind: 'cloud', serverUrl: 'https://example.com?token=private' } })).toThrow();
    expect(() => encodeProjectRecoveryInvitation({ ...invitation, link: { ...invitation.link, memberId: 'member-other' } } as never)).toThrow();
  });
});
