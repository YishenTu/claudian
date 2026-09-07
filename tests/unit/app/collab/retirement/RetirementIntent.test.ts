import { createRetirementIntent } from '@/app/collab/retirement/RetirementIntent';

describe('RetirementIntent', () => {
  it('reconstructs the same mutation identity after a process restart', () => {
    const request = {
      expectedHostMemberId: 'member-host',
      managerActorMemberId: 'member-manager',
      projectId: 'project-alpha',
    };

    expect(createRetirementIntent(request)).toEqual(createRetirementIntent({ ...request }));
    expect(createRetirementIntent(request)).toEqual({
      idempotencyKey: expect.stringMatching(/^retire-[0-9a-f]{32}$/),
      requestFingerprint: '11e00be6671f4710e6a612593e28bec1123a3f1e954efbe21c5f952d4bac3fa2',
    });
  });

  it('changes identity when an authority precondition changes', () => {
    const baseline = createRetirementIntent({
      expectedHostMemberId: 'member-host',
      managerActorMemberId: 'member-manager',
      projectId: 'project-alpha',
    });

    expect(createRetirementIntent({
      expectedHostMemberId: 'member-host-next',
      managerActorMemberId: 'member-manager',
      projectId: 'project-alpha',
    })).not.toEqual(baseline);
  });

  it('changes identity when the authenticated Manager actor changes', () => {
    const baseline = createRetirementIntent({
      expectedHostMemberId: 'member-host',
      managerActorMemberId: 'member-manager',
      projectId: 'project-alpha',
    });

    expect(createRetirementIntent({
      expectedHostMemberId: 'member-host',
      managerActorMemberId: 'member-manager-next',
      projectId: 'project-alpha',
    })).not.toEqual(baseline);
  });
});
