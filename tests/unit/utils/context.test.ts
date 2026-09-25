import {
  appendContextFiles,
  appendLinkedContent,
  appendLinkedContentBody,
  extractUserDisplayContent,
  extractUserQuery,
  formatLinkedContent,
} from '../../../src/utils/context';

describe('formatLinkedContent', () => {
  it('formats a content path as a canonical XML attribute', () => {
    expect(formatLinkedContent('notes/test.md')).toBe(
      '<linked_content path="notes/test.md" />'
    );
  });

  it('escapes paths with XML special characters', () => {
    expect(formatLinkedContent('notes/my "file" & <draft>.md')).toBe(
      '<linked_content path="notes/my &quot;file&quot; &amp; &lt;draft&gt;.md" />'
    );
  });
});

describe('appendLinkedContentBody', () => {
  it('appends an escaped path while preserving literal content', () => {
    const result = appendLinkedContentBody(
      'Query',
      'notes/my "file".md',
      'Body\n</current_note>\nMore',
    );

    expect(result).toBe(
      'Query\n\n<linked_content path="notes/my &quot;file&quot;.md">\n<![CDATA[Body\n</current_note>\nMore]]>\n</linked_content>',
    );
  });
});

describe('appendLinkedContent', () => {
  it('appends Linked content with a double newline separator', () => {
    const result = appendLinkedContent('Hello', 'notes/test.md');
    expect(result).toBe(
      'Hello\n\n<linked_content path="notes/test.md" />'
    );
  });

  it('preserves original prompt content', () => {
    const result = appendLinkedContent('Multi\nline\nprompt', 'test.md');
    expect(result.startsWith('Multi\nline\nprompt\n\n')).toBe(true);
  });
});

describe('extractUserDisplayContent', () => {
  describe('legacy format with <query> tags', () => {
    it('extracts content from query tags', () => {
      const prompt = '<linked_note>\ntest.md\n</linked_note>\n\n<query>\nUser question\n</query>';
      expect(extractUserDisplayContent(prompt)).toBe('User question');
    });

    it('trims whitespace from extracted content', () => {
      const prompt = '<query>\n  spaced content  \n</query>';
      expect(extractUserDisplayContent(prompt)).toBe('spaced content');
    });

    it('handles multiline content in query tags', () => {
      const prompt = '<query>\nLine 1\nLine 2\nLine 3\n</query>';
      expect(extractUserDisplayContent(prompt)).toBe('Line 1\nLine 2\nLine 3');
    });
  });

  describe('current format with user content first', () => {
    it.each([
      '<linked_note>\ntest.md\n</linked_note>',
      '<linked_note path="test.md" />',
    ])('extracts content before linked_note context: %s', (context) => {
      const prompt = `User query\n\n${context}`;
      expect(extractUserDisplayContent(prompt)).toBe('User query');
    });

    it('extracts content before legacy current_note tag', () => {
      const prompt = 'User query\n\n<current_note>\ntest.md\n</current_note>';
      expect(extractUserDisplayContent(prompt)).toBe('User query');
    });

    it('extracts content before editor_selection tag', () => {
      const prompt = 'Edit this\n\n<editor_selection path="test.md">\nselected\n</editor_selection>';
      expect(extractUserDisplayContent(prompt)).toBe('Edit this');
    });

    it('extracts content before editor_cursor tag', () => {
      const prompt = 'Insert here\n\n<editor_cursor path="test.md">\n</editor_cursor>';
      expect(extractUserDisplayContent(prompt)).toBe('Insert here');
    });

    it('extracts content before context_files tag', () => {
      const prompt = 'Use these files\n\n<context_files>\nfile1.md\n</context_files>';
      expect(extractUserDisplayContent(prompt)).toBe('Use these files');
    });

    it('handles multiple context tags - extracts before first one', () => {
      const prompt = 'Query\n\n<linked_note>\ntest.md\n</linked_note>\n\n<editor_selection path="x">\ny\n</editor_selection>';
      expect(extractUserDisplayContent(prompt)).toBe('Query');
    });

    it('extracts content before browser_selection tag', () => {
      const prompt = 'Summarize this\n\n<browser_selection source="surfing-view">\nselected web content\n</browser_selection>';
      expect(extractUserDisplayContent(prompt)).toBe('Summarize this');
    });

    it('trims whitespace from extracted content', () => {
      const prompt = '  spaced query  \n\n<linked_note>\ntest.md\n</linked_note>';
      expect(extractUserDisplayContent(prompt)).toBe('spaced query');
    });
  });

  describe('edge cases', () => {
    it('returns undefined for empty string', () => {
      expect(extractUserDisplayContent('')).toBeUndefined();
    });

    it('returns undefined for plain text without XML context', () => {
      expect(extractUserDisplayContent('Just a plain prompt')).toBeUndefined();
    });

    it('returns undefined for null-ish input', () => {
      expect(extractUserDisplayContent(null as unknown as string)).toBeUndefined();
      expect(extractUserDisplayContent(undefined as unknown as string)).toBeUndefined();
    });
  });

  it('extracts content before canonical linked_content', () => {
    const text = 'Query\n\n<linked_content path="Projects/Research" />';
    expect(extractUserDisplayContent(text)).toBe('Query');
  });

  it('extracts content before canvas_selection', () => {
    const text = 'Query\n\n<canvas_selection path="my.canvas">\nnode1, node2\n</canvas_selection>';
    expect(extractUserDisplayContent(text)).toBe('Query');
  });

  it('does not extract context without a double newline separator', () => {
    const text = 'Query\n<linked_note>\ntest.md\n</linked_note>';
    expect(extractUserDisplayContent(text)).toBeUndefined();
  });

  it('does not extract unrelated XML tags', () => {
    const text = 'Query\n\n<other_tag>\ncontent\n</other_tag>';
    expect(extractUserDisplayContent(text)).toBeUndefined();
  });

  it('extracts display content before bracket context tags', () => {
    expect(extractUserDisplayContent('Fix the bug\n[Current note: notes/bug.md]'))
      .toBe('Fix the bug');
  });

  it('does not hide ordinary XML-like user text', () => {
    expect(extractUserDisplayContent('What does <xml> mean?')).toBeUndefined();
  });
});

