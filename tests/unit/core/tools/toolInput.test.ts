import {
  extractResolvedAnswers,
  extractResolvedAnswersFromResultText,
} from '@/core/tools/toolInput';

describe('extractResolvedAnswers', () => {
  it('returns undefined when result is not an object', () => {
    expect(extractResolvedAnswers('bad')).toBeUndefined();
    expect(extractResolvedAnswers(123)).toBeUndefined();
    expect(extractResolvedAnswers(undefined)).toBeUndefined();
    expect(extractResolvedAnswers(null)).toBeUndefined();
  });

  it('returns undefined when answers is missing', () => {
    expect(extractResolvedAnswers({})).toBeUndefined();
  });

  it('returns undefined when answers is not an object', () => {
    expect(extractResolvedAnswers({ answers: 'bad' })).toBeUndefined();
    expect(extractResolvedAnswers({ answers: null })).toBeUndefined();
    expect(extractResolvedAnswers({ answers: [] })).toBeUndefined();
  });

  it('normalizes structured answers', () => {
    const answers = { foo: 'bar', baz: 1, ok: true, choices: ['A', 'B'] };
    expect(extractResolvedAnswers({ answers })).toEqual({
      foo: 'bar',
      baz: '1',
      ok: 'true',
      choices: ['A', 'B'],
    });
  });

  it('excludes empty-string answers', () => {
    expect(extractResolvedAnswers({ answers: { q1: 'yes', q2: '' } })).toEqual({ q1: 'yes' });
  });

  it('returns undefined when all answers are empty strings', () => {
    expect(extractResolvedAnswers({ answers: { q1: '', q2: '' } })).toBeUndefined();
  });
});

describe('extractResolvedAnswersFromResultText', () => {
  it('returns undefined for non-string or empty values', () => {
    expect(extractResolvedAnswersFromResultText(undefined)).toBeUndefined();
    expect(extractResolvedAnswersFromResultText(null)).toBeUndefined();
    expect(extractResolvedAnswersFromResultText(123)).toBeUndefined();
    expect(extractResolvedAnswersFromResultText('   ')).toBeUndefined();
  });

  it('extracts answers from quoted key-value pairs', () => {
    expect(extractResolvedAnswersFromResultText('"Color?"="Blue" "Size?"="M"')).toEqual({
      'Color?': 'Blue',
      'Size?': 'M',
    });
  });

  it('extracts answers from JSON object text', () => {
    expect(extractResolvedAnswersFromResultText('{"Color?":"Blue","Fast?":true}')).toEqual({
      'Color?': 'Blue',
      'Fast?': 'true',
    });
  });

  it('extracts nested Codex answer objects from JSON result text', () => {
    expect(extractResolvedAnswersFromResultText('{"answers":{"q1":{"answers":["yes"]}}}')).toEqual({
      q1: 'yes',
    });
  });

  it('preserves multi-answer arrays from JSON result text', () => {
    expect(extractResolvedAnswersFromResultText('{"answers":{"q1":{"answers":["yes","later"]}}}')).toEqual({
      q1: ['yes', 'later'],
    });
  });

  it('extracts nested answer values from wrapped JSON text', () => {
    expect(extractResolvedAnswersFromResultText('Result: {"answers":{"q1":{"value":"Blue"}}}')).toEqual({
      q1: 'Blue',
    });
  });

  it('returns undefined when text cannot be parsed', () => {
    expect(extractResolvedAnswersFromResultText('No parsed answers here')).toBeUndefined();
  });

  it('excludes empty-string values in JSON object text', () => {
    expect(extractResolvedAnswersFromResultText('{"Color?":"Blue","Name?":""}')).toEqual({
      'Color?': 'Blue',
    });
  });
});
