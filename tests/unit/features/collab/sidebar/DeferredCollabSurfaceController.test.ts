/** @jest-environment jsdom */

import { DeferredCollabSurfaceController } from '@/features/collab/sidebar/DeferredCollabSurfaceController';

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('DeferredCollabSurfaceController', () => {
  it('loads and preloads the concrete surface without activating it', async () => {
    const host = document.body.createDiv();
    const concrete = { destroy: jest.fn(), preload: jest.fn(), setActive: jest.fn() };
    const create = jest.fn().mockResolvedValue(concrete);
    const controller = new DeferredCollabSurfaceController(host, {
      create,
      errorText: 'Failed',
      loadingText: 'Loading',
    });

    controller.preload();
    expect(create).toHaveBeenCalledTimes(1);
    await flush();

    expect(concrete.preload).toHaveBeenCalledTimes(1);
    expect(concrete.setActive).toHaveBeenCalledWith(false);
  });

  it('loads on first activation and forwards later visibility changes', async () => {
    const host = document.body.createDiv();
    const concrete = { destroy: jest.fn(), setActive: jest.fn() };
    const create = jest.fn().mockResolvedValue(concrete);
    const controller = new DeferredCollabSurfaceController(host, {
      create,
      errorText: 'Failed',
      loadingText: 'Loading',
    });

    controller.setActive(false);
    expect(create).not.toHaveBeenCalled();
    controller.setActive(true);
    expect(host.textContent).toContain('Loading');
    await flush();
    controller.setActive(false);

    expect(create).toHaveBeenCalledTimes(1);
    expect(concrete.setActive).toHaveBeenNthCalledWith(1, true);
    expect(concrete.setActive).toHaveBeenNthCalledWith(2, false);
  });

  it('destroys a late concrete controller after its host view is gone', async () => {
    const host = document.body.createDiv();
    const concrete = { destroy: jest.fn(), setActive: jest.fn() };
    let finish!: (value: typeof concrete) => void;
    const controller = new DeferredCollabSurfaceController(host, {
      create: () => new Promise(resolve => { finish = resolve; }),
      errorText: 'Failed',
      loadingText: 'Loading',
    });
    controller.setActive(true);

    controller.destroy();
    finish(concrete);
    await flush();

    expect(concrete.destroy).toHaveBeenCalledTimes(1);
    expect(concrete.setActive).not.toHaveBeenCalled();
    expect(host.textContent).toBe('');
  });

  it('renders a stable local error when dynamic loading fails', async () => {
    const host = document.body.createDiv();
    const controller = new DeferredCollabSurfaceController(host, {
      create: async () => { throw new Error('bundle failure'); },
      errorText: 'Collab failed to load.',
      loadingText: 'Loading',
    });

    controller.setActive(true);
    await flush();

    expect(host.textContent).toContain('Collab failed to load.');
    expect(host.querySelector('.claudian-collab-panel-status--warning')).not.toBeNull();
  });
});
