import { HorizontalWheelGesture } from '@/features/chat/ui/HorizontalWheelGesture';

type WheelGestureEvent = Parameters<HorizontalWheelGesture['consume']>[0];

function wheel(
  deltaX: number,
  deltaY: number,
  timeStamp: number,
  overrides: Partial<WheelGestureEvent> = {},
): WheelGestureEvent {
  return {
    ctrlKey: false,
    deltaMode: 0,
    deltaX,
    deltaY,
    timeStamp,
    ...overrides,
  };
}

describe('HorizontalWheelGesture', () => {
  it('emits once per swipe while ignoring vertical scroll and momentum', () => {
    const gesture = new HorizontalWheelGesture();

    expect(gesture.consume(wheel(10, 60, 0))).toBe(false);
    expect(gesture.consume(wheel(28, 30, 10))).toBe(true);
    expect(gesture.consume(wheel(60, 0, 20))).toBe(false);
    expect(gesture.consume(wheel(4, 0, 120))).toBe(false);
  });

  it('recognizes a fresh swipe impulse before momentum becomes fully idle', () => {
    const gesture = new HorizontalWheelGesture();

    expect(gesture.consume(wheel(28, 0, 10))).toBe(true);
    expect(gesture.consume(wheel(4, 0, 120))).toBe(false);
    expect(gesture.consume(wheel(18, 0, 220))).toBe(false);
    expect(gesture.consume(wheel(12, 0, 230))).toBe(true);
  });

  it('treats either direction as the same semantic swipe', () => {
    const gesture = new HorizontalWheelGesture();

    expect(gesture.consume(wheel(28, 0, 0))).toBe(true);
    expect(gesture.consume(wheel(-28, 0, 200))).toBe(true);
  });

  it('ignores pinch zoom and resets all gesture state explicitly', () => {
    const gesture = new HorizontalWheelGesture();

    expect(gesture.consume(wheel(30, 0, 0, { ctrlKey: true }))).toBe(false);
    expect(gesture.consume(wheel(12, 0, 10))).toBe(false);
    gesture.reset();
    expect(gesture.consume(wheel(12, 0, 20))).toBe(false);
    expect(gesture.consume(wheel(12, 0, 30))).toBe(true);
  });
});
