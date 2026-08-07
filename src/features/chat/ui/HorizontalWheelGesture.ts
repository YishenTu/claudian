type WheelGestureEvent = Pick<
  WheelEvent,
  'ctrlKey' | 'deltaMode' | 'deltaX' | 'deltaY' | 'timeStamp'
>;

const ACTIVATION_DISTANCE = 24;
const HORIZONTAL_INTENT_RATIO = 0.75;
const GESTURE_IDLE_MS = 160;
const MOMENTUM_LOCK_MS = 100;
const NEW_IMPULSE_MIN = 8;
const NEW_IMPULSE_RATIO = 1.75;
const WHEEL_DELTA_MODE_LINE = 1;
const WHEEL_DELTA_MODE_PAGE = 2;
const WHEEL_LINE_HEIGHT = 16;
const WHEEL_PAGE_WIDTH = 180;

/** Converts a browser wheel-event stream into one signal per horizontal swipe. */
export class HorizontalWheelGesture {
  private accumulatedDelta = 0;
  private isLocked = false;
  private lockedAt: number | null = null;
  private lastDelta = 0;
  private lastEventAt: number | null = null;

  consume(event: WheelGestureEvent): boolean {
    if (
      event.ctrlKey
      || Math.abs(event.deltaX) < Math.abs(event.deltaY) * HORIZONTAL_INTENT_RATIO
    ) return false;

    const delta = this.normalizeDelta(event);
    const elapsed = this.lastEventAt === null
      ? Number.POSITIVE_INFINITY
      : event.timeStamp - this.lastEventAt;
    const lockedFor = this.lockedAt === null ? 0 : event.timeStamp - this.lockedAt;
    const hasFreshImpulse = this.isLocked
      && lockedFor >= MOMENTUM_LOCK_MS
      && Math.abs(delta) >= NEW_IMPULSE_MIN
      && (
        Math.sign(delta) !== Math.sign(this.lastDelta)
        || Math.abs(delta) >= Math.abs(this.lastDelta) * NEW_IMPULSE_RATIO
      );

    if (elapsed > GESTURE_IDLE_MS || elapsed < 0 || hasFreshImpulse) {
      this.accumulatedDelta = 0;
      this.isLocked = false;
      this.lockedAt = null;
    }

    this.lastEventAt = event.timeStamp;
    this.lastDelta = delta;
    if (this.isLocked) return false;

    this.accumulatedDelta += delta;
    if (Math.abs(this.accumulatedDelta) < ACTIVATION_DISTANCE) return false;

    this.accumulatedDelta = 0;
    this.isLocked = true;
    this.lockedAt = event.timeStamp;
    return true;
  }

  reset(): void {
    this.accumulatedDelta = 0;
    this.isLocked = false;
    this.lockedAt = null;
    this.lastDelta = 0;
    this.lastEventAt = null;
  }

  private normalizeDelta(event: WheelGestureEvent): number {
    if (event.deltaMode === WHEEL_DELTA_MODE_LINE) return event.deltaX * WHEEL_LINE_HEIGHT;
    if (event.deltaMode === WHEEL_DELTA_MODE_PAGE) return event.deltaX * WHEEL_PAGE_WIDTH;
    return event.deltaX;
  }
}
