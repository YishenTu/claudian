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

  it('resumes active Project admission only through the owning suspension token', async () => {
    const admission = new ProjectOperationAdmission();
    const suspension = admission.suspendProject('project-a');

    await expect(admission.runProject(
      () => 'project-a',
      'active',
      async () => 'blocked',
    )).rejects.toMatchObject({
      code: 'cancelled',
      safeContext: { reason: 'collab-feature-project-suspended' },
    });
    expect(admission.resumeProject({
      projectId: 'project-a',
      token: Symbol('project-a'),
    })).toBe(false);
    expect(admission.resumeProject(suspension)).toBe(true);
    await expect(admission.runProject(
      () => 'project-a',
      'active',
      async () => 'resumed',
    )).resolves.toBe('resumed');
    expect(admission.resumeProject(suspension)).toBe(false);
  });

  it('does not let a suspension token reopen a permanently closed Project', () => {
    const admission = new ProjectOperationAdmission();
    const suspension = admission.suspendProject('project-a');

    admission.closeProject('project-a');

    expect(admission.resumeProject(suspension)).toBe(false);
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

  it('lets a projection transition suspend and drain without waiting for itself', async () => {
    const admission = new ProjectOperationAdmission();
    let transitionFinished = false;

    await admission.runProjectTransition(
      () => 'project-a',
      async () => {
        const suspension = admission.suspendProject('project-a');
        await admission.drainAdmittedOperations('project-a');
        expect(admission.resumeProject(suspension)).toBe(true);
        transitionFinished = true;
      },
    );

    expect(transitionFinished).toBe(true);
  });

  it('keeps admitted projection transitions visible to feature shutdown', async () => {
    const admission = new ProjectOperationAdmission();
    let release!: () => void;
    const transition = admission.runProjectTransition(
      () => 'project-a',
      () => new Promise<void>(resolve => { release = resolve; }),
    );
    await Promise.resolve();

    admission.beginClose();
    let drained = false;
    const draining = admission.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    release();
    await transition;
    await draining;
    expect(drained).toBe(true);
  });

  it('drains ordinary work only for the transitioning Project', async () => {
    const admission = new ProjectOperationAdmission();
    let releaseA!: () => void;
    let releaseB!: () => void;
    const operationA = admission.runProject(
      () => 'project-a',
      'active',
      () => new Promise<void>(resolve => { releaseA = resolve; }),
    );
    const operationB = admission.runProject(
      () => 'project-b',
      'active',
      () => new Promise<void>(resolve => { releaseB = resolve; }),
    );
    await Promise.resolve();

    let drained = false;
    const draining = admission.drainAdmittedOperations('project-a').then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    releaseA();
    await operationA;
    await draining;
    expect(drained).toBe(true);

    releaseB();
    await operationB;
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
