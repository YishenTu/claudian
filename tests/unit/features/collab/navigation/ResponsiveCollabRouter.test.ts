import {
  ResponsiveCollabRouter,
  type ResponsiveCollabTarget,
} from '@/features/collab/navigation/ResponsiveCollabRouter';

function target(selectable: boolean): ResponsiveCollabTarget & {
  prepare: jest.Mock;
  reveal: jest.Mock;
  select: jest.Mock;
} {
  return {
    prepare: jest.fn().mockResolvedValue(undefined),
    reveal: jest.fn().mockResolvedValue(undefined),
    select: jest.fn().mockReturnValue(selectable),
  };
}

describe('ResponsiveCollabRouter', () => {
  it('selects and reveals the first compatible existing Claudian target', async () => {
    const narrow = target(false);
    const compatible = target(true);
    const unused = target(true);
    const createMainTabTarget = jest.fn();
    const router = new ResponsiveCollabRouter({
      createMainTabTarget,
      listExistingTargets: () => [narrow, compatible, unused],
    });

    await expect(router.open()).resolves.toBe(true);

    expect(narrow.select).toHaveBeenCalledTimes(1);
    expect(narrow.reveal).not.toHaveBeenCalled();
    expect(compatible.select).toHaveBeenCalledTimes(1);
    expect(compatible.reveal).toHaveBeenCalledTimes(1);
    expect(unused.select).not.toHaveBeenCalled();
    expect(createMainTabTarget).not.toHaveBeenCalled();
  });

  it('prepares a main-tab fallback when every existing target is narrow', async () => {
    const narrow = target(false);
    const fallback = target(true);
    const router = new ResponsiveCollabRouter({
      createMainTabTarget: jest.fn().mockResolvedValue(fallback),
      listExistingTargets: () => [narrow],
    });

    await expect(router.open()).resolves.toBe(true);

    expect(fallback.prepare).toHaveBeenCalledTimes(1);
    expect(fallback.select).toHaveBeenCalledTimes(1);
    expect(fallback.reveal).toHaveBeenCalledTimes(1);
    expect(fallback.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      fallback.select.mock.invocationCallOrder[0]!,
    );
    expect(fallback.select.mock.invocationCallOrder[0]).toBeLessThan(
      fallback.reveal.mock.invocationCallOrder[0]!,
    );
  });

  it('returns false without leaking target failures', async () => {
    const broken = target(false);
    broken.select.mockImplementation(() => {
      throw new Error('detached view');
    });
    const fallback = target(false);
    const router = new ResponsiveCollabRouter({
      createMainTabTarget: jest.fn().mockResolvedValue(fallback),
      listExistingTargets: () => [broken],
    });

    await expect(router.open()).resolves.toBe(false);
    expect(fallback.prepare).toHaveBeenCalledTimes(1);
    expect(fallback.reveal).not.toHaveBeenCalled();
  });
});
