import { ProjectOperationAdmission } from '@/app/collab/ProjectOperationAdmission';

describe('ProjectOperationAdmission', () => {
  it('rejects active Project operations after close while retaining local Retired work', async () => {
    const admission = new ProjectOperationAdmission();
    admission.closeProject('project-a');

    await expect(admission.runProject(
      () => 'project-a',
      'active',
      async () => 'blocked',
    )).rejects.toMatchObject({ code: 'project-retired' });
    await expect(admission.runProject(
      () => 'project-a',
      'retired-local',
      async () => 'allowed',
    )).resolves.toBe('allowed');
  });

  it('rejects new work before resolving operation arguments once closing starts', async () => {
    const admission = new ProjectOperationAdmission();
    const resolveProjectId = jest.fn(() => {
      throw new Error('must not resolve');
    });
    admission.beginClose();

    await expect(admission.runProject(
      resolveProjectId,
      'active',
      async () => undefined,
    )).rejects.toMatchObject({
      code: 'cancelled',
      safeContext: { reason: 'collab-feature-closing' },
    });
    expect(resolveProjectId).not.toHaveBeenCalled();
  });

  it('drains operations admitted before close', async () => {
    const admission = new ProjectOperationAdmission();
    let release!: () => void;
    const pending = admission.runGlobal(() => new Promise<void>(resolve => {
      release = resolve;
    }));
    await Promise.resolve();

    admission.beginClose();
    let drained = false;
    const draining = admission.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    release();
    await pending;
    await draining;
    expect(drained).toBe(true);
  });

  it('normalizes non-Error failures at the admission boundary', async () => {
    const admission = new ProjectOperationAdmission();

    await expect(admission.runProject(
      () => { throw 'project-resolution-failed'; },
      'active',
      async () => undefined,
    )).rejects.toMatchObject({
      cause: 'project-resolution-failed',
      message: 'project-resolution-failed',
    });
    await expect(admission.runGlobal(
      // eslint-disable-next-line prefer-promise-reject-errors -- Exercise boundary normalization of an invalid rejection.
      async () => Promise.reject('operation-failed'),
    )).rejects.toMatchObject({
      cause: 'operation-failed',
      message: 'operation-failed',
    });
  });
});