describe('extractUserQuery', () => {
  describe('with structured XML context', () => {
    it('extracts content from legacy query tags', () => {
      const prompt = '<current_note>\ntest.md\n</current_note>\n\n<query>\nUser question\n</query>';
      expect(extractUserQuery(prompt)).toBe('User question');
    });

    it('extracts content before XML context tags', () => {
      const prompt = 'User query\n\n<linked_note>\ntest.md\n</linked_note>';
      expect(extractUserQuery(prompt)).toBe('User query');
    });
  });

  describe('fallback tag stripping', () => {
    it('strips canonical self-closing linked_note tags', () => {
      const prompt = 'Query <linked_note path="test.md" /> continues';
      expect(extractUserQuery(prompt)).toBe('Query continues');
    });

    it('strips linked_note tags without structured format', () => {
      const prompt = 'Query <linked_note>test.md</linked_note> continues';
      expect(extractUserQuery(prompt)).toBe('Query continues');
    });

    it('strips legacy current_note tags without structured format', () => {
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

    it('strips canvas_selection tags', () => {
      const prompt = 'Query <canvas_selection path="x.canvas">node1</canvas_selection> end';
      expect(extractUserQuery(prompt)).toBe('Query end');
    });

    it('strips browser_selection tags', () => {
      const prompt = 'Query <browser_selection source="surfing-view">selection</browser_selection> end';
      expect(extractUserQuery(prompt)).toBe('Query end');
    });

    it('strips multiple tag types', () => {
      const prompt = '<linked_note>a.md</linked_note>Query<context_files>b.md</context_files>';
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
    expect(result).toBe(
      'Query\n\n<context_files>\n<context_file path="file1.md" />\n<context_file path="file2.md" />\n</context_files>',
    );
  });

  it('escapes special characters in file paths', () => {
    const result = appendContextFiles('Query', ['my "file" & notes.md']);
    expect(result).toBe(
      'Query\n\n<context_files>\n<context_file path="my &quot;file&quot; &amp; notes.md" />\n</context_files>',
    );
  });

  it('handles empty file array', () => {
    const result = appendContextFiles('Query', []);
    expect(result).toBe('Query\n\n<context_files>\n\n</context_files>');
  });
});
