import type * as TestClockHelpers from '@test/helpers/testClock';
import { testClock, testDate, testTime } from '@test/helpers/testClock';

describe('test clock', () => {
  it('anchors fixtures to the current run, including runs years later', () => {
    const future = Date.now() + 1_100 * 86_400_000;
    jest.useFakeTimers();
    try {
      jest.setSystemTime(future);
      jest.isolateModules(() => {
        const clock = jest.requireActual<typeof TestClockHelpers>('@test/helpers/testClock');
        expect(clock.testDate().getTime()).toBe(future);
        expect(clock.testDate({ days: 1 }).getTime()).toBe(future + 86_400_000);
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps fixture dates and injected clocks on the same timeline', () => {
    const now = testClock({ minutes: 1 });
    expect(now().toISOString()).toBe(testTime({ minutes: 1 }));
    expect(testDate({ minutes: 2 }).getTime() - now().getTime()).toBe(60_000);
    now().setTime(0);
    expect(now().toISOString()).toBe(testTime({ minutes: 1 }));
  });

  it('crosses an expiry boundary without advancing another test clock', () => {
    const now = testClock();
    const other = testClock();
    const expiresAt = testDate({ minutes: 1 }).getTime();
    now.advance({ seconds: 59 });
    expect(now().getTime()).toBeLessThan(expiresAt);
    now.advance({ seconds: 1 });
    expect(now().getTime()).toBe(expiresAt);
    expect(other().getTime()).toBe(testDate().getTime());
  });
});
