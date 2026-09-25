import { StartupProfiler } from '@/core/performance/StartupProfiler';

describe('StartupProfiler', () => {
  const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
    global.navigator,
    'clipboard',
  );

  beforeEach(() => {
    StartupProfiler.reset();
  });

  afterEach(() => {
    StartupProfiler.reset();
    if (originalClipboardDescriptor) {
      Object.defineProperty(global.navigator, 'clipboard', originalClipboardDescriptor);
    } else {
      Reflect.deleteProperty(global.navigator, 'clipboard');
    }
  });

  it('records module eval and onload times', () => {
    StartupProfiler.setModuleEvalTime(1);
    StartupProfiler.startOnload();
    StartupProfiler.finishOnload();

    const report = StartupProfiler.getReport();
    expect(report.moduleEvalTime).toBe(1);
    expect(report.onloadStartTime).toBeGreaterThan(0);
    expect(report.onloadEndTime).toBeGreaterThanOrEqual(report.onloadStartTime);
    expect(report.totalDurationMs).toBeDefined();
  });

  it('records spans', () => {
    const span = StartupProfiler.start('test-span');
    StartupProfiler.finish(span);

    const report = StartupProfiler.getReport();
    expect(report.spans).toHaveLength(1);
    expect(report.spans[0].name).toBe('test-span');
    expect(report.spans[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records counts', () => {
    StartupProfiler.recordCount('session-metadata-count', 42);
    StartupProfiler.increment('provider-init-failures');
    StartupProfiler.increment('provider-init-failures', 2);

    const report = StartupProfiler.getReport();
    expect(report.counts['session-metadata-count']).toBe(42);
    expect(report.counts['provider-init-failures']).toBe(3);
  });

  it('copies report to clipboard', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(global.navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    StartupProfiler.recordCount('session-metadata-count', 5);
    const copied = await StartupProfiler.copyToClipboard();

    expect(copied).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    const written = writeText.mock.calls[0][0] as string;
    const report = JSON.parse(written);
    expect(report.counts['session-metadata-count']).toBe(5);
    expect(report.spans).toEqual([]);
  });

  it('returns false when clipboard write fails', async () => {
    Object.defineProperty(global.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: jest.fn().mockRejectedValue(new Error('denied')) },
    });

    const copied = await StartupProfiler.copyToClipboard();
    expect(copied).toBe(false);
  });

  it('stops recording after freeze', () => {
    StartupProfiler.freeze();
    StartupProfiler.recordCount('ignored', 1);
    StartupProfiler.increment('ignored');

    const report = StartupProfiler.getReport();
    expect(report.counts['ignored']).toBeUndefined();
  });

  it('runAsync helper wraps asynchronous functions', async () => {
    const result = await StartupProfiler.runAsync('async-span', async () => 'value');
    expect(result).toBe('value');
    expect(StartupProfiler.getReport().spans[0].name).toBe('async-span');
  });
});
