import type { CollabProjectWorkSessionSuspension } from '@/app/collab/activity/CollabProjectWorkSession';
import { AuthorityTransferLocalFence } from '@/app/collab/authority-transfer/AuthorityTransferLocalFence';
import type { ProjectOperationSuspension } from '@/app/collab/ProjectOperationAdmission';

const PROJECT_ID = 'project-transfer-fence';

function admission(token: string): ProjectOperationSuspension {
  return Object.freeze({ projectId: PROJECT_ID, token: Symbol(token) });
}

function workSession(token: string): CollabProjectWorkSessionSuspension {
  return Object.freeze({ projectId: PROJECT_ID, token: Symbol(token) });
}

describe('AuthorityTransferLocalFence', () => {
  it('closes and drains local work before mutation, then reopens the new binding', async () => {
    const order: string[] = [];
    const admissionSuspension = admission('admission');
    const workSuspension = workSession('work');
    const fence = new AuthorityTransferLocalFence({
      admission: {
        drainAdmittedOperations: jest.fn(async () => { order.push('drain'); }),
        resumeProjectAdmission: jest.fn(() => {
          order.push('resume-admission');
          return true;
        }),
        suspendProjectAdmission: jest.fn(() => {
          order.push('suspend-admission');
          return admissionSuspension;
        }),
      },
      workSessions: {
        resumeProject: jest.fn(async () => { order.push('resume-work'); }),
        suspendProject: jest.fn(async () => {
          order.push('suspend-work');
          return workSuspension;
        }),
      },
    });

    await fence.run(PROJECT_ID, async () => { order.push('mutate-binding'); });

    expect(order).toEqual([
      'suspend-admission',
      'suspend-work',
      'drain',
      'mutate-binding',
      'resume-work',
      'resume-admission',
    ]);
  });

  it('retains the closed state after partial mutation and resumes recovery in place', async () => {
    const admissionSuspension = admission('admission');
    const workSuspension = workSession('work');
    const suspendAdmission = jest.fn(() => admissionSuspension);
    const suspendWork = jest.fn(async () => workSuspension);
    const resumeAdmission = jest.fn(() => true);
    const resumeWork = jest.fn(async () => undefined);
    const fence = new AuthorityTransferLocalFence({
      admission: {
        drainAdmittedOperations: jest.fn(async () => undefined),
        resumeProjectAdmission: resumeAdmission,
        suspendProjectAdmission: suspendAdmission,
      },
      workSessions: { resumeProject: resumeWork, suspendProject: suspendWork },
    });

    await expect(fence.run(PROJECT_ID, async () => {
      throw new Error('simulated membership write crash');
    })).rejects.toThrow('simulated membership write crash');
    expect(resumeWork).not.toHaveBeenCalled();
    expect(resumeAdmission).not.toHaveBeenCalled();

    await fence.run(PROJECT_ID, async () => undefined);

    expect(suspendAdmission).toHaveBeenCalledTimes(1);
    expect(suspendWork).toHaveBeenCalledTimes(1);
    expect(resumeWork).toHaveBeenCalledWith(workSuspension);
    expect(resumeAdmission).toHaveBeenCalledWith(admissionSuspension);
  });
});
