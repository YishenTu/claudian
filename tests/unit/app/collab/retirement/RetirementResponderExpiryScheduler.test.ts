import {
  RetirementResponderExpiryScheduler,
} from '@/app/collab/retirement/RetirementResponderExpiryScheduler';

describe('RetirementResponderExpiryScheduler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('keeps a 30-day responder alive through bounded timers and expires it once', async () => {
    jest.setSystemTime(Date.parse('2026-08-13T00:00:00.000Z'));
    const onExpire = jest.fn().mockResolvedValue(undefined);
    const subject = new RetirementResponderExpiryScheduler(onExpire);
    subject.schedule('project-alpha', '2026-09-12T00:00:00.000Z');

    await jest.advanceTimersByTimeAsync(29 * 24 * 60 * 60 * 1_000);
    expect(onExpire).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(onExpire).toHaveBeenCalledWith('project-alpha');
  });

  it('retries a failed expiry cleanup without a zero-delay loop', async () => {
    jest.setSystemTime(Date.parse('2026-09-12T00:00:00.000Z'));
    const onExpire = jest.fn()
      .mockRejectedValueOnce(new Error('disk busy'))
      .mockResolvedValueOnce(undefined);
    const subject = new RetirementResponderExpiryScheduler(onExpire);
    subject.schedule('project-alpha', '2026-09-12T00:00:00.000Z');

    await jest.advanceTimersByTimeAsync(0);
    expect(onExpire).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(59_999);
    expect(onExpire).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(onExpire).toHaveBeenCalledTimes(2);
  });

  it('cancels all pending expiry work on close', async () => {
    const onExpire = jest.fn().mockResolvedValue(undefined);
    const subject = new RetirementResponderExpiryScheduler(onExpire);
    subject.schedule('project-alpha', new Date(Date.now() + 1_000).toISOString());
    subject.close();

    await jest.advanceTimersByTimeAsync(1_000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('drains a fired expiry and never rearms it after close', async () => {
    let rejectExpiry!: (error: Error) => void;
    const onExpire = jest.fn(() => new Promise<void>((_resolve, reject) => {
      rejectExpiry = reject;
    }));
    const subject = new RetirementResponderExpiryScheduler(onExpire);
    subject.schedule('project-alpha', new Date(Date.now()).toISOString());
    await jest.advanceTimersByTimeAsync(0);
    expect(onExpire).toHaveBeenCalledTimes(1);

    let closed = false;
    const closing = subject.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    rejectExpiry(new Error('disk busy'));
    await closing;
    await jest.advanceTimersByTimeAsync(60_000);

    expect(closed).toBe(true);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
