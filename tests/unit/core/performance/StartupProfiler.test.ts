import { StartupProfiler } from '@/core/performance/StartupProfiler';

describe('StartupProfiler', () => {
  beforeEach(() => {
    StartupProfiler.reset();
  });

  afterEach(() => {
    StartupProfiler.reset();
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

  it('returns JSON report', () => {
    StartupProfiler.startOnload();
    StartupProfiler.finishOnload();
    StartupProfiler.recordCount('restored-tab-count', 3);

    const json = StartupProfiler.toJSON();
    const parsed = JSON.parse(json);
    expect(parsed.counts['restored-tab-count']).toBe(3);
    expect(parsed.spans).toEqual([]);
  });

  it('copies report to clipboard', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(global.navigator, { clipboard: { writeText } });

    StartupProfiler.recordCount('session-metadata-count', 5);
    const copied = await StartupProfiler.copyToClipboard();

    expect(copied).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    const written = writeText.mock.calls[0][0] as string;
    expect(JSON.parse(written).counts['session-metadata-count']).toBe(5);
  });

  it('returns false when clipboard write fails', async () => {
    Object.assign(global.navigator, {
      clipboard: { writeText: jest.fn().mockRejectedValue(new Error('denied')) },
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

  it('run helper wraps synchronous functions', () => {
    const result = StartupProfiler.run('sync-span', () => 42);
    expect(result).toBe(42);
    expect(StartupProfiler.getReport().spans[0].name).toBe('sync-span');
  });

  it('runAsync helper wraps asynchronous functions', async () => {
    const result = await StartupProfiler.runAsync('async-span', async () => 'value');
    expect(result).toBe('value');
    expect(StartupProfiler.getReport().spans[0].name).toBe('async-span');
  });
});
