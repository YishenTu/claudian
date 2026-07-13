// Refcount + idle-linger lifecycle for the shared voice bridge. The real
// VoiceBridge is mocked so these tests exercise only the acquire/release/linger
// accounting — no subprocess is spawned.

import { BRIDGE_LINGER_MS, ResidentBridge } from '../../../src/features/voice/ResidentBridge';
import type { VoiceRuntimeConfig } from '../../../src/features/voice/VoiceController';

// Track the fake bridge instances the manager creates.
const started: FakeBridge[] = [];

class FakeBridge {
  closed = false;
  start = jest.fn(async () => {});
  close = jest.fn(async () => {
    this.closed = true;
  });
}

jest.mock('../../../src/features/voice/VoiceBridge', () => ({
  VoiceBridge: jest.fn().mockImplementation(() => {
    const b = new FakeBridge();
    started.push(b);
    return b;
  }),
}));

const CONFIG: VoiceRuntimeConfig = {
  pythonPath: 'python3',
  bridgeScriptPath: '/tmp/voice_bridge.py',
  cwd: '/tmp',
};

function makeManager(config: VoiceRuntimeConfig | null = CONFIG): ResidentBridge {
  return new ResidentBridge(() => config);
}

describe('ResidentBridge', () => {
  beforeEach(() => {
    started.length = 0;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('cold-starts one bridge on first acquire', async () => {
    const mgr = makeManager();
    const lease = await mgr.acquire();

    expect(started).toHaveLength(1);
    expect(started[0].start).toHaveBeenCalledTimes(1);
    expect(mgr.isResident()).toBe(true);
    expect(mgr.getRefcount()).toBe(1);
    expect(lease.bridge).toBe(started[0]);
  });

  it('reuses the warm bridge across concurrent acquires (one process)', async () => {
    const mgr = makeManager();
    const [a, b] = await Promise.all([mgr.acquire(), mgr.acquire()]);

    expect(started).toHaveLength(1);
    expect(a.bridge).toBe(b.bridge);
    expect(mgr.getRefcount()).toBe(2);
  });

  it('does not close while a lease is still held', async () => {
    const mgr = makeManager();
    const a = await mgr.acquire();
    const b = await mgr.acquire();

    a.release();
    jest.advanceTimersByTime(BRIDGE_LINGER_MS + 1000);

    // b is still holding, so the linger timer should never have started.
    expect(started[0].closed).toBe(false);
    expect(mgr.isResident()).toBe(true);
    void b;
  });

  it('closes the bridge after the linger window once the last lease releases', async () => {
    const mgr = makeManager();
    const lease = await mgr.acquire();

    lease.release();
    expect(started[0].closed).toBe(false); // still lingering

    jest.advanceTimersByTime(BRIDGE_LINGER_MS + 1);

    expect(started[0].close).toHaveBeenCalledTimes(1);
    expect(mgr.isResident()).toBe(false);
    expect(mgr.getRefcount()).toBe(0);
  });

  it('re-acquire during linger cancels the close and reuses the warm bridge', async () => {
    const mgr = makeManager();
    const first = await mgr.acquire();
    first.release();

    // Partway through the linger window, re-acquire.
    jest.advanceTimersByTime(BRIDGE_LINGER_MS / 2);
    const second = await mgr.acquire();

    // Finish out the original window; the bridge must NOT close.
    jest.advanceTimersByTime(BRIDGE_LINGER_MS);

    expect(started).toHaveLength(1); // no second cold start
    expect(started[0].closed).toBe(false);
    expect(second.bridge).toBe(first.bridge);
  });

  it('rejects and does not leak a refcount when config is missing', async () => {
    const mgr = makeManager(null);
    await expect(mgr.acquire()).rejects.toThrow();
    expect(mgr.getRefcount()).toBe(0);
    expect(mgr.isResident()).toBe(false);
  });

  it('shutdown closes the bridge immediately regardless of refcount', async () => {
    const mgr = makeManager();
    await mgr.acquire();

    await mgr.shutdown();

    expect(started[0].close).toHaveBeenCalledTimes(1);
    expect(mgr.isResident()).toBe(false);
    expect(mgr.getRefcount()).toBe(0);
  });
});
