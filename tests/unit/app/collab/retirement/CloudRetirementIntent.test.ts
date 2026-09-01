import {
  type CloudRetirementIntent,
  decodeCloudRetirementIntent,
} from '@/app/collab/retirement/CloudRetirementIntent';

const prepared = (): CloudRetirementIntent => ({
  authorityGeneration: 3,
  createdAt: '2026-08-27T00:00:00.000Z',
  kind: 'cloud-retirement-intent',
  memberId: 'member-manager',
  personalRef: 'refs/heads/members/member-manager',
  phase: 'prepared',
  projectId: 'project-cloud-retire',
  request: {
    expectedAuthorityGeneration: 3,
    expectedMainOid: 'a'.repeat(40),
    idempotencyKey: 'retire-request-one',
    projectId: 'project-cloud-retire',
  },
  result: null,
  schemaVersion: 1,
  serverUrl: 'https://cloud.example.test/operator-prefix',
  updatedAt: '2026-08-27T00:00:00.000Z',
});

describe('CloudRetirementIntent', () => {
  it('round-trips the exact prepared request and retained terminal result', () => {
    expect(decodeCloudRetirementIntent(prepared())).toEqual(prepared());
    const terminal = {
      ...prepared(),
      phase: 'terminal-retained' as const,
      result: {
        acknowledgementRequired: true,
        kind: 'project-retired' as const,
        projectId: 'project-cloud-retire' as const,
        retiredAt: '2026-08-27T00:00:10.000Z',
        retirementId: 'retirement-cloud',
        terminalExpiresAt: '2026-09-26T00:00:10.000Z',
      },
      updatedAt: '2026-08-27T00:00:10.000Z',
    };
    expect(decodeCloudRetirementIntent(terminal)).toEqual(terminal);
  });

  it.each([
    { ...prepared(), cloudDevelopmentActorId: 'principal-device' },
    { ...prepared(), authorityGeneration: 4 },
    { ...prepared(), memberId: 'not a member' },
    { ...prepared(), phase: 'submitted', result: { status: 'rejected' } },
    { ...prepared(), phase: 'terminal-retained', result: null },
    { ...prepared(), request: { ...prepared().request, projectId: 'project-other' } },
  ])('rejects corrupt or obsolete Cloud retirement state', value => {
    expect(() => decodeCloudRetirementIntent(value)).toThrow();
  });

  it('retains a durable definitive rejection without fabricating a new request', () => {
    const rejected = {
      ...prepared(),
      phase: 'rejected' as const,
      updatedAt: '2026-08-27T00:00:01.000Z',
    };

    expect(decodeCloudRetirementIntent(rejected)).toEqual(rejected);
  });
});
