import type { CollabLocalLanMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { LanAuthorityTargetResolver } from '@/app/collab/remote-authority/LanAuthorityTargetResolver';

const PROJECT_ID = 'project-local-target';
const CERTIFICATE = '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----';
const FINGERPRINT = 'a'.repeat(64);

function membership(): CollabLocalLanMembershipRecord {
  return {
    authority: {
      endpoint: 'https://192.168.1.20:41730',
      gitRemoteUrl: `https://192.168.1.20:41730/v1/git/${PROJECT_ID}/repository.git`,
      hostCaCertificatePem: CERTIFICATE,
      hostCaFingerprint: FINGERPRINT,
      kind: 'lan',
    },
    createdAt: '2026-08-28T00:00:00.000Z',
    hostOwnership: { ownsAuthority: true },
    lastEventSequence: 0,
    member: {
      credential: 'c'.repeat(43),
      displayName: 'Alice',
      id: 'member-alice',
      personalRef: 'refs/heads/members/member-alice',
      role: 'manager',
    },
    project: { id: PROJECT_ID, name: 'Project', workspacePath: `workspace/${PROJECT_ID}` },
    schemaVersion: COLLAB_LOCAL_PROJECT_SCHEMA_VERSION,
    updatedAt: '2026-08-28T00:00:00.000Z',
  };
}

describe('LanAuthorityTargetResolver', () => {
  const activeRoute = {
    caCertificatePem: CERTIFICATE,
    caFingerprint: FINGERPRINT,
    endpoint: 'https://192.168.1.44:41731',
    projectId: PROJECT_ID,
  };

  it('selects only a hosted-here active route with the pinned Project CA identity', async () => {
    const resolver = new LanAuthorityTargetResolver({
      inspectInstallation: jest.fn().mockResolvedValue('hosted-here'),
      readActiveRoute: jest.fn().mockReturnValue(activeRoute),
    });

    await expect(resolver.resolve(membership())).resolves.toEqual({
      endpoint: activeRoute.endpoint,
    });
  });

  it.each([
    ['hosted elsewhere', 'hosted-elsewhere', activeRoute],
    ['matching stored IP without local ownership', 'hosted-elsewhere', {
      ...activeRoute,
      endpoint: membership().authority.endpoint,
    }],
    ['legacy unbound', 'legacy-unbound', activeRoute],
    ['stopped Host', 'hosted-here', null],
    ['wrong Project', 'hosted-here', { ...activeRoute, projectId: 'project-other' }],
    ['mismatched fingerprint', 'hosted-here', { ...activeRoute, caFingerprint: 'b'.repeat(64) }],
    ['mismatched certificate', 'hosted-here', { ...activeRoute, caCertificatePem: `${CERTIFICATE}\n` }],
  ])('rejects the %s local shortcut', async (_label, status, route) => {
    const resolver = new LanAuthorityTargetResolver({
      inspectInstallation: jest.fn().mockResolvedValue(status),
      readActiveRoute: jest.fn().mockReturnValue(route),
    });

    await expect(resolver.resolve(membership())).resolves.toBeNull();
  });

  it('treats invalid local marker state as ineligible for the optional local shortcut', async () => {
    const readActiveRoute = jest.fn().mockReturnValue(activeRoute);
    const resolver = new LanAuthorityTargetResolver({
      inspectInstallation: jest.fn().mockRejectedValue(new Error('corrupt marker')),
      readActiveRoute,
    });

    await expect(resolver.resolve(membership())).resolves.toBeNull();
    expect(readActiveRoute).not.toHaveBeenCalled();
  });
});
