import { StreamingRenderCoordinator } from '@/features/chat/turns/StreamingRenderCoordinator';

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
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces requests and never overlaps asynchronous renders', async () => {
    const firstRender = createDeferred();
    const secondRender = createDeferred();
    let activeRenders = 0;
    let maxActiveRenders = 0;
    const render = vi.fn(async (_content: string) => {
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
    vi.advanceTimersByTime(16);
    await flushMicrotasks();

    coordinator.request('second');
    coordinator.request('latest');
    vi.advanceTimersByTime(100);
    await flushMicrotasks();

    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenNthCalledWith(1, 'first');

    firstRender.resolve();
    await flushMicrotasks();
    vi.advanceTimersByTime(16);
    await flushMicrotasks();

    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenNthCalledWith(2, 'latest');
    expect(maxActiveRenders).toBe(1);

    secondRender.resolve();
    await flushMicrotasks();
  });

  it('throttles successive renders using the latest requested snapshot', async () => {
    const render = vi.fn().mockResolvedValue(undefined);
    const coordinator = new StreamingRenderCoordinator<string>({
      render,
      getOwnerWindow: () => window,
      minIntervalMs: 150,
    });

    coordinator.request('first');
    vi.advanceTimersByTime(16);
    await flushMicrotasks();

    coordinator.request('second');
    coordinator.request('latest');
    vi.advanceTimersByTime(149);
    await flushMicrotasks();

    expect(render).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(17);
    await flushMicrotasks();

    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenLastCalledWith('latest');
  });

  it('retains dirty content while unavailable and catches up when revealed', async () => {
    const render = vi.fn().mockResolvedValue(undefined);
    const coordinator = new StreamingRenderCoordinator<string>({
      render,
      getOwnerWindow: () => window,
      minIntervalMs: 150,
    });

    coordinator.setAvailable(false);
    coordinator.request('hidden');
    coordinator.request('latest hidden');
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();

    expect(render).not.toHaveBeenCalled();

    coordinator.setAvailable(true);
    vi.advanceTimersByTime(16);
    await flushMicrotasks();

    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith('latest hidden');
  });

  it('flushes the latest snapshot immediately even while unavailable', async () => {
    const render = vi.fn().mockResolvedValue(undefined);
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
    const render = vi.fn((content: string) => (
      content === 'streaming' ? firstRender.promise : Promise.resolve()
    ));
    const coordinator = new StreamingRenderCoordinator<string>({
      render,
      getOwnerWindow: () => window,
      minIntervalMs: 150,
    });

    coordinator.request('streaming');
    vi.advanceTimersByTime(16);
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
    const render = vi.fn().mockResolvedValue(undefined);
    const coordinator = new StreamingRenderCoordinator<string>({
      render,
      getOwnerWindow: () => window,
      minIntervalMs: 150,
    });

    coordinator.request('stale');
    coordinator.cancel();
    vi.advanceTimersByTime(1000);
    await flushMicrotasks();

    expect(render).not.toHaveBeenCalled();
  });

  it('does not stall flush when the renderer rejects', async () => {
    const render = vi.fn().mockRejectedValue(new Error('render failed'));
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

it('backs off after expensive renders while keeping final flush immediate', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const render = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }))
    .mockResolvedValue(undefined);
  const options = { render, getOwnerWindow: () => window, minIntervalMs: 150, maxIntervalMs: 500 };
  const coordinator = new StreamingRenderCoordinator<string>(options);
  try {
    coordinator.request('large');
    await vi.advanceTimersByTimeAsync(16);
    await vi.advanceTimersByTimeAsync(200);
    finish();
    await flushMicrotasks();
    coordinator.request('growing');
    await vi.advanceTimersByTimeAsync(170);
    expect(render).toHaveBeenCalledTimes(1);
    coordinator.request('final');
    await coordinator.flush();
    expect(render).toHaveBeenLastCalledWith('final');
    expect(render).toHaveBeenCalledTimes(2);
  } finally { coordinator.dispose(); vi.useRealTimers(); }
});
