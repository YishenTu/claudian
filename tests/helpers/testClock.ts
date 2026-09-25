/**
 * Shared test timeline. Expiries and injected clocks are expressed as offsets from one epoch,
 * so no test compares a hard-coded date against the real clock.
 */
export const TEST_EPOCH = '2026-08-27T00:00:00.000Z';

export interface TestTimeOffset {
  readonly days?: number;
  readonly hours?: number;
  readonly minutes?: number;
  readonly seconds?: number;
  readonly milliseconds?: number;
}

const EPOCH_MS = Date.parse(TEST_EPOCH);

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

/** A fixed clock for `now` options. */
export function testClock(offset: TestTimeOffset = {}): () => Date {
  return () => testDate(offset);
}

/**
 * A clock that starts at the given test time and advances with real elapsed time, for services
 * that wait on deadlines or order events by time.
 */
export function advancingTestClock(offset: TestTimeOffset = {}): () => Date {
  const startedAt = Date.now();
  const start = testDate(offset).getTime();
  return () => new Date(start + Date.now() - startedAt);
}
