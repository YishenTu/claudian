import { LANHostTransferSourceIdentity } from '@/app/collab/host-transfer/LANHostTransferSourceIdentity';

describe('LANHostTransferSourceIdentity', () => {
  it('exposes only the narrow CA signer and Project Member credential', async () => {
    const signer = {
      caCertificatePem: 'certificate',
      caFingerprint: 'a'.repeat(64),
      signRsaPssSha256: jest.fn(),
    };
    const tlsIdentity = { hostCaSigner: jest.fn().mockResolvedValue(signer) };
    const projects = {
      loadMembership: jest.fn().mockResolvedValue({
        authority: { kind: 'lan' },
        member: { credential: 'credential' },
        project: { id: 'project-a' },
      }),
    };
    const identity = new LANHostTransferSourceIdentity(tlsIdentity, projects as never);

    await expect(identity.hostCaSigner()).resolves.toBe(signer);
    await expect(identity.memberCredential('project-a')).resolves.toBe('credential');
    expect(JSON.stringify(identity)).not.toContain('privateKey');
  });
});
