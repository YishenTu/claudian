import {
  extractResolvedAnswers,
  extractResolvedAnswersFromResultText,
  getPathFromToolInput,
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
  });

  it('returns answers when valid', () => {
    const answers = { foo: 'bar', baz: 1 };
    expect(extractResolvedAnswers({ answers })).toBe(answers);
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

  it('returns undefined when text cannot be parsed', () => {
    expect(extractResolvedAnswersFromResultText('No parsed answers here')).toBeUndefined();
  });
});

describe('getPathFromToolInput', () => {
  describe('Read tool', () => {
    it('should extract file_path from Read tool input', () => {
      const result = getPathFromToolInput('Read', { file_path: '/path/to/file.txt' });

      expect(result).toBe('/path/to/file.txt');
    });

    it('should return null when file_path is missing', () => {
      const result = getPathFromToolInput('Read', {});

      expect(result).toBeNull();
    });

    it('should return null when file_path is empty', () => {
      const result = getPathFromToolInput('Read', { file_path: '' });

      expect(result).toBeNull();
    });

    it('should fall back to notebook_path when file_path is empty', () => {
      const result = getPathFromToolInput('Read', { file_path: '', notebook_path: '/path/to/notebook.ipynb' });

      expect(result).toBe('/path/to/notebook.ipynb');
    });
  });

  describe('Write tool', () => {
    it('should extract file_path from Write tool input', () => {
      const result = getPathFromToolInput('Write', { file_path: '/path/to/file.txt' });

      expect(result).toBe('/path/to/file.txt');
    });

    it('should return null when file_path is missing', () => {
      const result = getPathFromToolInput('Write', { content: 'some content' });

      expect(result).toBeNull();
    });

    it('should fall back to notebook_path when file_path is missing', () => {
      const result = getPathFromToolInput('Write', { notebook_path: '/path/to/notebook.ipynb' });

      expect(result).toBe('/path/to/notebook.ipynb');
    });
  });

  describe('Edit tool', () => {
    it('should extract file_path from Edit tool input', () => {
      const result = getPathFromToolInput('Edit', {
        file_path: '/path/to/file.txt',
        old_string: 'old',
        new_string: 'new',
      });

      expect(result).toBe('/path/to/file.txt');
    });

    it('should return null when file_path is missing', () => {
      const result = getPathFromToolInput('Edit', {
        old_string: 'old',
        new_string: 'new',
      });

      expect(result).toBeNull();
    });

    it('should fall back to notebook_path when file_path is missing', () => {
      const result = getPathFromToolInput('Edit', {
        notebook_path: '/path/to/notebook.ipynb',
        old_string: 'old',
        new_string: 'new',
      });

      expect(result).toBe('/path/to/notebook.ipynb');
    });
  });

  describe('NotebookEdit tool', () => {
    it('should extract file_path from NotebookEdit tool input', () => {
      const result = getPathFromToolInput('NotebookEdit', {
        file_path: '/path/to/notebook.ipynb',
      });

      expect(result).toBe('/path/to/notebook.ipynb');
    });

    it('should extract notebook_path from NotebookEdit tool input', () => {
      const result = getPathFromToolInput('NotebookEdit', {
        notebook_path: '/path/to/notebook.ipynb',
      });

      expect(result).toBe('/path/to/notebook.ipynb');
    });

    it('should prefer file_path over notebook_path', () => {
      const result = getPathFromToolInput('NotebookEdit', {
        file_path: '/path/via/file_path.ipynb',
        notebook_path: '/path/via/notebook_path.ipynb',
      });

      expect(result).toBe('/path/via/file_path.ipynb');
    });

    it('should return null when both paths are missing', () => {
      const result = getPathFromToolInput('NotebookEdit', { cell_number: 1 });

      expect(result).toBeNull();
    });
  });

  describe('Glob tool', () => {
    it('should extract path from Glob tool input', () => {
      const result = getPathFromToolInput('Glob', { path: '/search/path' });

      expect(result).toBe('/search/path');
    });

    it('should extract pattern as fallback from Glob tool input', () => {
      const result = getPathFromToolInput('Glob', { pattern: '**/*.ts' });

      expect(result).toBe('**/*.ts');
    });

    it('should fall back to pattern when path is empty', () => {
      const result = getPathFromToolInput('Glob', { path: '', pattern: '**/*.ts' });

      expect(result).toBe('**/*.ts');
    });

    it('should prefer path over pattern', () => {
      const result = getPathFromToolInput('Glob', {
        path: '/explicit/path',
        pattern: '**/*.ts',
      });

      expect(result).toBe('/explicit/path');
    });

    it('should return null when both path and pattern are missing', () => {
      const result = getPathFromToolInput('Glob', {});

      expect(result).toBeNull();
    });
  });

  describe('Grep tool', () => {
    it('should extract path from Grep tool input', () => {
      const result = getPathFromToolInput('Grep', {
        path: '/search/path',
        pattern: 'search-regex',
      });

      expect(result).toBe('/search/path');
    });

    it('should return null when path is missing', () => {
      const result = getPathFromToolInput('Grep', { pattern: 'search-regex' });

      expect(result).toBeNull();
    });

    it('should not use pattern as path fallback', () => {
      // Unlike Glob, Grep's pattern is the search regex, not a path
      const result = getPathFromToolInput('Grep', { pattern: 'search-regex' });

      expect(result).toBeNull();
    });
  });

  describe('LS tool', () => {
    it('should extract path from LS tool input', () => {
      const result = getPathFromToolInput('LS', { path: '/list/path' });

      expect(result).toBe('/list/path');
    });

    it('should return null when path is missing', () => {
      const result = getPathFromToolInput('LS', {});

      expect(result).toBeNull();
    });
  });

  describe('unsupported tools', () => {
    it('should return null for Bash tool', () => {
      const result = getPathFromToolInput('Bash', { command: 'ls -la' });

      expect(result).toBeNull();
    });

    it('should return null for Task tool', () => {
      const result = getPathFromToolInput('Task', { prompt: 'do something' });

      expect(result).toBeNull();
    });

    it('should return null for WebSearch tool', () => {
      const result = getPathFromToolInput('WebSearch', { query: 'search term' });

      expect(result).toBeNull();
    });

    it('should return null for WebFetch tool', () => {
      const result = getPathFromToolInput('WebFetch', { url: 'https://example.com' });

      expect(result).toBeNull();
    });

    it('should return null for unknown tool', () => {
      const result = getPathFromToolInput('UnknownTool', { file_path: '/path' });

      expect(result).toBeNull();
    });

    it('should return null for empty tool name', () => {
      const result = getPathFromToolInput('', { file_path: '/path' });

      expect(result).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('should handle paths with spaces', () => {
      const result = getPathFromToolInput('Read', {
        file_path: '/path/with spaces/file.txt',
      });

      expect(result).toBe('/path/with spaces/file.txt');
    });

    it('should handle Windows-style paths', () => {
      const result = getPathFromToolInput('Write', {
        file_path: 'C:\\Users\\test\\file.txt',
      });

      expect(result).toBe('C:\\Users\\test\\file.txt');
    });

    it('should handle relative paths', () => {
      const result = getPathFromToolInput('Edit', {
        file_path: './relative/path.txt',
      });

      expect(result).toBe('./relative/path.txt');
    });

    it('should handle paths starting with tilde', () => {
      const result = getPathFromToolInput('Read', {
        file_path: '~/Documents/file.txt',
      });

      expect(result).toBe('~/Documents/file.txt');
    });
  });
});
