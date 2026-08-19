import {
  CollabLanDiscoveryService,
} from '@/app/collab/discovery/CollabLanDiscoveryService';
import { COLLAB_CONTROL_PROTOCOL_VERSION } from '@/app/collab/lan/LanCollabConstants';

interface FakeService {
  readonly port: number;
  readonly txt?: unknown;
}

function createRuntime() {
  let browserCallback: ((service: FakeService) => void) | null = null;
  let errorCallback: (() => void) | null = null;
  const publicationStop = jest.fn((callback?: () => void) => callback?.());
  const browserStop = jest.fn();
  const browserUpdate = jest.fn();
  const runtime = {
    browse: jest.fn(callback => {
      browserCallback = callback;
      return { stop: browserStop, update: browserUpdate };
    }),
    close: jest.fn(async () => undefined),
    publish: jest.fn((_input: {
      readonly name: string;
      readonly port: number;
      readonly txt: Readonly<Record<string, string>>;
    }) => ({ stop: publicationStop })),
  };
  return {
    create: jest.fn(callback => {
      errorCallback = callback;
      return runtime;
    }),
    emitError: () => errorCallback?.(),
    emitService: (service: FakeService) => browserCallback?.(service),
    runtime,
    browserStop,
    browserUpdate,
    publicationStop,
  };
}

