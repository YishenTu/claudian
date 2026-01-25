/**
 * Unit tests for context utilities.
 */

import {
  appendContextFiles,
  appendCurrentNote,
  extractContentBeforeXmlContext,
  extractUserQuery,
  formatCurrentNote,
  stripCurrentNoteContext,
  XML_CONTEXT_PATTERN,
} from '../../../src/utils/context';

describe('formatCurrentNote', () => {
  it('formats note path in XML tags', () => {
    expect(formatCurrentNote('notes/test.md')).toBe(
      '<current_note>\nnotes/test.md\n</current_note>'
    );
  });

  it('handles paths with special characters', () => {
    expect(formatCurrentNote('notes/my file (1).md')).toBe(
      '<current_note>\nnotes/my file (1).md\n</current_note>'
    );
  });
});

describe('appendCurrentNote', () => {
  it('appends current note to prompt with double newline separator', () => {
    const result = appendCurrentNote('Hello', 'notes/test.md');
    expect(result).toBe(
      'Hello\n\n<current_note>\nnotes/test.md\n</current_note>'
    );
  });

  it('preserves original prompt content', () => {
    const result = appendCurrentNote('Multi\nline\nprompt', 'test.md');
    expect(result.startsWith('Multi\nline\nprompt\n\n')).toBe(true);
  });
});

describe('stripCurrentNoteContext', () => {
  describe('legacy prefix format', () => {
    it('strips current_note from start of prompt', () => {
      const prompt = '<current_note>\nnotes/test.md\n</current_note>\n\nUser query here';
      expect(stripCurrentNoteContext(prompt)).toBe('User query here');
    });

    it('handles multiline note content in prefix', () => {
      const prompt = '<current_note>\npath/to/note.md\nwith extra info\n</current_note>\n\nQuery';
      expect(stripCurrentNoteContext(prompt)).toBe('Query');
    });
  });

  describe('current suffix format', () => {
    it('strips current_note from end of prompt', () => {
      const prompt = 'User query here\n\n<current_note>\nnotes/test.md\n</current_note>';
      expect(stripCurrentNoteContext(prompt)).toBe('User query here');
    });

    it('handles multiline note content in suffix', () => {
      const prompt = 'Query\n\n<current_note>\npath/to/note.md\n</current_note>';
      expect(stripCurrentNoteContext(prompt)).toBe('Query');
    });
  });

  it('returns unchanged prompt when no current_note present', () => {
    const prompt = 'Just a regular prompt';
    expect(stripCurrentNoteContext(prompt)).toBe('Just a regular prompt');
  });

  it('prefers prefix format when both could match', () => {
    // This tests the function order: it tries prefix first
    const prefixPrompt = '<current_note>\ntest.md\n</current_note>\n\nQuery';
    expect(stripCurrentNoteContext(prefixPrompt)).toBe('Query');
  });
});

describe('XML_CONTEXT_PATTERN', () => {
  it('matches current_note tag', () => {
    const text = 'Query\n\n<current_note>\ntest.md\n</current_note>';
    expect(XML_CONTEXT_PATTERN.test(text)).toBe(true);
  });

  it('matches editor_selection tag with attributes', () => {
    const text = 'Query\n\n<editor_selection path="test.md">\nselected text\n</editor_selection>';
    expect(XML_CONTEXT_PATTERN.test(text)).toBe(true);
  });

  it('matches editor_cursor tag', () => {
    const text = 'Query\n\n<editor_cursor path="test.md">\n</editor_cursor>';
    expect(XML_CONTEXT_PATTERN.test(text)).toBe(true);
  });

  it('matches context_files tag', () => {
    const text = 'Query\n\n<context_files>\nfile1.md, file2.md\n</context_files>';
    expect(XML_CONTEXT_PATTERN.test(text)).toBe(true);
  });

  it('does not match without double newline separator', () => {
    const text = 'Query\n<current_note>\ntest.md\n</current_note>';
    expect(XML_CONTEXT_PATTERN.test(text)).toBe(false);
  });

  it('does not match other XML tags', () => {
    const text = 'Query\n\n<other_tag>\ncontent\n</other_tag>';
    expect(XML_CONTEXT_PATTERN.test(text)).toBe(false);
  });
});

