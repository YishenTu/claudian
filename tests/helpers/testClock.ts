/**
 * Capture one current-time baseline per test module environment so imported fixture constants
 * and clocks agree. Each testClock owns its time; advancing one never changes other fixtures.
 */
const EPOCH_MS = Date.now();

export interface TestTimeOffset {
  readonly days?: number;
  readonly hours?: number;
  readonly minutes?: number;
  readonly seconds?: number;
  readonly milliseconds?: number;
}

function offsetMs(offset: TestTimeOffset): number {
  return (offset.days ?? 0) * 86_400_000
    + (offset.hours ?? 0) * 3_600_000
    + (offset.minutes ?? 0) * 60_000
    + (offset.seconds ?? 0) * 1_000
    + (offset.milliseconds ?? 0);
}

export function testDate(offset: TestTimeOffset = {}): Date {
  return new Date(EPOCH_MS + offsetMs(offset));
}

export function testTime(offset: TestTimeOffset = {}): string {
  return testDate(offset).toISOString();
}

/** An independently controlled clock for one test's `now` options. */
export function testClock(offset: TestTimeOffset = {}): (() => Date) & {
  advance(elapsed: TestTimeOffset): void;
} {
  let current = testDate(offset).getTime();
  return Object.assign(() => new Date(current), {
    advance: (elapsed: TestTimeOffset) => { current += offsetMs(elapsed); },
  });
}
