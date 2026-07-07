import { mergeDictation } from '../../../src/features/voice/dictationInsert';

describe('mergeDictation', () => {
  it('inserts into an empty input without a leading space', () => {
    expect(mergeDictation('', 'hello world', 0)).toEqual({
      value: 'hello world',
      caret: 'hello world'.length,
    });
  });

  it('appends at the caret with a joining space after non-space text', () => {
    const existing = 'first';
    const result = mergeDictation(existing, 'second', existing.length);
    expect(result.value).toBe('first second');
    expect(result.caret).toBe('first second'.length);
  });

  it('does not add a second space when the caret already follows whitespace', () => {
    const existing = 'first ';
    const result = mergeDictation(existing, 'second', existing.length);
    expect(result.value).toBe('first second');
  });

  it('splices at a mid-string caret rather than always appending', () => {
    // Caret sits right after "abc" in "abc def".
    const result = mergeDictation('abc def', 'X', 3);
    expect(result.value).toBe('abc X def');
    expect(result.caret).toBe('abc X'.length);
  });

  it('inserts at the start with no leading space when caret is 0', () => {
    const result = mergeDictation('world', 'hello', 0);
    expect(result.value).toBe('helloworld');
    expect(result.caret).toBe('hello'.length);
  });

  it('clamps an out-of-range caret to the input length', () => {
    const result = mergeDictation('abc', 'x', 999);
    expect(result.value).toBe('abc x');
  });

  it('clamps a negative caret to 0', () => {
    const result = mergeDictation('abc', 'x', -5);
    expect(result.value).toBe('xabc');
    expect(result.caret).toBe('x'.length);
  });
});
