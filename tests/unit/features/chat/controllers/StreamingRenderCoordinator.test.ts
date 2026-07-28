import { StreamingRenderCoordinator } from '@/features/chat/controllers/StreamingRenderCoordinator';

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('StreamingRenderCoordinator', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('coalesces requests and never overlaps asynchronous renders', async () => {
    const firstRender = createDeferred();
    const secondRender = createDeferred();
    let activeRenders = 0;
    let maxActiveRenders = 0;
    const render = jest.fn(async (content: string) => {
      activeRenders += 1;
      maxActiveRenders = Math.max(maxActiveRenders, activeRenders);
      await (render.mock.calls.length === 1 ? firstRender.promise : secondRender.promise);
      activeRenders -= 1;
    });
    const coordinator = new StreamingRenderCoordinator<string>({
      render,
      getOwnerWindow: () => window,
      minIntervalMs: 0,
    });

    coordinator.request('first');
    jest.advanceTimersByTime(16);
    await flushMicrotasks();

    coordinator.request('second');
    coordinator.request('latest');
    jest.advanceTimersByTime(100);
    await flushMicrotasks();

    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenNthCalledWith(1, 'first');

    firstRender.resolve();
    await flushMicrotasks();
    jest.advanceTimersByTime(16);
    await flushMicrotasks();

    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenNthCalledWith(2, 'latest');
    expect(maxActiveRenders).toBe(1);

    secondRender.resolve();
    await flushMicrotasks();
  });

  it('throttles successive renders using the latest requested snapshot', async () => {
    const render = jest.fn().mockResolvedValue(undefined);
    const coordinator = new StreamingRenderCoordinator<string>({
      render,
      getOwnerWindow: () => window,
      minIntervalMs: 150,
    });

    coordinator.request('first');
    jest.advanceTimersByTime(16);
    await flushMicrotasks();

    coordinator.request('second');
    coordinator.request('latest');
    jest.advanceTimersByTime(149);
    await flushMicrotasks();

    expect(render).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(17);
    await flushMicrotasks();

    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenLastCalledWith('latest');
  });

  it('retains dirty content while unavailable and catches up when revealed', async () => {
    const render = jest.fn().mockResolvedValue(undefined);
    const coordinator = new StreamingRenderCoordinator<string>({
      render,
      getOwnerWindow: () => window,
      minIntervalMs: 150,
    });

    coordinator.setAvailable(false);
    coordinator.request('hidden');
    coordinator.request('latest hidden');
    jest.advanceTimersByTime(1000);
    await flushMicrotasks();

    expect(render).not.toHaveBeenCalled();

    coordinator.setAvailable(true);
    jest.advanceTimersByTime(16);
    await flushMicrotasks();

    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith('latest hidden');
  });

  it('flushes the latest snapshot immediately even while unavailable', async () => {
    const render = jest.fn().mockResolvedValue(undefined);
    const coordinator = new StreamingRenderCoordinator<string>({
      render,
      getOwnerWindow: () => window,
      minIntervalMs: 150,
    });

    coordinator.setAvailable(false);
    coordinator.request('final content');

    await coordinator.flush();

    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith('final content');
  });

  it('runs a forced trailing render without waiting for a hidden animation frame', async () => {
    const firstRender = createDeferred();
    const render = jest.fn((content: string) => (
      content === 'streaming' ? firstRender.promise : Promise.resolve()
    ));
    const coordinator = new StreamingRenderCoordinator<string>({
      render,
      getOwnerWindow: () => window,
      minIntervalMs: 150,
    });

    coordinator.request('streaming');
    jest.advanceTimersByTime(16);
    await flushMicrotasks();

    coordinator.setAvailable(false);
    coordinator.request('final');
    const flush = coordinator.flush();
    firstRender.resolve();

    await flush;

    expect(render).toHaveBeenNthCalledWith(1, 'streaming');
    expect(render).toHaveBeenNthCalledWith(2, 'final');
  });

  it('cancels scheduled work without rendering stale content', async () => {
    const render = jest.fn().mockResolvedValue(undefined);
    const coordinator = new StreamingRenderCoordinator<string>({
      render,
      getOwnerWindow: () => window,
      minIntervalMs: 150,
    });

    coordinator.request('stale');
    coordinator.cancel();
    jest.advanceTimersByTime(1000);
    await flushMicrotasks();

    expect(render).not.toHaveBeenCalled();
  });

  it('does not stall flush when the renderer rejects', async () => {
    const render = jest.fn().mockRejectedValue(new Error('render failed'));
    const coordinator = new StreamingRenderCoordinator<string>({
      render,
      getOwnerWindow: () => window,
      minIntervalMs: 150,
    });

    coordinator.request('content');

    await expect(coordinator.flush()).resolves.toBeUndefined();
    expect(render).toHaveBeenCalledWith('content');
  });
});
