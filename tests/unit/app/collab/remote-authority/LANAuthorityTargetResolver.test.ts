import { testTime } from '@test/helpers/testClock';

import type { CollabLocalLANMembershipRecord } from '@/app/collab/CollabLocalProjectRepository';
import { COLLAB_LOCAL_PROJECT_SCHEMA_VERSION } from '@/app/collab/CollabSchemaVersions';
import { LANAuthorityTargetResolver } from '@/app/collab/remote-authority/LANAuthorityTargetResolver';

const PROJECT_ID = 'project-local-target';
const CERTIFICATE = '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----';
const FINGERPRINT = 'a'.repeat(64);

function membership(): CollabLocalLANMembershipRecord {
  return {
    authority: {
      authorityGeneration: 1,
      endpoint: 'https://192.168.1.20:41730',
      gitRemoteUrl: `https://192.168.1.20:41730/v1/git/${PROJECT_ID}/repository.git`,
      hostCaCertificatePem: CERTIFICATE,
      hostCaFingerprint: FINGERPRINT,
      kind: 'lan',
    },
    createdAt: testTime({ days: 1 }),
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
    updatedAt: testTime({ days: 1 }),
  };
}

describe('LANAuthorityTargetResolver', () => {
  const activeRoute = {
    caCertificatePem: CERTIFICATE,
    caFingerprint: FINGERPRINT,
    endpoint: 'https://192.168.1.44:41731',
    projectId: PROJECT_ID,
  };

  it('selects only a hosted-here active route with the pinned Project CA identity', async () => {
    const resolver = new LANAuthorityTargetResolver({
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
    const resolver = new LANAuthorityTargetResolver({
      inspectInstallation: jest.fn().mockResolvedValue(status),
      readActiveRoute: jest.fn().mockReturnValue(route),
    });

    await expect(resolver.resolve(membership())).resolves.toBeNull();
  });

  it('treats invalid local marker state as ineligible for the optional local shortcut', async () => {
    const readActiveRoute = jest.fn().mockReturnValue(activeRoute);
    const resolver = new LANAuthorityTargetResolver({
      inspectInstallation: jest.fn().mockRejectedValue(new Error('corrupt marker')),
      readActiveRoute,
    });

    await expect(resolver.resolve(membership())).resolves.toBeNull();
    expect(readActiveRoute).not.toHaveBeenCalled();
  });
});