describe('CollabLanDiscoveryService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('advertises only the non-secret Project locator and releases it', async () => {
    const fake = createRuntime();
    const discovery = new CollabLanDiscoveryService({ createRuntime: fake.create });

    const advertisement = await discovery.advertiseProject({
      caFingerprint: 'ab'.repeat(32),
      endpoint: 'https://192.168.1.10:54545',
      projectId: 'project-a',
    });

    expect(fake.runtime.publish).toHaveBeenCalledWith({
      name: expect.stringMatching(/^Claudian Collab project-a [0-9a-f]{12}$/),
      port: 54545,
      txt: {
        caFingerprint: 'ab'.repeat(32),
        endpoint: 'https://192.168.1.10:54545',
        projectId: 'project-a',
        protocolVersion: String(COLLAB_CONTROL_PROTOCOL_VERSION),
      },
    });
    expect(JSON.stringify(fake.runtime.publish.mock.calls)).not.toContain('credential');
    expect(JSON.stringify(fake.runtime.publish.mock.calls)).not.toContain('invitation');

    await advertisement.stop();
    await advertisement.stop();

    expect(fake.publicationStop).toHaveBeenCalledTimes(1);
    expect(fake.runtime.close).toHaveBeenCalledTimes(1);
  });

  it('keeps maximum-length Project advertisement names within DNS-SD limits', async () => {
    const fake = createRuntime();
    const discovery = new CollabLanDiscoveryService({ createRuntime: fake.create });

    const advertisement = await discovery.advertiseProject({
      caFingerprint: 'ab'.repeat(32),
      endpoint: 'https://192.168.1.10:54545',
      projectId: 'a'.repeat(64),
    });

    const published = fake.runtime.publish.mock.calls[0]?.[0];
    expect(published.name).toHaveLength(63);
    await advertisement.stop();
  });

  it('returns only an exact Project and stored-CA match', async () => {
    jest.useFakeTimers();
    const fake = createRuntime();
    const discovery = new CollabLanDiscoveryService({
      createRuntime: fake.create,
      discoveryTimeoutMs: 500,
    });
    const pending = discovery.discoverProjectCandidates('project-a', 'ab'.repeat(32));

    fake.emitService({
      port: 54545,
      txt: {
        caFingerprint: 'cd'.repeat(32),
        endpoint: 'https://192.168.1.20:54545',
        projectId: 'project-a',
        protocolVersion: String(COLLAB_CONTROL_PROTOCOL_VERSION),
      },
    });
    fake.emitService({
      port: 54546,
      txt: {
        caFingerprint: 'ab'.repeat(32),
        endpoint: 'https://192.168.1.20:54545',
        projectId: 'project-a',
        protocolVersion: String(COLLAB_CONTROL_PROTOCOL_VERSION),
      },
    });
    fake.emitService({
      port: 54545,
      txt: {
        caFingerprint: 'ab'.repeat(32),
        endpoint: 'https://192.168.1.20:54545',
        projectId: 'project-a',
        protocolVersion: String(COLLAB_CONTROL_PROTOCOL_VERSION),
      },
    });
    jest.advanceTimersByTime(400);

    await expect(pending).resolves.toEqual([{
      caFingerprint: 'ab'.repeat(32),
      endpoint: 'https://192.168.1.20:54545',
      projectId: 'project-a',
    }]);
    expect(fake.browserStop).toHaveBeenCalledTimes(1);
    expect(fake.runtime.close).toHaveBeenCalledTimes(1);
  });

  it('can discover a same-Project candidate under a transitioned Host CA', async () => {
    jest.useFakeTimers();
    const fake = createRuntime();
    const discovery = new CollabLanDiscoveryService({
      createRuntime: fake.create,
      discoveryTimeoutMs: 500,
    });
    const pending = discovery.discoverProjectCandidatesForTrustTransition('project-a');

    fake.emitService({
      port: 54545,
      txt: {
        caFingerprint: 'cd'.repeat(32),
        endpoint: 'https://192.168.1.20:54545',
        projectId: 'project-a',
        protocolVersion: String(COLLAB_CONTROL_PROTOCOL_VERSION),
      },
    });
    jest.advanceTimersByTime(400);

    await expect(pending).resolves.toEqual([{
      caFingerprint: 'cd'.repeat(32),
      endpoint: 'https://192.168.1.20:54545',
      projectId: 'project-a',
    }]);
  });

  it('fails closed on runtime errors so manual reconnect remains available', async () => {
    const fake = createRuntime();
    const discovery = new CollabLanDiscoveryService({
      createRuntime: fake.create,
      discoveryTimeoutMs: 500,
    });
    const pending = discovery.discoverProjectCandidates('project-a', 'ab'.repeat(32));

    fake.emitError();

    await expect(pending).resolves.toEqual([]);
    expect(fake.browserStop).toHaveBeenCalledTimes(1);
    expect(fake.runtime.close).toHaveBeenCalledTimes(1);
  });

  it('stops a timed-out browser and destroys an idle runtime', async () => {
    jest.useFakeTimers();
    const fake = createRuntime();
    const discovery = new CollabLanDiscoveryService({
      createRuntime: fake.create,
      discoveryTimeoutMs: 20,
    });
    const pending = discovery.discoverProjectCandidates('project-a', 'ab'.repeat(32));

    jest.advanceTimersByTime(20);

    await expect(pending).resolves.toEqual([]);
    expect(fake.browserStop).toHaveBeenCalledTimes(1);
    expect(fake.runtime.close).toHaveBeenCalledTimes(1);
  });

  it('retries multicast queries during the default discovery window', async () => {
    jest.useFakeTimers();
    const fake = createRuntime();
    const discovery = new CollabLanDiscoveryService({ createRuntime: fake.create });
    const pending = discovery.discoverProjectCandidates('project-a', 'ab'.repeat(32));

    jest.advanceTimersByTime(749);
    expect(fake.browserUpdate).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(fake.browserUpdate).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1_000);
    expect(fake.browserUpdate).toHaveBeenCalledTimes(2);

    fake.emitService({
      port: 54545,
      txt: {
        caFingerprint: 'ab'.repeat(32),
        endpoint: 'https://192.168.1.20:54545',
        projectId: 'project-a',
        protocolVersion: String(COLLAB_CONTROL_PROTOCOL_VERSION),
      },
    });
    jest.advanceTimersByTime(400);
    await expect(pending).resolves.toEqual([
      expect.objectContaining({ projectId: 'project-a' }),
    ]);
    jest.advanceTimersByTime(2_000);
    expect(fake.browserUpdate).toHaveBeenCalledTimes(2);
  });

  it('collects distinct Host endpoints and ignores duplicate announcements', async () => {
    jest.useFakeTimers();
    const fake = createRuntime();
    const discovery = new CollabLanDiscoveryService({ createRuntime: fake.create });
    const pending = discovery.discoverProjectCandidates(
      'project-a',
      'ab'.repeat(32),
    );
    const service = (endpoint: string, port: number): FakeService => ({
      port,
      txt: {
        caFingerprint: 'ab'.repeat(32),
        endpoint,
        projectId: 'project-a',
        protocolVersion: String(COLLAB_CONTROL_PROTOCOL_VERSION),
      },
    });

    fake.emitService(service('https://192.168.1.20:54545', 54545));
    fake.emitService(service('https://192.168.1.20:54545', 54545));
    fake.emitService(service('https://192.168.1.30:54546', 54546));
    jest.advanceTimersByTime(400);

    await expect(pending).resolves.toEqual([
      expect.objectContaining({ endpoint: 'https://192.168.1.20:54545' }),
      expect.objectContaining({ endpoint: 'https://192.168.1.30:54546' }),
    ]);
  });
});
