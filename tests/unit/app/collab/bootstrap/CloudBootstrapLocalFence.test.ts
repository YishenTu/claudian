import type { CollabProjectId } from '@claudian/collab-protocol';

import {
  type CloudBootstrapAdmissionPort,
  CloudBootstrapLocalFence,
  type CloudBootstrapWorkSessionPort,
} from '@/app/collab/bootstrap/CloudBootstrapLocalFence';
import type { ProjectOperationSuspension } from '@/app/collab/ProjectOperationAdmission';

import { PROJECT_ID } from './fixtures';

function admissionSuspension(
  projectId: CollabProjectId,
): ProjectOperationSuspension {
  return Object.freeze({ projectId, token: Symbol(projectId) });
}

describe('CloudBootstrapLocalFence', () => {
  it('reopens the suspended Project after Cloud activation', async () => {
    const admission = admissionSuspension(PROJECT_ID);
    const work = Object.freeze({ projectId: PROJECT_ID, token: Symbol('work') });
    const admissionPort: CloudBootstrapAdmissionPort = {
      drainAdmittedOperations: jest.fn(async () => undefined),
      resumeProjectAdmission: jest.fn(() => true),
      suspendProjectAdmission: jest.fn(() => admission),
    };
    const workSessions: CloudBootstrapWorkSessionPort = {
      resumeProject: jest.fn(async () => undefined),
      suspendProject: jest.fn(async () => work),
    };
    const fence = new CloudBootstrapLocalFence({ admission: admissionPort, workSessions });

    await fence.closeAndDrain(PROJECT_ID);
    await fence.completeAfterActivation(PROJECT_ID);

    expect(workSessions.resumeProject).toHaveBeenCalledWith(work);
    expect(admissionPort.resumeProjectAdmission).toHaveBeenCalledWith(admission);
    expect(fence.isProjectQuiesced(PROJECT_ID)).toBe(false);
  });

  it('replaces the paired suspension when admission resume fails', async () => {
    const admissionOne = admissionSuspension(PROJECT_ID);
    const admissionTwo = admissionSuspension(PROJECT_ID);
    const workOne = Object.freeze({ projectId: PROJECT_ID, token: Symbol('work-one') });
    const workTwo = Object.freeze({ projectId: PROJECT_ID, token: Symbol('work-two') });
    const admission: CloudBootstrapAdmissionPort = {
      drainAdmittedOperations: jest.fn(async () => undefined),
      resumeProjectAdmission: jest.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true),
      suspendProjectAdmission: jest.fn()
        .mockReturnValueOnce(admissionOne)
        .mockReturnValueOnce(admissionTwo),
    };
    const workSessions: CloudBootstrapWorkSessionPort = {
      resumeProject: jest.fn(async () => undefined),
      suspendProject: jest.fn()
        .mockResolvedValueOnce(workOne)
        .mockResolvedValueOnce(workTwo),
    };
    const fence = new CloudBootstrapLocalFence({ admission, workSessions });

    await fence.closeAndDrain(PROJECT_ID);
    await expect(fence.resumeAfterCancellation(PROJECT_ID)).rejects.toMatchObject({
      code: 'durable-progress-recovery-required',
      safeContext: { reason: 'cloud-bootstrap-admission-resume-failed' },
    });

    expect(fence.isProjectQuiesced(PROJECT_ID)).toBe(true);
    expect(workSessions.resumeProject).toHaveBeenNthCalledWith(1, workOne);
    expect(workSessions.suspendProject).toHaveBeenCalledTimes(2);

    await fence.resumeAfterCancellation(PROJECT_ID);

    expect(workSessions.resumeProject).toHaveBeenNthCalledWith(2, workTwo);
    expect(admission.resumeProjectAdmission).toHaveBeenNthCalledWith(2, admissionTwo);
    expect(fence.isProjectQuiesced(PROJECT_ID)).toBe(false);
  });
});
