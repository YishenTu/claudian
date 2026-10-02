import { stringifyUnknown } from '@/utils/stringify';

describe('stringifyUnknown', () => {
  it.each([
    ['text', 'text'], [42, '42'], [BigInt(42), '42'], [false, 'false'],
    [null, 'null'], [undefined, 'undefined'],
    [{ message: 'failure' }, '{"message":"failure"}'],
    [[1, 'two'], '[1,"two"]'],
  ])('renders %p as readable text', (value, expected) => {
    expect(stringifyUnknown(value)).toBe(expected);
  });

  it('keeps rendering when an object cannot be serialized', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(stringifyUnknown(circular)).toBe('[Unserializable value]');
    expect(stringifyUnknown({ toJSON() { throw new Error('Unavailable'); } })).toBe('[Unserializable value]');
    expect(stringifyUnknown({ toJSON() { return undefined; } })).toBe('[Unserializable value]');
  });
});
