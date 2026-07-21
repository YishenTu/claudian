import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as https from 'https';
import { Notice } from 'obsidian';

import { getUsageGuardBlock, setUsageGuardBlock } from '@/core/usageGuard/UsageGuardState';
import { ClaudeUsageGuardService } from '@/providers/claude/usageGuard/ClaudeUsageGuardService';

jest.mock('fs');
jest.mock('https');
jest.mock('obsidian', () => ({
  Notice: jest.fn(),
}));

const mockedReadFileSync = fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>;
const mockedRequest = https.request as jest.MockedFunction<typeof https.request>;
const mockNotice = Notice as unknown as jest.Mock;

class FakeResponse extends EventEmitter {
  statusCode = 200;
}

class FakeRequest extends EventEmitter {
  end = jest.fn();
  setTimeout = jest.fn();
  destroy = jest.fn();
}

function mockUsageResponse(body: unknown, statusCode = 200): FakeRequest {
  const req = new FakeRequest();
  const res = new FakeResponse();
  res.statusCode = statusCode;

  mockedRequest.mockImplementationOnce(((_url: unknown, _options: unknown, callback: (res: FakeResponse) => void) => {
    callback(res);
    queueMicrotask(() => {
      res.emit('data', Buffer.from(JSON.stringify(body)));
      res.emit('end');
    });
    return req as unknown as ReturnType<typeof https.request>;
  }) as typeof https.request);

  return req;
}

function createPlugin(overrides: Record<string, unknown> = {}) {
  return {
    settings: {
      providerConfigs: {
        claude: {
          usageGuardEnabled: true,
          usageGuardThresholdPercent: 90,
          ...overrides,
        },
      },
    },
  } as any;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('ClaudeUsageGuardService', () => {
  let service: ClaudeUsageGuardService | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ claudeAiOauth: { accessToken: 'test-token' } }),
    );
    setUsageGuardBlock(null);
  });

  afterEach(() => {
    service?.dispose();
    service = null;
    setUsageGuardBlock(null);
  });

  it('blocks sending once utilization reaches the threshold', async () => {
    mockUsageResponse({ five_hour: { utilization: 92, resets_at: '2026-07-19T20:00:00Z' } });

    service = new ClaudeUsageGuardService(createPlugin());
    await flush();

    expect(getUsageGuardBlock()).not.toBeNull();
    expect(mockNotice).toHaveBeenCalledWith(expect.stringContaining('92%'));
  });

  it('stays unblocked when utilization is under the threshold', async () => {
    mockUsageResponse({ five_hour: { utilization: 40 } });

    service = new ClaudeUsageGuardService(createPlugin());
    await flush();

    expect(getUsageGuardBlock()).toBeNull();
  });

  it('does not poll the API when disabled', async () => {
    service = new ClaudeUsageGuardService(createPlugin({ usageGuardEnabled: false }));
    await flush();

    expect(mockedRequest).not.toHaveBeenCalled();
    expect(getUsageGuardBlock()).toBeNull();
  });

  it('fails open when no local credentials are found', async () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    service = new ClaudeUsageGuardService(createPlugin());
    await flush();

    expect(mockedRequest).not.toHaveBeenCalled();
    expect(getUsageGuardBlock()).toBeNull();
  });

  it('clears the block once usage drops back under the threshold', async () => {
    mockUsageResponse({ five_hour: { utilization: 95 } });
    const plugin = createPlugin();
    service = new ClaudeUsageGuardService(plugin);
    await flush();
    expect(getUsageGuardBlock()).not.toBeNull();

    mockUsageResponse({ five_hour: { utilization: 10 } });
    await (service as any).tick();
    await flush();

    expect(getUsageGuardBlock()).toBeNull();
    expect(mockNotice).toHaveBeenCalledWith(expect.stringContaining('resumed'));
  });

  it('clears the block on dispose', async () => {
    mockUsageResponse({ five_hour: { utilization: 95 } });
    service = new ClaudeUsageGuardService(createPlugin());
    await flush();
    expect(getUsageGuardBlock()).not.toBeNull();

    service.dispose();
    expect(getUsageGuardBlock()).toBeNull();
  });

  it('fails open instead of staying blocked forever when a later poll errors', async () => {
    mockUsageResponse({ five_hour: { utilization: 95 } });
    service = new ClaudeUsageGuardService(createPlugin());
    await flush();
    expect(getUsageGuardBlock()).not.toBeNull();

    mockedRequest.mockImplementationOnce((() => {
      const req = new FakeRequest();
      queueMicrotask(() => req.emit('error', new Error('token expired')));
      return req as unknown as ReturnType<typeof https.request>;
    }) as typeof https.request);
    await (service as any).tick();
    await flush();

    expect(getUsageGuardBlock()).toBeNull();
  });

  it('resolves awaitInitialCheck once the first poll completes', async () => {
    mockUsageResponse({ five_hour: { utilization: 30 } });
    service = new ClaudeUsageGuardService(createPlugin());

    await expect(service.awaitInitialCheck(1_000)).resolves.toBeUndefined();
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });
});
