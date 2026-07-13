import { StateStream } from '../../../src/features/voice/StateStream';

describe('StateStream', () => {
  it('replays the current value on subscribe', () => {
    const stream = new StateStream('idle');
    const seen: string[] = [];
    stream.subscribe((v) => seen.push(v));
    expect(seen).toEqual(['idle']);
  });

  it('notifies on distinct changes and skips duplicates', () => {
    const stream = new StateStream(0);
    const seen: number[] = [];
    stream.subscribe((v) => seen.push(v));
    stream.set(1);
    stream.set(1);
    stream.set(2);
    expect(seen).toEqual([0, 1, 2]);
    expect(stream.get()).toBe(2);
  });

  it('stops notifying after unsubscribe', () => {
    const stream = new StateStream('a');
    const seen: string[] = [];
    const unsubscribe = stream.subscribe((v) => seen.push(v));
    unsubscribe();
    stream.set('b');
    expect(seen).toEqual(['a']);
  });

  it('isolates a throwing listener from other listeners', () => {
    const stream = new StateStream(0);
    const seen: number[] = [];
    stream.subscribe(() => {
      throw new Error('boom');
    });
    stream.subscribe((v) => seen.push(v));
    stream.set(1);
    expect(seen).toEqual([0, 1]);
  });
});
