import { chunkForSpeech, splitSentences } from '../../../src/features/voice/sentences';

describe('splitSentences', () => {
  it('peels a complete sentence and returns the incomplete tail as remainder', () => {
    const { sentences, remainder } = splitSentences('Hello world. How are');
    expect(sentences).toEqual(['Hello world.']);
    expect(remainder).toBe('How are');
  });

  it('peels multiple complete sentences with no remainder', () => {
    const { sentences, remainder } = splitSentences('One. Two! Three?');
    expect(sentences).toEqual(['One.', 'Two!', 'Three?']);
    expect(remainder).toBe('');
  });

  it('returns nothing and an empty remainder for terminator-free text', () => {
    const { sentences, remainder } = splitSentences('no terminator yet');
    expect(sentences).toEqual([]);
    expect(remainder).toBe('no terminator yet');
  });

  it('holds an unclosed fenced block in the remainder (never speaks streaming code)', () => {
    const { sentences, remainder } = splitSentences('text ```\nsome code');
    expect(sentences).toEqual([]);
    expect(remainder).toBe('text ```\nsome code');
  });

  it('drops a closed fenced block outright', () => {
    const { sentences, remainder } = splitSentences('a ```\ncode\n``` b. end.');
    expect(sentences).toEqual(['a b.', 'end.']);
    expect(remainder).toBe('');
  });

  it('strips markdown emphasis from a sentence', () => {
    const { sentences } = splitSentences('**Bold** text.');
    expect(sentences).toEqual(['text.']);
  });

  it('strips a leading enumeration marker', () => {
    // A ")"-style marker stays attached to its text (the terminating "." comes
    // later), so cleaning drops the "2) " prefix. Faithful to sentences.py.
    const { sentences } = splitSentences('2) First item.');
    expect(sentences).toEqual(['First item.']);
  });

  it('keeps trailing quotes on the sentence they close', () => {
    const { sentences, remainder } = splitSentences('He said "stop." Then left');
    expect(sentences).toEqual(['He said "stop."']);
    expect(remainder).toBe('Then left');
  });

  it('drops units that are only markdown/whitespace after cleaning', () => {
    // The leading "**\n" cleans to an empty string and is dropped.
    const { sentences } = splitSentences('**\nReal sentence.');
    expect(sentences).toEqual(['Real sentence.']);
  });
});

describe('chunkForSpeech', () => {
  it('returns an empty array for empty input', () => {
    expect(chunkForSpeech('')).toEqual([]);
    expect(chunkForSpeech('   ')).toEqual([]);
  });

  it('flushes the first clip at the first sentence end for a snappy start', () => {
    expect(chunkForSpeech('One. Two three four.')).toEqual(['One.', 'Two three four.']);
  });

  it('merges whole short sentences up to the target word count', () => {
    // After the first single-sentence clip, the remaining short sentences merge
    // into one clip because their combined length stays under ~30 words.
    expect(chunkForSpeech('Go. A b. C d. E f.')).toEqual(['Go.', 'A b. C d. E f.']);
  });

  it('hard-caps run-on text with no sentence terminator at 60 words', () => {
    const words = Array.from({ length: 65 }, (_, i) => `w${i}`).join(' ');
    const chunks = chunkForSpeech(words);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].split(' ')).toHaveLength(60);
    expect(chunks[1].split(' ')).toHaveLength(5);
  });

  it('joining the chunks with spaces preserves word order', () => {
    const text = 'Alpha beta. Gamma delta epsilon. Zeta.';
    expect(chunkForSpeech(text).join(' ')).toBe(text);
  });
});