describe('extractContentBeforeXmlContext', () => {
  describe('legacy format with <query> tags', () => {
    it('extracts content from query tags', () => {
      const prompt = '<current_note>\ntest.md\n</current_note>\n\n<query>\nUser question\n</query>';
      expect(extractContentBeforeXmlContext(prompt)).toBe('User question');
    });

    it('trims whitespace from extracted content', () => {
      const prompt = '<query>\n  spaced content  \n</query>';
      expect(extractContentBeforeXmlContext(prompt)).toBe('spaced content');
    });

    it('handles multiline content in query tags', () => {
      const prompt = '<query>\nLine 1\nLine 2\nLine 3\n</query>';
      expect(extractContentBeforeXmlContext(prompt)).toBe('Line 1\nLine 2\nLine 3');
    });
  });

  describe('current format with user content first', () => {
    it('extracts content before current_note tag', () => {
      const prompt = 'User query\n\n<current_note>\ntest.md\n</current_note>';
      expect(extractContentBeforeXmlContext(prompt)).toBe('User query');
    });

    it('extracts content before editor_selection tag', () => {
      const prompt = 'Edit this\n\n<editor_selection path="test.md">\nselected\n</editor_selection>';
      expect(extractContentBeforeXmlContext(prompt)).toBe('Edit this');
    });

    it('extracts content before editor_cursor tag', () => {
      const prompt = 'Insert here\n\n<editor_cursor path="test.md">\n</editor_cursor>';
      expect(extractContentBeforeXmlContext(prompt)).toBe('Insert here');
    });

    it('extracts content before context_files tag', () => {
      const prompt = 'Use these files\n\n<context_files>\nfile1.md\n</context_files>';
      expect(extractContentBeforeXmlContext(prompt)).toBe('Use these files');
    });

    it('handles multiple context tags - extracts before first one', () => {
      const prompt = 'Query\n\n<current_note>\ntest.md\n</current_note>\n\n<editor_selection path="x">\ny\n</editor_selection>';
      expect(extractContentBeforeXmlContext(prompt)).toBe('Query');
    });

    it('trims whitespace from extracted content', () => {
      const prompt = '  spaced query  \n\n<current_note>\ntest.md\n</current_note>';
      expect(extractContentBeforeXmlContext(prompt)).toBe('spaced query');
    });
  });

  describe('edge cases', () => {
    it('returns undefined for empty string', () => {
      expect(extractContentBeforeXmlContext('')).toBeUndefined();
    });

    it('returns undefined for plain text without XML context', () => {
      expect(extractContentBeforeXmlContext('Just a plain prompt')).toBeUndefined();
    });

    it('returns undefined for null-ish input', () => {
      expect(extractContentBeforeXmlContext(null as unknown as string)).toBeUndefined();
      expect(extractContentBeforeXmlContext(undefined as unknown as string)).toBeUndefined();
    });
  });
});

describe('extractUserQuery', () => {
  describe('with XML context (delegates to extractContentBeforeXmlContext)', () => {
    it('extracts content from legacy query tags', () => {
      const prompt = '<current_note>\ntest.md\n</current_note>\n\n<query>\nUser question\n</query>';
      expect(extractUserQuery(prompt)).toBe('User question');
    });

    it('extracts content before XML context tags', () => {
      const prompt = 'User query\n\n<current_note>\ntest.md\n</current_note>';
      expect(extractUserQuery(prompt)).toBe('User query');
    });
  });

  describe('fallback tag stripping', () => {
    it('strips current_note tags without structured format', () => {
      // Tag and trailing whitespace are replaced, leaving single space
      const prompt = 'Query <current_note>test.md</current_note> continues';
      expect(extractUserQuery(prompt)).toBe('Query continues');
    });

    it('strips editor_selection tags', () => {
      const prompt = 'Query <editor_selection path="x">text</editor_selection> end';
      expect(extractUserQuery(prompt)).toBe('Query end');
    });

    it('strips editor_cursor tags', () => {
      const prompt = 'Query <editor_cursor path="x"></editor_cursor> end';
      expect(extractUserQuery(prompt)).toBe('Query end');
    });

    it('strips context_files tags', () => {
      const prompt = 'Query <context_files>file.md</context_files> end';
      expect(extractUserQuery(prompt)).toBe('Query end');
    });

    it('strips multiple tag types', () => {
      const prompt = '<current_note>a.md</current_note>Query<context_files>b.md</context_files>';
      expect(extractUserQuery(prompt)).toBe('Query');
    });
  });

  describe('edge cases', () => {
    it('returns empty string for empty input', () => {
      expect(extractUserQuery('')).toBe('');
    });

    it('returns empty string for null-ish input', () => {
      expect(extractUserQuery(null as unknown as string)).toBe('');
      expect(extractUserQuery(undefined as unknown as string)).toBe('');
    });

    it('returns trimmed plain text when no tags present', () => {
      expect(extractUserQuery('  plain query  ')).toBe('plain query');
    });
  });
});

describe('appendContextFiles', () => {
  it('appends context files in XML format', () => {
    const result = appendContextFiles('Query', ['file1.md', 'file2.md']);
    expect(result).toBe('Query\n\n<context_files>\nfile1.md, file2.md\n</context_files>');
  });

  it('handles single file', () => {
    const result = appendContextFiles('Query', ['single.md']);
    expect(result).toBe('Query\n\n<context_files>\nsingle.md\n</context_files>');
  });

  it('handles empty file array', () => {
    const result = appendContextFiles('Query', []);
    expect(result).toBe('Query\n\n<context_files>\n\n</context_files>');
  });
});
